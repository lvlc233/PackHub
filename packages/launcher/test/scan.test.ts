import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { main } from '../src/cli.ts';
import { DEFAULT_SCAN_DEPTH, readManifestIdentity, scanDirectory, type ScanEntry } from '../src/scan.ts';

const PACK_MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/scan-pack
  version: 0.1.0
  targets: [dir, dsh]
resources: []
`;

const FLOW_MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/flow-pack, version: 0.2.0, targets: [dsh] }
resources: []
`;

const INSTANCE = {
  apiVersion: 'packhub.dev/instance/v1',
  id: '20260101000000-0123456789ab',
  name: 'demo-instance',
  harness: 'dsh',
  pack: { name: 'demo/scan-pack', version: '0.1.0' },
  planHash: 'abc',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'installed',
  managed: true,
};

let tmp: string;
let packDir: string;
let envDir: string;
let instanceDir: string;
let brokenDir: string;
let unrelatedDir: string;

function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

function writeJson(file: string, value: unknown): void {
  writeText(file, JSON.stringify(value, null, 2) + '\n');
}

/** 路径比较统一按 / 与大小写不敏感：Windows 上同一目录可能以不同写法出现。 */
function norm(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function findEntry(
  entries: ScanEntry[],
  kind: ScanEntry['kind'],
  dir: string,
): ScanEntry | undefined {
  return entries.find((entry) => entry.kind === kind && norm(entry.dir) === norm(dir));
}

/** 目录树指纹（相对路径 + 大小 + mtime）：只读扫描前后必须完全一致。 */
function fingerprint(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(abs);
      } else if (entry.isFile()) {
        const stat = statSync(abs);
        out.push(`${rel}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-scan-'));

  // 一个 Pack 目录
  packDir = join(tmp, 'pack');
  writeText(join(packDir, 'packhub.yaml'), PACK_MANIFEST);
  writeText(join(packDir, 'rules.md'), '# rules\n');

  // 一个装过 Pack 的环境（state 里两个 pack key）；.packhub 里的装好副本不是候选
  envDir = join(tmp, 'env');
  writeJson(join(envDir, '.packhub', 'state.json'), {
    apiVersion: 'packhub.dev/state/v0',
    packs: {
      'demo/scan-pack@0.1.0': {
        pack: 'demo/scan-pack',
        version: '0.1.0',
        planHash: 'aaa',
        installedAt: '2026-01-01T00:00:00.000Z',
        actions: [],
        written: [],
      },
      'demo/two@0.2.0': {
        pack: 'demo/two',
        version: '0.2.0',
        planHash: 'bbb',
        installedAt: '2026-01-01T00:00:00.000Z',
        actions: [],
        written: [],
      },
    },
  });
  writeText(join(envDir, '.packhub', 'packs', 'installed', 'packhub.yaml'), PACK_MANIFEST);

  // 一个带 instance.json 的实例
  instanceDir = join(tmp, 'instance');
  writeJson(join(instanceDir, 'instance.json'), { ...INSTANCE, root: instanceDir });

  // 一个坏 instance.json
  brokenDir = join(tmp, 'broken');
  writeText(join(brokenDir, 'instance.json'), '{ "id": "x", "name": }\n');

  // 一个无关目录
  unrelatedDir = join(tmp, 'unrelated');
  writeText(join(unrelatedDir, 'notes.txt'), 'nothing here\n');

  // 深度用例：Pack 在第 3 层（tmp 算第 0 层）
  writeText(
    join(tmp, 'deep', 'a', 'b', 'packhub.yaml'),
    PACK_MANIFEST.replace('demo/scan-pack', 'demo/deep-pack'),
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('scan：三类候选', () => {
  it('识别 Pack 目录、环境与实例，无关目录不出现', () => {
    const { entries, root, depth } = scanDirectory(tmp);
    expect(root).toBe(tmp);
    expect(depth).toBe(DEFAULT_SCAN_DEPTH);

    const pack = findEntry(entries, 'pack', packDir);
    expect(pack, 'Pack 目录').toBeTruthy();
    expect(pack?.name).toBe('demo/scan-pack');
    expect(pack?.version).toBe('0.1.0');
    expect(pack?.problem).toBeUndefined();
    expect(norm(pack?.file ?? '')).toBe(norm(join(packDir, 'packhub.yaml')));

    const env = findEntry(entries, 'environment', envDir);
    expect(env, '装过 Pack 的环境').toBeTruthy();
    expect(env?.packs).toBe(2);
    expect(env?.problem).toBeUndefined();
    expect(norm(env?.file ?? '').endsWith('/.packhub/state.json')).toBe(true);

    const instance = findEntry(entries, 'instance', instanceDir);
    expect(instance, '实例').toBeTruthy();
    expect(instance?.name).toBe('demo-instance');
    expect(instance?.harness).toBe('dsh');
    expect(instance?.pack).toEqual({ name: 'demo/scan-pack', version: '0.1.0' });
    expect(instance?.broken).toBeUndefined();

    expect(entries.some((entry) => norm(entry.dir) === norm(unrelatedDir))).toBe(false);
  });

  it('坏 instance.json 标 broken，并说明缺什么', () => {
    const broken = findEntry(scanDirectory(tmp).entries, 'instance', brokenDir);
    expect(broken?.broken).toBe(true);
    expect(broken?.problem).toMatch(/instance\.json/);
    expect(broken?.name).toBeUndefined();

    // 合法 JSON 但缺 id：同样算坏记录，不当成正常实例
    const incomplete = join(tmp, 'incomplete');
    writeJson(join(incomplete, 'instance.json'), { name: 'half' });
    const half = findEntry(scanDirectory(tmp).entries, 'instance', incomplete);
    expect(half?.broken).toBe(true);
    expect(half?.problem).toContain('id');
  });

  it('清单缺 metadata 时仍然列成 Pack，问题写清楚', () => {
    const bare = join(tmp, 'bare-pack');
    writeText(join(bare, 'packhub.yaml'), 'apiVersion: packhub.dev/v0\nkind: Pack\n');
    const entry = findEntry(scanDirectory(tmp).entries, 'pack', bare);
    expect(entry).toBeTruthy();
    expect(entry?.name).toBeUndefined();
    expect(entry?.problem).toContain('metadata.name');
  });

  it('state.json 坏了仍然列成环境，pack 数量按 0 报并标问题', () => {
    const badEnv = join(tmp, 'bad-env');
    writeText(join(badEnv, '.packhub', 'state.json'), '{ broken');
    const entry = findEntry(scanDirectory(tmp).entries, 'environment', badEnv);
    expect(entry).toBeTruthy();
    expect(entry?.packs).toBe(0);
    expect(entry?.problem).toMatch(/不是合法 JSON/);
  });

  it('行内写法的 metadata 也能读 name/version', () => {
    const flowDir = join(tmp, 'flow');
    writeText(join(flowDir, 'packhub.yaml'), FLOW_MANIFEST);
    const flow = findEntry(scanDirectory(tmp).entries, 'pack', flowDir);
    expect(flow?.name).toBe('demo/flow-pack');
    expect(flow?.version).toBe('0.2.0');
    expect(flow?.problem).toBeUndefined();
    expect(readManifestIdentity(FLOW_MANIFEST)).toEqual({ name: 'demo/flow-pack', version: '0.2.0' });
  });
});

describe('scan：深度与范围', () => {
  it('默认深度 2 扫不到第 3 层，depth 3 才扫到；depth 0 只看根', () => {
    const shallow = scanDirectory(tmp);
    expect(findEntry(shallow.entries, 'pack', join(tmp, 'deep', 'a', 'b'))).toBeUndefined();

    const deep = findEntry(
      scanDirectory(tmp, { depth: 3 }).entries,
      'pack',
      join(tmp, 'deep', 'a', 'b'),
    );
    expect(deep?.name).toBe('demo/deep-pack');

    const rootOnly = scanDirectory(tmp, { depth: 0 });
    expect(rootOnly.entries).toHaveLength(0);
    expect(rootOnly.problems).toHaveLength(0);
  });

  it('不进 .packhub 内部：装好的 Pack 副本不算候选', () => {
    const { entries } = scanDirectory(tmp, { depth: 6 });
    for (const entry of entries) {
      expect(norm(entry.dir)).not.toContain('/.packhub/');
    }
  });

  it('路径比较不分大小写与斜杠（Windows 写法也能对上）', () => {
    const entries = scanDirectory(tmp).entries;
    const alt =
      process.platform === 'win32' ? packDir.replace(/\\/g, '/').toUpperCase() : packDir.replace(/\\/g, '/');
    expect(findEntry(entries, 'pack', alt)?.name).toBe('demo/scan-pack');
  });

  it('目录不存在或深度不合法时直接报错', () => {
    expect(() => scanDirectory(join(tmp, 'nope'))).toThrow(/目录不存在/);
    expect(() => scanDirectory(tmp, { depth: -1 })).toThrow(/扫描深度/);
    expect(() => scanDirectory(tmp, { depth: 1.5 })).toThrow(/扫描深度/);
  });
});

describe('scan：只读', () => {
  it('扫描前后目录树（含 mtime）完全不变，且不写任何文件', () => {
    const before = fingerprint(tmp);
    const first = scanDirectory(tmp, { depth: 6 });
    const second = scanDirectory(tmp);
    expect(first.entries.length).toBeGreaterThan(0);
    expect(second.entries.length).toBeGreaterThan(0);
    expect(fingerprint(tmp)).toEqual(before);
  });
});

describe('pal scan CLI', () => {
  interface CommandShape {
    args?: Record<string, { type?: string; default?: unknown } | undefined>;
  }

  const command = (main as unknown as { subCommands?: Record<string, CommandShape | undefined> })
    .subCommands?.['scan'];

  it('挂了 scan 子命令：depth 默认 2，有 --json', () => {
    expect(command, 'scan 应存在').toBeTruthy();
    expect(command?.args?.depth?.default).toBe(String(DEFAULT_SCAN_DEPTH));
    expect(command?.args?.json?.type).toBe('boolean');
    expect(command?.args?.json?.default).toBe(false);
  });
});
