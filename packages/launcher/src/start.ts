import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADAPTERS, parseStartUrl } from './layout.ts';
import { listInstances, readInstance, writeInstance, type InstanceRecord } from './index.ts';

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 结束进程树：Windows 要连子进程一起收，POSIX 用进程组。 */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
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

export interface StartOptions {
  timeoutMs?: number;
  spawn?: typeof nodeSpawn;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
}

function quote(token: string): string {
  return /[\s"]/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token;
}

/**
 * 起一个实例：按宿主的入口拉起进程，cwd=实例根，home 用实例自己的那一段。
 * 启动输出重定向到实例的 logs/start.log，从日志里等地址；等不到就收掉进程。
 */
export async function startInstance(
  idOrName: string,
  opts: StartOptions = {},
): Promise<InstanceRecord> {
  const rec = readInstance(idOrName);
  if (!rec) throw new Error(`没有这个实例：${idOrName}`);
  const adapter = ADAPTERS[rec.harness];
  if (!adapter.start) throw new Error(`${rec.harness} 还没有启动入口（这一版只起了 dsh）`);

  const alive = opts.isAlive ?? isPidAlive;
  if (rec.pid && alive(rec.pid)) throw new Error(`实例已在运行：pid ${rec.pid}`);

  if (rec.home) mkdirSync(rec.home, { recursive: true });
  const logDir = join(rec.root, 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'start.log');

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (adapter.homeEnv && rec.home) env[adapter.homeEnv] = rec.home;

  const line = [adapter.start.command, ...adapter.start.args].map(quote).join(' ');
  const shellLine = `${line} > "${logFile}" 2>&1`;
  const spawnFn = opts.spawn ?? nodeSpawn;
  const child = spawnFn(shellLine, [], {
    cwd: rec.root,
    env,
    shell: true,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  child.unref();

  const started = await waitForLog(logFile, rec.harness, opts.timeoutMs ?? 20_000);
  if (!started) {
    if (child.pid) (opts.kill ?? killTree)(child.pid);
    throw new Error(`启动后没等到地址；日志：${logFile}`);
  }

  const next: InstanceRecord = {
    ...rec,
    status: 'running',
    ...(child.pid ? { pid: child.pid } : {}),
    ...(started.port ? { port: started.port } : {}),
    url: started.url,
  };
  writeInstance(next);
  return next;
}

async function waitForLog(
  logFile: string,
  harness: InstanceRecord['harness'],
  timeoutMs: number,
): Promise<{ url: string; port?: number } | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const hit = parseStartUrl(readFileSync(logFile, 'utf8'), harness);
      if (hit) return hit;
    } catch {
      /* 日志还没出现 */
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export interface StopOptions {
  kill?: (pid: number) => void;
}

export function stopInstance(idOrName: string, opts: StopOptions = {}): InstanceRecord {
  const rec = readInstance(idOrName);
  if (!rec) throw new Error(`没有这个实例：${idOrName}`);
  if (!rec.pid) throw new Error(`实例没有在运行：${rec.name}`);
  (opts.kill ?? killTree)(rec.pid);
  const { pid: _pid, port: _port, url: _url, ...rest } = rec;
  const next: InstanceRecord = { ...rest, status: 'stopped' };
  writeInstance(next);
  return next;
}

/** 进程已经不在了的实例标成 broken；其余原样返回。 */
export function refreshStatuses(isAlive: (pid: number) => boolean = isPidAlive): InstanceRecord[] {
  return listInstances().map((rec) => {
    if (rec.pid && !isAlive(rec.pid)) {
      const { pid: _pid, port: _port, url: _url, ...rest } = rec;
      const next: InstanceRecord = { ...rest, status: 'broken' };
      writeInstance(next);
      return next;
    }
    return rec;
  });
}
