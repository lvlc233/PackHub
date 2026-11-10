import { scanInstances } from './catalog.ts';
import { withInstanceLock } from './lock.ts';
import { appendEvent } from './logs.ts';
import { isPidAlive } from './process.ts';
import { readRecord, type InstanceRecord } from './records.ts';
import { writeInstance } from './recordWrite.ts';
import { isSupervisedPid, startInstance } from './start.ts';
import { isStopping } from './stopMark.ts';
import { nowIso } from './time.ts';

/**
 * 轮询看护：不依赖子进程句柄，只扫 `scanInstances()`（坏记录只略过，不隔离），
 * 对「记录说 running、pid 其实已经死了」的实例：
 *  - restart='on-failure' 且还有重起预算 → startInstance 重起，并补写 lastExit.restarts+1；
 *  - 否则 → 写 broken、清掉 pid/port/url。
 *
 * 由 core 按间隔调用。它管的是「没人拿到退出事件」的那批：接管来的实例、core 上次退出前起的实例。
 * 已经被 core 按退出事件看护的 pid（isSupervisedPid）、正在被 stop 的实例一概跳过——
 * 同一个实例只能有一个监督者，否则两边各重起一次就是双实例。
 */

export interface WatchStats {
  /** 这一轮扫到的记录数（坏记录不在 records 里，不计） */
  checked: number;
  /** 成功调用 startInstance 重起的数 */
  restarted: number;
  /** 写成 broken 的数（预算用完、restart=never、重起失败） */
  broken: number;
  /** 不需要动或动不了的数（活着、已停、安装中、无 pid、锁被占、已有监督者等） */
  skipped: number;
}

export interface WatchOptions {
  /** 探活函数；测试可注入。默认 process.ts 的 isPidAlive。 */
  isAlive?: (pid: number) => boolean;
  /** 重起函数；测试可注入。默认 start.ts 的 startInstance。只给实例 id。 */
  start?: (id: string) => Promise<unknown>;
  /** 诊断日志；默认 console.error。单条失败只打日志，不中断整轮。 */
  log?: (line: string) => void;
}

type Outcome = 'restarted' | 'broken' | 'skipped';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyExit(): NonNullable<InstanceRecord['lastExit']> {
  return { code: null, signal: null, at: nowIso(), restarts: 0 };
}

/**
 * 这条记录该不该由轮询动：只碰「running、有 pid、pid 已死、没人按事件看护、也不在停止中」。
 * 其余只算 skipped，绝不覆盖别人的状态。
 */
function reapable(rec: InstanceRecord, isAlive: (pid: number) => boolean): boolean {
  if (rec.status !== 'running' || typeof rec.pid !== 'number') return false;
  if (isSupervisedPid(rec.pid)) return false;
  if (isStopping(rec.root, rec.pid)) return false;
  return !isAlive(rec.pid);
}

/**
 * 处理一条「记录说 running、pid 已死」的候选。进了锁之后还要再核一次：
 * 已被别的进程改掉（不再是 running、pid 变了、其实还活着、刚被 stop）就按 skipped 返回。
 */
async function reapDead(
  rec: InstanceRecord,
  isAlive: (pid: number) => boolean,
  start: (id: string) => Promise<unknown>,
  log: (line: string) => void,
): Promise<Outcome> {
  return withInstanceLock(rec.root, 'watch', async (): Promise<Outcome> => {
    const current = readRecord(rec.root);
    if (!current || !reapable(current, isAlive)) return 'skipped';

    const restarts = current.lastExit?.restarts ?? 0;
    const maxRestarts = current.maxRestarts ?? 3;
    if (current.restart === 'on-failure' && restarts < maxRestarts) {
      const id = current.id;
      const oldPid = current.pid;
      try {
        await start(id);
      } catch (err) {
        // 重起也算用掉一次预算：否则起不来会每 2s 无限重试。
        const failed = readRecord(rec.root) ?? current;
        const next: InstanceRecord = {
          ...failed,
          status: 'broken',
          lastExit: { ...(current.lastExit ?? emptyExit()), restarts: restarts + 1 },
        };
        delete next.pid;
        delete next.port;
        delete next.url;
        writeInstance(next);
        appendEvent(rec.root, {
          event: 'watch-restart-failed',
          id,
          pid: oldPid,
          restarts: restarts + 1,
          message: errorText(err),
        });
        log(`看护：${current.name} 重起失败，已标 broken（第 ${restarts + 1} 次）：${errorText(err)}`);
        return 'broken';
      }

      // startInstance 已经写好 running/pid/port/url；这里只补上这次重起的计数来源。
      const fresh = readRecord(rec.root) ?? current;
      writeInstance({
        ...fresh,
        lastExit: { ...(current.lastExit ?? emptyExit()), restarts: restarts + 1 },
      });
      appendEvent(rec.root, {
        event: 'watch-restart',
        id,
        pid: oldPid,
        newPid: fresh.pid,
        restarts: restarts + 1,
      });
      return 'restarted';
    }

    const next: InstanceRecord = {
      ...current,
      status: 'broken',
      lastExit: current.lastExit ?? emptyExit(),
    };
    delete next.pid;
    delete next.port;
    delete next.url;
    writeInstance(next);
    appendEvent(rec.root, {
      event: 'watch-exit',
      id: current.id,
      pid: current.pid,
      restarts,
      reason: current.restart === 'on-failure' ? 'restart-budget-exhausted' : 'restart-never',
    });
    return 'broken';
  });
}

/** 只跑一轮看护，返回这一轮的分类统计。 */
export async function watchOnce(opts: WatchOptions = {}): Promise<WatchStats> {
  const isAlive = opts.isAlive ?? isPidAlive;
  const start = opts.start ?? ((id: string) => startInstance(id));
  const log = opts.log ?? ((line: string) => console.error(line));
  const stats: WatchStats = { checked: 0, restarted: 0, broken: 0, skipped: 0 };

  for (const rec of scanInstances().records) {
    stats.checked += 1;
    // 已经被 core 按退出事件看护 / 正在被 stop / 活着 / 不是 running / 没有 pid：完全不碰。
    if (!reapable(rec, isAlive)) {
      stats.skipped += 1;
      continue;
    }
    try {
      stats[await reapDead(rec, isAlive, start, log)] += 1;
    } catch (err) {
      // 锁被占、写记录失败等都只影响这一条，不中断整轮。
      stats.skipped += 1;
      log(`看护：跳过 ${rec.name || rec.id}：${errorText(err)}`);
    }
  }
  return stats;
}
