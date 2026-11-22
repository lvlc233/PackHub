import type { LockFile, Manifest } from './types.ts';
import { contentHashOf } from './lock.ts';

/** 锁 ↔ 清单核对的结论。纯判定：不读文件、不出网、不报 Issue。 */
export type LockConsistencyStatus = 'ok' | 'mismatch' | 'missing';

export interface LockConsistency {
  status: LockConsistencyStatus;
  /** 锁里记的 contentHash；没有锁时为 undefined */
  expected?: string;
  /** 按当前清单 + 锁的 resolved 重算出的 contentHash；没有锁时为 undefined */
  actual?: string;
  /** 给人看的结论，保留 CLI 既有措辞 */
  message: string;
}

/** 日志里只露哈希头，不整串打印。 */
function short(hash: unknown): string {
  return String(hash ?? '—').slice(0, 20);
}

/**
 * 判「锁 ↔ 当前清单」是否一致。
 *
 * 锁只描述内容（清单 + resolved），所以判据就是重算 contentHash：与装到哪个宿主无关，
 * 也不存在「锁里没有这个宿主的计划快照」这种状态——计划由安装期按宿主现算。
 * 锁没有 contentHash 就是无效锁，按 mismatch 报，提示重跑 lock；不做旧形状特判。
 *
 * 只做判定，放行与否由调用方决定（`--allow-stale-lock` 之类）。
 */
export function checkLockConsistency(
  lock: LockFile | null | undefined,
  manifest: Manifest,
): LockConsistency {
  if (!lock) {
    return {
      status: 'missing',
      message: '这个包没有锁，无法核对「装到的东西」和作者锁的是不是同一份',
    };
  }

  const actual = contentHashOf(manifest, lock.resolved);
  const stored: string | undefined = lock.contentHash;
  if (stored === undefined) {
    return {
      status: 'mismatch',
      actual,
      message: `锁没有 contentHash（不是 packhub.dev/lock/v0 的当前形状）；重跑 packhub lock`,
    };
  }
  if (stored !== actual) {
    return {
      status: 'mismatch',
      expected: stored,
      actual,
      message: `锁与清单对不上（lock=${short(stored)}… content=${short(actual)}…）；清单在锁定后被改过，确认来源后加 --allow-stale-lock 才装`,
    };
  }

  return {
    status: 'ok',
    expected: stored,
    actual,
    message: '锁与清单一致',
  };
}
