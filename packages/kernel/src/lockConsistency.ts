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
 * 权威快照口径：`lock.plans?.[target] ?? lock.plan`（多 target 锁按目标取；
 * 老锁只有主计划时回落到它）。`plan` 由调用方按锁的目标重算后传入，
 * 这样安装 target 与锁记录的 target 不同时也不会拿错基准。
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

  const snapshot = lock.plans?.[target] ?? lock.plan;
  if (!snapshot) {
    return {
      status: 'no-lock-plan',
      ...(plan ? { actual: plan.planHash } : {}),
      message: `锁里没有 ${target} 的计划快照（旧版锁），无法核对清单是否被改过`,
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
