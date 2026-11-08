import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 「正在停止」标记只靠磁盘上的文件，不 import index/start：
 * `pal stop` 与看护进程（`pal serve`）可能是两个进程，内存里的 Set 跨不过去。
 */
export const STOPPING_MARK = '.pal-stopping';
/** 标记有效期：正常 stop 最多等 10s；60s 足够覆盖一次异常的停止过程，又不会长时间压掉真实崩溃。 */
const STOPPING_TTL_MS = 60_000;

export interface StopMark {
  pid: number;
  at: string;
}

/** 标记文件路径（诊断/测试用）。 */
export function stoppingMarkFile(root: string): string {
  return join(root, STOPPING_MARK);
}

/**
 * 在 kill 之前落盘。写不进去也不挡住停止：最坏退化成原来的「退出即崩溃」行为，
 * 不能因为标记写不了就让用户停不掉实例。
 */
export function markStopping(root: string, pid: number): void {
  const mark: StopMark = { pid, at: new Date().toISOString() };
  try {
    writeFileSync(stoppingMarkFile(root), JSON.stringify(mark, null, 2) + '\n', 'utf8');
  } catch {
    /* 见上 */
  }
}

export function clearStopping(root: string): void {
  try {
    rmSync(stoppingMarkFile(root), { force: true });
  } catch {
    /* 删不掉也不影响停止本身 */
  }
}

/** 这次退出是不是我们自己停的：只认同一 pid、未过期的标记。 */
export function isStopping(root: string, pid?: number, now = Date.now()): boolean {
  const file = stoppingMarkFile(root);
  if (!existsSync(file)) return false;
  let mark: Partial<StopMark>;
  try {
    mark = JSON.parse(readFileSync(file, 'utf8')) as Partial<StopMark>;
  } catch {
    return false;
  }
  if (typeof mark?.pid !== 'number') return false;
  if (pid !== undefined && mark.pid !== pid) return false;
  const at = Date.parse(String(mark.at ?? ''));
  return Number.isFinite(at) && now - at <= STOPPING_TTL_MS;
}
