import { scanInstances } from './catalog.ts';
import { withInstanceLock } from './lock.ts';
import { appendEvent } from './logs.ts';
import { isPidAlive } from './process.ts';
import { readRecord, type InstanceRecord } from './records.ts';
import { writeInstance } from './recordWrite.ts';
import { startInstance } from './start.ts';
import { nowIso } from './time.ts';

/**
 * headless 看护：不依赖 `pal serve` 的进程内 supervisor。
 * 只扫 `scanInstances()`（坏记录只略过，不隔离），对「记录说 running、pid 其实已经死了」的实例：
 *  - restart='on-failure' 且还有重起预算 → startInstance 重起，watch 补写 lastExit.restarts+1；
 *  - 否则 → 写 broken、清掉 pid/port/url。
 * 记录写入统一走 writeInstance + withInstanceLock（同进程重入时 owned=false，不会死锁）。
 * 重起逻辑本身不复制：只调用 startInstance，让它照常写 pid/port/url/status。
 */

export const DEFAULT_WATCH_INTERVAL_MS = 2000;

export interface WatchStats {
  /** 这一轮扫到的记录数（坏记录不在 records 里，不计） */
  checked: number;
  /** 成功调用 startInstance 重起的数 */
  restarted: number;
  /** 写成 broken 的数（预算用完、restart=never、重起失败） */
  broken: number;
  /** 不需要动或动不了的数（活着、已停、安装中、无 pid、锁被占等） */
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

export interface WatchLoopOptions extends WatchOptions {
  /** 每轮间隔毫秒，默认 DEFAULT_WATCH_INTERVAL_MS */
  intervalMs?: number;
  /** 停止信号；不传时 watchLoop 自己接 SIGINT（Ctrl+C 后正常返回，退出码 0） */
  signal?: AbortSignal;
  /** 每轮结束回调；测试和 CLI 用它打统计或中途 abort */
  onRound?: (stats: WatchStats) => void;
}

type Outcome = 'restarted' | 'broken' | 'skipped';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyExit(): NonNullable<InstanceRecord['lastExit']> {
  return { code: null, signal: null, at: nowIso(), restarts: 0 };
}

/**
 * 处理一条「记录说 running、pid 已死」的候选。已被别的进程改掉（不再是 running、pid 变了、
 * 其实还活着）就按 skipped 返回，不覆盖别人的状态。
 */
async function reapDead(
  rec: InstanceRecord,
  opts: WatchOptions,
  isAlive: (pid: number) => boolean,
  start: (id: string) => Promise<unknown>,
  log: (line: string) => void,
): Promise<Outcome> {
  return withInstanceLock(rec.root, 'watch', async (): Promise<Outcome> => {
    const current = readRecord(rec.root);
    if (
      !current ||
      current.id !== rec.id ||
      current.status !== 'running' ||
      typeof current.pid !== 'number' ||
      isAlive(current.pid)
    ) {
      return 'skipped';
    }

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
    // 只动「running 且 pid 已死」；其余（活着 / stopped / installing / 没有 pid）完全不碰。
    if (rec.status !== 'running' || typeof rec.pid !== 'number' || isAlive(rec.pid)) {
      stats.skipped += 1;
      continue;
    }
    try {
      stats[await reapDead(rec, opts, isAlive, start, log)] += 1;
    } catch (err) {
      // 锁被占、写记录失败等都只影响这一条，不中断整轮。
      stats.skipped += 1;
      log(`看护：跳过 ${rec.name || rec.id}：${errorText(err)}`);
    }
  }
  return stats;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(1, ms));
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * 定时跑 watchOnce，直到 signal 中止（或 Ctrl+C）；错误只打日志，不退出循环。
 * 返回整个循环累计的统计（每轮相加）。
 */
export async function watchLoop(opts: WatchLoopOptions = {}): Promise<WatchStats> {
  const intervalMs = opts.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const log = opts.log ?? ((line: string) => console.error(line));
  // 没给 signal 就自己接 SIGINT：Ctrl+C 之后当前这一轮结束、循环正常返回。
  const controller = opts.signal ? undefined : new AbortController();
  const signal = opts.signal ?? controller!.signal;
  const onSigint = (): void => controller?.abort();
  if (controller) process.once('SIGINT', onSigint);

  const total: WatchStats = { checked: 0, restarted: 0, broken: 0, skipped: 0 };
  try {
    while (!signal.aborted) {
      try {
        const round = await watchOnce(opts);
        total.checked += round.checked;
        total.restarted += round.restarted;
        total.broken += round.broken;
        total.skipped += round.skipped;
        opts.onRound?.(round);
      } catch (err) {
        log(`看护这一轮失败（继续下一轮）：${errorText(err)}`);
      }
      if (signal.aborted) break;
      await sleep(intervalMs, signal);
    }
  } finally {
    if (controller) process.removeListener('SIGINT', onSigint);
  }
  return total;
}
