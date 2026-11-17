import type { LockFile, Plan, TargetId } from './types.ts';

/** 锁 ↔ 计划核对的结论。纯判定：不读文件、不出网、不报 Issue。 */
export type LockConsistencyStatus = 'ok' | 'mismatch' | 'missing' | 'no-plan' | 'no-lock-plan';

export interface LockConsistency {
  status: LockConsistencyStatus;
  /** 锁里这个 target 的 planHash；锁缺失或没有计划快照时为 undefined */
  expected?: string;
  /** 按当前清单重算出的 planHash；算不出计划时为 undefined */
  actual?: string;
  /** 给人看的结论，保留 CLI 既有措辞 */
  message: string;
}

/**
 * 判「锁 ↔ 当前清单」是否一致。
 *
 * 权威快照口径：`lock.plans?.[target]`；老锁只有主计划时，仅当 `lock.plan.target`
 * 就是这个 target 才回落，否则按「锁里没有这个 target 的快照」处理——拿别的主计划
 * 比哈希会得出错误的「一致 / 被改过」结论。`plan` 由调用方按锁的目标重算后传入。
 *
 * 只做判定，放行与否由调用方决定（`--allow-stale-lock` 之类）。
 */
export function checkLockConsistency(
  lock: LockFile | null | undefined,
  target: TargetId,
  plan: Plan | undefined,
): LockConsistency {
  if (!lock) {
    return {
      status: 'missing',
      ...(plan ? { actual: plan.planHash } : {}),
      message: '这个包没有锁，无法核对「装到的东西」和作者锁的是不是同一份',
    };
  }

  // 回落只认同一个 target 的主计划快照：拿别的 target 的快照比哈希是拿错基准
  const snapshot = lock.plans?.[target] ?? (lock.plan?.target === target ? lock.plan : undefined);
  if (!snapshot) {
    const only = lock.plan?.target;
    return {
      status: 'no-lock-plan',
      ...(plan ? { actual: plan.planHash } : {}),
      message: only
        ? `锁里没有 ${target} 的计划快照，只有 ${only} 的（旧版锁），无法核对清单是否被改过`
        : `锁里没有 ${target} 的计划快照（旧版锁），无法核对清单是否被改过`,
    };
  }

  const expected = snapshot.planHash;
  if (!plan) {
    return {
      status: 'no-plan',
      expected,
      message: `按当前清单算不出 ${target} 的计划，无法核对锁（先修清单错误）`,
    };
  }

  const actual = plan.planHash;
  if (expected !== actual) {
    return {
      status: 'mismatch',
      expected,
      actual,
      message: `锁与清单对不上（lock=${expected.slice(0, 20)}… plan=${actual.slice(0, 20)}…）；清单在锁定后被改过，确认来源后加 --allow-stale-lock 才装`,
    };
  }

  return {
    status: 'ok',
    expected,
    actual,
    message: `锁与 ${target} 的计划一致`,
  };
}
