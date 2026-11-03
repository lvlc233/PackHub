import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLock, diffActions, loadPack, planFor } from '../src/index.ts';
import type { PlanAction } from '../src/index.ts';

const EXAMPLE = fileURLToPath(new URL('../../../examples/team-conventions/', import.meta.url));

const action = (over: Record<string, unknown>): PlanAction =>
  ({ actionId: 'x#1', ...over }) as unknown as PlanAction;

describe('diffActions', () => {
  it('按内容比较：actionId 变了不算差异', () => {
    const a = action({ op: 'write', to: 'a.md', from: './a.md' });
    const b = { ...a, actionId: 'write#9' } as PlanAction;
    expect(diffActions([a], [b])).toEqual({ added: [], removed: [] });
  });

  it('换绑时 id 相同、内容不同，能看出新增与移除', () => {
    const before = [action({ op: 'fetch', uri: 'npm:tts-a@1.0.0', dest: 'cache/a' })];
    const after = [action({ op: 'fetch', uri: 'npm:tts-b@0.4.0', dest: 'cache/b' })];
    const { added, removed } = diffActions(before, after);
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(1);
    expect((removed[0] as { uri: string }).uri).toContain('tts-a');
    expect((added[0] as { uri: string }).uri).toContain('tts-b');
  });
});

describe('lock 里的计划快照', () => {
  it('包含动作、校验与被排除的候选', () => {
    const ctx = loadPack(EXAMPLE);
    const { plan } = planFor(ctx);
    const lock = buildLock(ctx.manifest, plan!);
    expect(lock.plan?.actions).toHaveLength(plan!.actions.length);
    expect(lock.plan?.excluded).toEqual([]);
    expect(lock.planHash).toBe(plan!.planHash);
  });

  it('锁能序列化回来（写文件后读回不丢字段）', () => {
    const ctx = loadPack(EXAMPLE);
    const { plan } = planFor(ctx);
    const lock = buildLock(ctx.manifest, plan!);
    const roundtrip = JSON.parse(JSON.stringify(lock)) as typeof lock;
    expect(roundtrip.plan?.actions).toHaveLength(plan!.actions.length);
    expect(roundtrip.planHash).toBe(plan!.planHash);
  });
});
