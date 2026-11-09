import { scanInstances } from './catalog.ts';
import { isPidAlive } from './process.ts';
import type { InstanceRecord } from './records.ts';

/**
 * 只读并发账本：扫实例记录，算「当前哪些实例在跑、占哪些端口」。
 * 只依赖 catalog.ts（读记录）与 process.ts（探 pid），外加可注入的时钟：
 * 不写记录、不杀进程、不隔离坏记录。坏记录与 pid 已死的记录只按现状列出。
 */

export interface PsInstance {
  id: string;
  name: string;
  harness: string;
  status: InstanceRecord['status'];
  pid: number | null;
  port: number | null;
  url: string | null;
  startedAt: string | null;
  /** 从 startedAt 到 now 的毫秒数；startedAt 缺失或读不了时为 null */
  uptimeMs: number | null;
  /** 人类可读的运行时长；未知时是「未知」 */
  uptime: string;
  /** pid 已经不在了。只标出来，记录本身不动（ps 不写盘） */
  stale: boolean;
}

/** 同一 port 被多条记录占用。 */
export interface PortConflict {
  port: number;
  ids: string[];
  names: string[];
}

export interface PsTotal {
  /** 账本条目数：status='running' 或带 pid 的记录，含标了 stale 的 */
  instances: number;
  /** 其中 pid 还活着、真正在跑的数量 */
  running: number;
  /** 不重复的端口数 */
  ports: number;
  stale: number;
  conflicts: number;
}

export interface PsReport {
  instances: PsInstance[];
  conflicts: PortConflict[];
  total: PsTotal;
  /** 读不了的记录：只列出，不隔离（隔离是写操作） */
  broken: Array<{ dir: string; reason: string }>;
}

export interface PsOptions {
  /** 探活函数；测试可注入。默认 process.ts 的 isPidAlive。 */
  isAlive?: (pid: number) => boolean;
  /** 算运行时长的「现在」；默认 Date.now()。 */
  now?: number | Date;
}

/** 毫秒 → 简短时长：45s / 3m 20s / 2h 5m / 1d 3h。 */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function uptimeOf(startedAt: string | undefined, now: number): Pick<PsInstance, 'uptimeMs' | 'uptime'> {
  if (!startedAt) return { uptimeMs: null, uptime: '未知' };
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return { uptimeMs: null, uptime: '未知' };
  const uptimeMs = Math.max(0, now - started);
  return { uptimeMs, uptime: formatUptime(uptimeMs) };
}

/**
 * 生成一份只读账本：列出 status='running' 或带 pid 的记录，标端口冲突与 stale。
 * 不调用 listInstances / refreshStatuses：两者都会写记录；这里只用 scanInstances 的纯读结果。
 */
export function psReport(opts: PsOptions = {}): PsReport {
  const isAlive = opts.isAlive ?? isPidAlive;
  const now = opts.now instanceof Date ? opts.now.getTime() : (opts.now ?? Date.now());
  const scan = scanInstances();
  const selected = scan.records.filter(
    (rec) => rec.status === 'running' || typeof rec.pid === 'number',
  );

  const instances: PsInstance[] = selected.map((rec) => {
    const pid = typeof rec.pid === 'number' ? rec.pid : null;
    const stale = pid !== null && !isAlive(pid);
    return {
      id: rec.id,
      name: rec.name,
      harness: rec.harness,
      status: rec.status,
      pid,
      port: typeof rec.port === 'number' ? rec.port : null,
      url: rec.url ?? null,
      startedAt: rec.startedAt ?? null,
      ...uptimeOf(rec.startedAt, now),
      stale,
    };
  });

  const byPort = new Map<number, PsInstance[]>();
  for (const item of instances) {
    if (item.port === null) continue;
    const owners = byPort.get(item.port) ?? [];
    owners.push(item);
    byPort.set(item.port, owners);
  }
  const conflicts: PortConflict[] = [...byPort.entries()]
    .filter(([, owners]) => owners.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([port, owners]) => ({
      port,
      ids: owners.map((owner) => owner.id),
      names: owners.map((owner) => owner.name),
    }));

  const stale = instances.filter((item) => item.stale).length;
  return {
    instances,
    conflicts,
    total: {
      instances: instances.length,
      running: instances.length - stale,
      ports: byPort.size,
      stale,
      conflicts: conflicts.length,
    },
    broken: scan.broken.map(({ dir, reason }) => ({ dir, reason })),
  };
}
