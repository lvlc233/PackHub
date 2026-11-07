import { spawnSync } from 'node:child_process';

/** 进程存活判断：只探一次，异常一律当“不在了”。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但没权限发信号；其余（ESRCH）当不存在
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 结束进程树：Windows 要连子进程一起收，POSIX 用进程组。 */
export function killTree(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已经退出 */
    }
  }
}

export interface WaitExitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  isAlive?: (pid: number) => boolean;
}

/** 等进程真正退出（被 taskkill 收掉也要等），超时返回 false。 */
export async function waitForExit(
  pid: number,
  opts: WaitExitOptions = {},
): Promise<boolean> {
  const isAlive = opts.isAlive ?? isPidAlive;
  const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
  const interval = opts.intervalMs ?? 50;
  for (;;) {
    if (!isAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export interface ProcInfo {
  pid?: number;
  name?: string;
  raw?: string;
}

/** 查一个 pid 的进程名；查不到返回 undefined。 */
export function processName(pid: number): string | undefined {
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
      });
      const first = (res.stdout ?? '').split(/\r?\n/).find(Boolean);
      const name = first?.split('","')[0]?.replace(/^"/, '').trim();
      return name || undefined;
    }
    const res = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5_000 });
    return (res.stdout ?? '').trim() || undefined;
  } catch {
    return undefined;
  }
}
