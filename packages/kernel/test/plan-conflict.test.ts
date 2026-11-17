import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadPack, planFor } from '../src/index.ts';

function pack(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-conflict-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

const HEAD = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/conflict, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
`;

describe('计划内的产出冲突（路径从 PLAN_OPS 派生）', () => {
  it('两条 fetch 落到同一路径算 output-conflict', () => {
    const integrity = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const dir = pack({
      'packhub.yaml': `${HEAD}resources:
  - id: doc-a
    type: knowledge
    source: https://x.test/docs/same.md
    integrity: ${integrity}
  - id: doc-b
    type: knowledge
    source: https://x.test/docs/same.md
    integrity: ${integrity}
`,
    });
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    const conflict = issues.find((i) => i.code === 'output-conflict');
    // fetch 的落点算产出：两个资源的 dest 都是 .packhub/knowledge/same.md
    expect(conflict?.message).toContain('.packhub/knowledge/same.md');
    rmSync(dir, { recursive: true, force: true });
  });

  it('两个 MCP 登记到同一个配置文件不按整文件判冲突（键不同就是合法的）', () => {
    const dir = pack({
      'packhub.yaml': `${HEAD}resources:
  - id: tts-a
    type: mcp
    transport: stdio
    source: npm:tts-a@1.2.0
  - id: tts-b
    type: mcp
    transport: stdio
    source: npm:tts-b@0.4.0
`,
    });
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeDefined();
    expect(issues.some((i) => i.code === 'output-conflict')).toBe(false);
    expect(issues.some((i) => i.code === 'duplicate-mcp-server')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('两条 write 落到同一个配置文件仍算 output-conflict（只有按 key 合并的 op 才豁免）', () => {
    const dir = pack({
      'packhub.yaml': `${HEAD}resources:
  - id: cfg-a
    type: config
    source: ./a/dup.toml
  - id: cfg-b
    type: config
    source: ./b/dup.toml
`,
      'a/dup.toml': 'app = "a"\n',
      'b/dup.toml': 'app = "b"\n',
    });
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    expect(
      issues.some(
        (i) => i.code === 'output-conflict' && i.message.includes('.packhub/config/dup.toml'),
      ),
    ).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['retain 不一致', '    retain: remove\n', 'retain 不一致'],
    ['retain 一致', '', '同一目录只能挂一个 id'],
  ])('同目录两个 state id：%s 也报 duplicate-state-path', (_case, extra, expected) => {
    const dir = pack({
      'packhub.yaml': `${HEAD}resources:
  - id: cfg
    type: config
    source: ./cfg.yaml
state:
  - id: memory
    path: .packhub/state/memory
  - id: memory-two
    path: .packhub/state/memory
${extra}`,
      'cfg.yaml': 'app:\n  flavor: a\n',
    });
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    const dup = issues.find((i) => i.code === 'duplicate-state-path');
    expect(dup?.severity).toBe('error');
    expect(dup?.message).toContain('.packhub/state/memory');
    expect(dup?.message).toContain('state:memory');
    expect(dup?.message).toContain('state:memory-two');
    expect(dup?.message).toContain(expected);
    // 目录声明不进文件冲突集合：这里只报 state 层的重复，不报 output-conflict
    expect(issues.some((i) => i.code === 'output-conflict')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('state.dir 指向不同目录不报 duplicate-state-path', () => {
    const dir = pack({
      'packhub.yaml': `${HEAD}resources:
  - id: cfg
    type: config
    source: ./cfg.yaml
state:
  - id: memory
    path: .packhub/state/memory
  - id: cache
    path: .packhub/state/cache
    retain: remove
`,
      'cfg.yaml': 'app:\n  flavor: a\n',
    });
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeDefined();
    expect(issues.some((i) => i.code === 'duplicate-state-path')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
