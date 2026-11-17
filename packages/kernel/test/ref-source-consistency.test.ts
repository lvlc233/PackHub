import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { parseSource } from '../src/index.ts';

/**
 * 来源语法写在两处：`schema/packhub.v0.schema.json` 的 `resource.source.pattern`，
 * 以及 kernel 的 `parseSource`。这个测试把两处绑在一起：
 * 每个样本必须被两边同时收或同时拒；只改一边（比如给 ref.ts 加回 `../`、
 * 或让 schema 放过 `http:foo`、`npm:`）会在这里炸。
 * 最后一例再拿仓库里现成的清单核一遍：收紧语法不能把已经发出去的来源挡在门外。
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCHEMA_PATH = join(ROOT, 'schema/packhub.v0.schema.json');

const PATTERN = new RegExp(
  (
    JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
      definitions: { resource: { properties: { source: { pattern: string } } } };
    }
  ).definitions.resource.properties.source.pattern,
);

/** 能过校验的来源 */
const ACCEPTED = [
  './a',
  './',
  'npm:x@1',
  'npm:@scope/pkg@1.2.3',
  'pypi:x@1',
  'github:a/b@c',
  'github:owner/repo@v1',
  'github:owner/repo/skills/x@v1',
  'https://x/y',
  'http://x/y',
];

/** 过不了校验的来源：未知协议、裸名字、前缀残缺 */
const REJECTED = [
  '../a',
  'ftp://x',
  'bare-name',
  'npm:',
  'pypi:',
  'github:owner',
  'github:owner/',
  'http:foo',
  'https:x',
  'https://',
];

function accepts(raw: string): boolean {
  try {
    parseSource(raw);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(raw: string): string {
  try {
    parseSource(raw);
  } catch (err) {
    return (err as Error).message;
  }
  return '';
}

/** 仓库里随包走、会被校验的清单。 */
function packManifests(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('packhub.yaml'))
    .map((entry) => join(dir, entry));
}

const REPO_MANIFESTS = [
  ...packManifests(join(ROOT, 'examples')),
  ...packManifests(join(ROOT, 'registry')),
];

describe('resource.source 语法一致性（ref.ts ↔ schema pattern）', () => {
  it('schema pattern 对样本集的判定符合预期', () => {
    for (const raw of ACCEPTED) expect(PATTERN.test(raw), `schema 应接受 ${raw}`).toBe(true);
    for (const raw of REJECTED) expect(PATTERN.test(raw), `schema 应拒绝 ${raw}`).toBe(false);
  });

  it('parseSource 与 schema pattern 对每个样本的接受/拒绝完全一致', () => {
    for (const raw of [...ACCEPTED, ...REJECTED]) {
      const fromSchema = PATTERN.test(raw);
      expect(accepts(raw), `parseSource 与 pattern 对 ${raw} 不一致（pattern ${fromSchema ? '收' : '拒'}）`).toBe(
        fromSchema,
      );
    }
  });

  it('../ 按无法识别报错，文案的支持列表只列真正接受的形态', () => {
    expect(() => parseSource('../a')).toThrow(/无法识别的 source：\.\.\/a/);
    const supported = /支持的形态：([^）]*)）/.exec(errorMessage('../a'))?.[1] ?? '';
    expect(supported.split(/\s+/)).toContain('./');
    expect(supported).toContain('https://');
    expect(supported).not.toContain('../');
  });

  it('examples/ 与 registry/ 里现有清单的来源都仍被 schema 与 parseSource 接受', () => {
    expect(REPO_MANIFESTS.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of REPO_MANIFESTS) {
      const manifest = parseYaml(readFileSync(file, 'utf8')) as {
        resources?: { id?: string; source?: string }[];
      };
      for (const res of manifest.resources ?? []) {
        if (typeof res.source !== 'string') continue;
        const where = `${file.replace(ROOT, '')} ${res.id ?? '?'}`;
        if (!PATTERN.test(res.source)) offenders.push(`${where}: schema 拒 ${res.source}`);
        if (!accepts(res.source)) offenders.push(`${where}: parseSource 拒 ${res.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
