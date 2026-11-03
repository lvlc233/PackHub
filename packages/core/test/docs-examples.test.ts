import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPack, planFor } from '../src/index.ts';

const DOC = fileURLToPath(new URL('../../../docs/authoring.md', import.meta.url));

/** 从文档里抠出所有 yaml 代码块，保证示例不腐烂。 */
function yamlBlocks(): string[] {
  const md = readFileSync(DOC, 'utf8');
  return [...md.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
}

function materialize(manifestYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-doc-'));
  mkdirSync(join(dir, 'resources'), { recursive: true });
  mkdirSync(join(dir, 'fragments'), { recursive: true });
  writeFileSync(join(dir, 'packhub.yaml'), manifestYaml, 'utf8');
  for (const f of ['resources/style-guide.md', 'resources/commit-rules.md', 'resources/rules.md']) {
    writeFileSync(join(dir, f), '# 示例\n', 'utf8');
  }
  writeFileSync(join(dir, 'fragments/agent.yaml'), 'review:\n  strict: true\n', 'utf8');
  return dir;
}

const blocks = yamlBlocks();
const fullManifests = blocks.filter((b) => b.includes('apiVersion:'));
const resourceSnippets = blocks.filter((b) => b.trimStart().startsWith('- id:'));

describe('文档示例', () => {
  it('至少包含最小清单、完整清单与六种资源示例', () => {
    expect(fullManifests.length).toBeGreaterThanOrEqual(2);
    expect(resourceSnippets.length).toBeGreaterThanOrEqual(6);
  });

  it('每个完整清单都能通过 schema 与图校验', () => {
    for (const yaml of fullManifests) {
      const dir = materialize(yaml);
      try {
        const ctx = loadPack(dir);
        const errors = ctx.issues.filter((i) => i.severity === 'error');
        expect(errors, `${yaml.slice(0, 60)}… → ${errors.map((e) => e.message).join('; ')}`).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('每种资源示例单独塞进清单后都能生成计划', () => {
    const types = new Set<string>();
    for (const snippet of resourceSnippets) {
      const yaml = `apiVersion: packhub.dev/v0.0.1
kind: Pack
metadata:
  name: doc/example
  version: 0.0.1
  targets: [dir]
requires:
  packhub: ">=0.0.1 <0.1"
resources:
${snippet
  .split('\n')
  .map((l) => (l.trim() ? '  ' + l : l))
  .join('\n')}
`;
      const dir = materialize(yaml);
      try {
        const ctx = loadPack(dir);
        const errors = ctx.issues.filter((i) => i.severity === 'error');
        expect(errors, `${snippet.slice(0, 40)}… → ${errors.map((e) => e.message).join('; ')}`).toEqual([]);
        const { plan } = planFor(ctx);
        expect(plan?.actions.length ?? 0).toBeGreaterThan(0);
        for (const r of ctx.manifest.resources) types.add(r.type);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    expect([...types].sort()).toEqual(['config', 'knowledge', 'mcp', 'prompt', 'skill', 'tool']);
  });
});
