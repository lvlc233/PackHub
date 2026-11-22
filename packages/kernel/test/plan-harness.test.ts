import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor } from '../src/index.ts';

const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/harness, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`;

function pack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-plan-harness-'));
  writeFileSync(join(dir, 'packhub.yaml'), MANIFEST, 'utf8');
  writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
  return dir;
}

const pathsOf = (plan: { actions: { op: string }[] }): string[] =>
  plan.actions.map((a) => {
    const record = a as { to?: string; file?: string };
    return record.to ?? record.file ?? a.op;
  });

describe('计划里的安装形态：可选 harness', () => {
  it('不写 harness = 平铺目录：计划里没有 harness 字段，产物都在 .packhub 下', () => {
    const dir = pack();
    const { plan } = planFor(loadPack(dir));
    expect(plan).toBeDefined();
    // 平铺目录不是「其中一个 harness 值」：字段根本不该出现
    expect(plan).not.toHaveProperty('harness');
    expect(pathsOf(plan!)).toEqual(['.packhub/knowledge/rules.md']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('harness: dsh 写进计划，落点跟着宿主走：多出一条 AGENTS.md 指令动作', () => {
    const dir = pack();
    const { plan } = planFor(loadPack(dir), { harness: 'dsh' });
    expect(plan).toBeDefined();
    expect(plan!.harness).toBe('dsh');
    expect(plan!.actions.map((a) => a.op)).toEqual(['write', 'instruction']);
    expect(pathsOf(plan!)).toEqual(['.packhub/knowledge/rules.md', 'AGENTS.md']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('旧的 dir 值不再是宿主：按 unknown-target 报错，不静默当平铺', () => {
    const dir = pack();
    // 运行期可能把字符串传进来；类型上已收窄，这里强制模拟旧调用方
    const { plan, issues } = planFor(loadPack(dir), { harness: 'dir' as never });
    expect(plan).toBeUndefined();
    expect(issues.map((i) => i.code)).toContain('unknown-target');
    expect(issues[0]!.message).toContain('未知宿主：dir');
    rmSync(dir, { recursive: true, force: true });
  });
});
