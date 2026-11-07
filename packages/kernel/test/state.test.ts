import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor } from '../src/index.ts';

function pack(extra: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-state-'));
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/state, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: cfg
    type: config
    source: ./cfg.yaml
${extra}`,
    'utf8',
  );
  writeFileSync(join(dir, 'cfg.yaml'), 'app:\n  flavor: a\n', 'utf8');
  return dir;
}

describe('持久状态目录（state 块）', () => {
  it('默认路径、retain 与 ${state.x} 插值都进计划', () => {
    const dir = pack(`state:
  - id: memory
    description: 长期记忆
  - id: cache
    path: .packhub/state/cache
    retain: remove
`);
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const plan = planFor(ctx).plan!;

    const dirs = plan.actions.filter((a) => a.op === 'state.dir');
    expect(dirs).toEqual([
      expect.objectContaining({ to: '.packhub/state/memory', retain: 'keep' }),
      expect.objectContaining({ to: '.packhub/state/cache', retain: 'remove' }),
    ]);
    // 目录动作排在资源之前：后面的动作可以直接用这个目录
    expect(plan.actions[0]!.op).toBe('state.dir');
    rmSync(dir, { recursive: true, force: true });
  });

  it('路径可以用 ${target.root}，但绝对路径与 .. 被拒', () => {
    const okDir = pack(`state:
  - id: memory
    path: \${target.root}/state/custom
`);
    const ok = planFor(loadPack(okDir)).plan!;
    expect(ok.actions.find((a) => a.op === 'state.dir')).toMatchObject({
      to: '.packhub/state/custom',
    });
    rmSync(okDir, { recursive: true, force: true });

    for (const bad of ['../outside', 'C:/tmp/x', '/abs', '.']) {
      const badDir = pack(`state:
  - id: memory
    path: "${bad}"
`);
      const { plan, issues } = planFor(loadPack(badDir));
      expect(plan).toBeUndefined();
      expect(issues.some((i) => i.code === 'bad-state-path')).toBe(true);
      rmSync(badDir, { recursive: true, force: true });
    }
  });

  it('重复 id 报错；不同 id 指向同一路径也报错', () => {
    const dupId = pack(`state:
  - id: memory
  - id: memory
    path: .packhub/state/other
`);
    const first = planFor(loadPack(dupId));
    expect(first.plan).toBeUndefined();
    expect(first.issues.some((i) => i.code === 'duplicate-state-id')).toBe(true);
    rmSync(dupId, { recursive: true, force: true });

    const dupPath = pack(`state:
  - id: memory
  - id: memory-two
    path: .packhub/state/memory
`);
    const second = planFor(loadPack(dupPath));
    expect(second.plan).toBeUndefined();
    expect(second.issues.some((i) => i.code === 'output-conflict')).toBe(true);
    rmSync(dupPath, { recursive: true, force: true });
  });
});
