import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor } from '../src/index.ts';

/**
 * 六种资源各一份最小示例，塞进清单后必须能过 schema、出计划。
 * 示例放在测试里而不是文档里：文档可以删、可以改，这些形状是内核自己要守住的。
 */
const SNIPPETS: Record<string, string> = {
  mcp: `
- id: repo-search
  type: mcp
  source: npm:@modelcontextprotocol/server-everything@0.6.2
  transport: stdio
  config:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-everything@0.6.2"]
  provides: [tool:repo_search]
`,
  skill: `
- id: review-rules
  type: skill
  source: github:lvlc233/skill-hub/skills/code-review@9f2c1ab7d4e5f60718293a4b5c6d7e8f90123456
  provides: [skill:code_review]
`,
  prompt: `
- id: commit-rules
  type: prompt
  source: ./resources/rules.md
`,
  knowledge: `
- id: house-style
  type: knowledge
  source: https://raw.githubusercontent.com/lvlc233/PackHub/533147315257260f9054947f1ece2ba20588bc93/README.md
  integrity: sha256-CtMPyOdCbw/DtVRSFoKxJ4FbnhiPq2f92mvzzF5MR5Q=
`,
  config: `
- id: agent-config
  type: config
  source: ./fragments/agent.yaml
`,
  tool2: `
- id: link-kit
  type: tool2
  source: ./tools/link-kit
  commands:
    - name: link-kit
      exec: index.mjs
      runtime: node
      usage: link-kit <dir>
`,
};

function manifestWith(resources: string): string {
  return `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: test/example
  version: 0.0.1
  targets: [dir]
resources:${resources}
`;
}

function materialize(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-resource-'));
  mkdirSync(join(dir, 'resources'), { recursive: true });
  mkdirSync(join(dir, 'fragments'), { recursive: true });
  writeFileSync(join(dir, 'packhub.yaml'), yaml, 'utf8');
  writeFileSync(join(dir, 'resources/rules.md'), '# 示例\n', 'utf8');
  writeFileSync(join(dir, 'fragments/agent.yaml'), 'review:\n  strict: true\n', 'utf8');
  return dir;
}

describe('资源类型示例', () => {
  it('六种类型各有一份示例', () => {
    expect(Object.keys(SNIPPETS).sort()).toEqual(['config', 'knowledge', 'mcp', 'prompt', 'skill', 'tool2']);
  });

  for (const [type, snippet] of Object.entries(SNIPPETS)) {
    it(`${type} 示例能通过校验并生成动作`, () => {
      const dir = materialize(manifestWith(snippet));
      try {
        const ctx = loadPack(dir);
        const errors = ctx.issues.filter((i) => i.severity === 'error');
        expect(errors, errors.map((e) => e.message).join('; ')).toEqual([]);
        const { plan } = planFor(ctx);
        expect(plan?.actions.length ?? 0).toBeGreaterThan(0);
        expect(ctx.manifest.resources.map((r) => r.type)).toEqual([type]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
