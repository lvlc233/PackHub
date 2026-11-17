import { describe, expect, it } from 'vitest';
import type { LockFile, Plan, PlanSnapshot, TargetId } from '../src/index.ts';
import { checkLockConsistency } from '../src/index.ts';

function plan(hash: string, target: TargetId = 'dir'): Plan {
  return {
    apiVersion: 'packhub.dev/plan/v0',
    pack: { name: 'demo/consistency', version: '0.0.1' },
    target,
    actions: [],
    verify: [],
    excluded: [],
    planHash: hash,
  };
}

function snapshot(hash: string, target: TargetId = 'dir'): PlanSnapshot {
  return { target, planHash: hash, actions: [], verify: [], excluded: [] };
}

function lock(props: { plan?: PlanSnapshot; plans?: Partial<Record<TargetId, PlanSnapshot>>; mainHash?: string } = {}): LockFile {
  return {
    apiVersion: 'packhub.dev/lock/v0',
    pack: 'demo/consistency@0.0.1',
    resolved: [],
    planHash: props.mainHash ?? props.plan?.planHash ?? 'sha256-your-own',
    generatedBy: 'packhub/0.0.1',
    ...(props.plan ? { plan: props.plan } : {}),
    ...(props.plans ? { plans: props.plans } : {}),
  };
}

const H1 = 'sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=';
const H2 = 'sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=';

interface Case {
  name: string;
  lock: LockFile | null | undefined;
  target: TargetId;
  plan: Plan | undefined;
  status: 'ok' | 'mismatch' | 'missing' | 'no-plan' | 'no-lock-plan';
  expected?: string;
  actual?: string;
  message: string;
}

const CASES: Case[] = [
  {
    name: '没有锁（undefined）',
    lock: undefined,
    target: 'dir',
    plan: plan(H1),
    status: 'missing',
    actual: H1,
    message: '这个包没有锁',
  },
  {
    name: '没有锁（null 也算没有）',
    lock: null,
    target: 'dir',
    plan: plan(H1),
    status: 'missing',
    actual: H1,
    message: '无法核对',
  },
  {
    name: '锁的计划快照与当前计划一致',
    lock: lock({ plan: snapshot(H1) }),
    target: 'dir',
    plan: plan(H1),
    status: 'ok',
    expected: H1,
    actual: H1,
    message: '一致',
  },
  {
    name: '清单在锁定后被改过',
    lock: lock({ plan: snapshot(H1) }),
    target: 'dir',
    plan: plan(H2),
    status: 'mismatch',
    expected: H1,
    actual: H2,
    message: '清单在锁定后被改过，确认来源后加 --allow-stale-lock 才装',
  },
  {
    name: '旧锁没有计划快照，无法核对',
    lock: lock({ mainHash: H1 }),
    target: 'dir',
    plan: plan(H2),
    status: 'no-lock-plan',
    actual: H2,
    message: '锁里没有 dir 的计划快照',
  },
  {
    name: '多 target 锁优先用 plans[target]，不用主计划',
    lock: lock({ plan: snapshot(H1, 'dir'), plans: { dir: snapshot(H1, 'dir'), dsh: snapshot(H2, 'dsh') } }),
    target: 'dsh',
    plan: plan(H2, 'dsh'),
    status: 'ok',
    expected: H2,
    actual: H2,
    message: '一致',
  },
  {
    name: '旧锁只有 dir 主计划，核 dsh 不拿它当基准',
    lock: lock({ plan: snapshot(H1, 'dir') }),
    target: 'dsh',
    plan: plan(H1, 'dsh'),
    status: 'no-lock-plan',
    actual: H1,
    message: '锁里没有 dsh 的计划快照，只有 dir 的',
  },
  {
    name: '锁有计划快照但当前清单算不出计划',
    lock: lock({ plan: snapshot(H1) }),
    target: 'dir',
    plan: undefined,
    status: 'no-plan',
    expected: H1,
    message: '算不出 dir 的计划',
  },
  {
    name: 'plans[target] 命中但算不出计划',
    lock: lock({ plans: { dsh: snapshot(H2, 'dsh') } }),
    target: 'dsh',
    plan: undefined,
    status: 'no-plan',
    expected: H2,
    message: '算不出 dsh 的计划',
  },
];

describe('锁 ↔ 计划一致性（纯判定）', () => {
  it.each(CASES)('$name', (c) => {
    const result = checkLockConsistency(c.lock, c.target, c.plan);
    expect(result.status).toBe(c.status);
    if (c.expected === undefined) expect(result.expected).toBeUndefined();
    else expect(result.expected).toBe(c.expected);
    if (c.actual === undefined) expect(result.actual).toBeUndefined();
    else expect(result.actual).toBe(c.actual);
    expect(result.message).toContain(c.message);
  });

  it('回落失败时只说「锁里没有这个 target 的快照」，不说清单被改过', () => {
    const result = checkLockConsistency(
      lock({ plan: snapshot(H1, 'dir') }),
      'dsh',
      plan(H1, 'dsh'),
    );
    expect(result.status).toBe('no-lock-plan');
    expect(result.message).toContain('只有 dir 的');
    expect(result.message).not.toContain('清单在锁定后被改过');
    expect(result.message).not.toContain('--allow-stale-lock');
  });

  it('只有同一 target 的主计划才回落，哈希对不上照样判 mismatch', () => {
    const result = checkLockConsistency(lock({ plan: snapshot(H1, 'dir') }), 'dir', plan(H2, 'dir'));
    expect(result.status).toBe('mismatch');
    expect(result.expected).toBe(H1);
    expect(result.actual).toBe(H2);
  });
});
