import { spawnSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';

/** 端口占用者：报错时带上它，比只说“端口被占”有用。 */
export interface PortOwner {
  pid?: number;
  name?: string;
  raw?: string;
}

function listenProbe(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    const done = (free: boolean): void => {
      server.removeAllListeners();
      resolve(free);
    };
    server.once('error', () => done(false));
    server.listen(port, host, () => {
      server.close(() => done(true));
    });
  });
}

/** 让系统挑一个空闲端口。 */
export function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return listenProbe(port, host);
}

/** 端口上有没有人在听（用于体检，不占端口）。 */
export function isPortListening(port: number, host = '127.0.0.1', timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const finish = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** 查占用者：Windows 用 netstat+tasklist，POSIX 用 lsof/ss。查不到返回 undefined。 */
export function portOwner(port: number): PortOwner | undefined {
  try {
    if (process.platform === 'win32') {
      const netstat = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
      });
      const line = (netstat.stdout ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.startsWith('TCP') && new RegExp(`[:.]${port}\\s`).test(l) && /LISTENING/i.test(l));
      if (!line) return undefined;
      const pid = Number(line.split(/\s+/).pop());
      if (!Number.isFinite(pid) || pid <= 0) return { raw: line };
      const task = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
      });
      const first = (task.stdout ?? '').split(/\r?\n/).find(Boolean);
      const name = first?.split('","')[0]?.replace(/^"/, '');
      return { pid, ...(name ? { name } : {}), raw: line };
    }
    const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const line = (lsof.stdout ?? '').split(/\r?\n/).filter(Boolean)[1];
    if (!line) return undefined;
    const parts = line.split(/\s+/);
    const pid = Number(parts[1]);
    return {
      ...(Number.isFinite(pid) ? { pid } : {}),
      ...(parts[0] ? { name: parts[0] } : {}),
      raw: line.trim(),
    };
  } catch {
    return undefined;
  }
}

/** 端口被占时给一句能直接行动的话。 */
export function describePortConflict(port: number, owner?: PortOwner): string {
  const who = owner
    ? `${owner.name ?? '未知进程'}${owner.pid ? `（pid ${owner.pid}）` : ''}`
    : '查不到占用者';
  return `端口 ${port} 已被 ${who} 占用`;
}
