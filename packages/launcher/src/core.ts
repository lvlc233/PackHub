import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { PalError, errorBody } from './errors.ts';
import { palHome } from './paths.ts';
import { isPidAlive } from './process.ts';
import type { InstanceRecord } from './records.ts';
import { restartInstance, startInstance, stopInstance } from './start.ts';
import { nowIso } from './time.ts';
import { watchOnce, type WatchStats } from './watch.ts';

/**
 * PAL 的常驻核心。
 *
 * 它只做两件事：独占实例进程的启停（谁 spawn，谁拿到退出事件），以及按间隔看护没有退出事件的实例。
 * CLI、界面、桌面壳都只是它的客户端：发命令、读结果；它们退出不影响实例，也不影响看护。
 *
 * 它是单例：抢 `<PAL home>/core.lock`（写 pid），只把 `core.json`（地址 + token）留给客户端发现。
 * 地址是回环 HTTP。为什么不走命名管道：Windows 上命名管道要另一套读法，而这里只需要本机进程之间
 * 说几句 JSON，HTTP 足够，也让「接口可插拔」只剩换 transport 一件事。
 */

export const CORE_FILE = 'core.json';
export const CORE_LOCK = 'core.lock';
export const CORE_LOG = 'core.log';
export const CORE_API_VERSION = 'packhub.dev/pal/core/v1';
/** 看护间隔；core 起手先跑一轮，所以启动即接管。 */
export const DEFAULT_CORE_INTERVAL_MS = 2000;
/** core.log 到这么大就转一份 .1，留一次现场。 */
const CORE_LOG_LIMIT = 2 * 1024 * 1024;

export interface CoreInfo {
  apiVersion: typeof CORE_API_VERSION;
  /** core 自己的进程号：客户端先探它还在不在，再谈连接 */
  pid: number;
  host: string;
  port: number;
  url: string;
  /** 客户端凭据；只落 core.json（用户自己的数据目录） */
  token: string;
  startedAt: string;
  version: string;
  home: string;
}

export function coreFilePath(home: string = palHome()): string {
  return join(home, CORE_FILE);
}

export function coreLockPath(home: string = palHome()): string {
  return join(home, CORE_LOCK);
}

export function coreLogPath(home: string = palHome()): string {
  return join(home, CORE_LOG);
}

/** 读 core.json；坏 JSON、缺字段、pid 不是数字都当没有。 */
export function readCoreInfo(home: string = palHome()): CoreInfo | undefined {
  let data: Partial<CoreInfo>;
  try {
    data = JSON.parse(readFileSync(coreFilePath(home), 'utf8')) as Partial<CoreInfo>;
  } catch {
    return undefined;
  }
  if (typeof data.pid !== 'number' || !Number.isInteger(data.pid) || data.pid <= 0) return undefined;
  if (typeof data.port !== 'number' || !Number.isInteger(data.port) || data.port <= 0) return undefined;
  if (typeof data.host !== 'string' || typeof data.url !== 'string') return undefined;
  if (typeof data.token !== 'string' || data.token.length === 0) return undefined;
  return {
    apiVersion: CORE_API_VERSION,
    pid: data.pid,
    host: data.host,
    port: data.port,
    url: data.url,
    token: data.token,
    startedAt: typeof data.startedAt === 'string' ? data.startedAt : nowIso(),
    version: typeof data.version === 'string' ? data.version : '0.0.0',
    home,
  };
}

function writeCoreInfo(home: string, info: CoreInfo): void {
  mkdirSync(home, { recursive: true });
  const file = coreFilePath(home);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

/** core 的诊断日志：只留最近一份，写不进去不影响 core 本身。 */
export function appendCoreLog(home: string, line: string): void {
  const file = coreLogPath(home);
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > CORE_LOG_LIMIT) renameSync(file, `${file}.1`);
    writeFileSync(file, `${nowIso()} ${line}\n`, { encoding: 'utf8', flag: 'a' });
  } catch {
    /* 日志写不了不是 core 的失败 */
  }
}

interface LockRecord {
  pid: number;
  at: string;
}

function lockHolder(file: string): number | undefined {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockRecord>;
    return typeof data.pid === 'number' ? data.pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 抢 core 的单例锁。`wx` 是一次原子的「文件不存在才建」，两个 core 同时起只会赢一个；
 * 持锁进程已经不在了就当陈旧锁清掉，不让一次崩溃永久挡住 core 启动。
 */
export function acquireCoreLock(home: string = palHome()): number {
  mkdirSync(home, { recursive: true });
  const file = coreLockPath(home);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(file, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }, null, 2) + '\n', 'utf8');
      return fd;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = lockHolder(file);
      if (holder !== undefined && isPidAlive(holder)) {
        throw new PalError('busy', `PAL core 已经在运行（pid ${holder}）`, {
          hint: 'pal core status 看它在哪；要换一个 core 先 pal core stop',
          details: { home, pid: holder },
        });
      }
      rmSync(file, { force: true });
    }
  }
  throw new PalError('busy', 'PAL core 的启动锁抢不到', {
    hint: `删掉 ${coreLockPath(home)}（确认没有 core 在跑）后重试`,
  });
}

export function releaseCoreLock(home: string, fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* 已关 */
  }
  const file = coreLockPath(home);
  if (lockHolder(file) === process.pid) rmSync(file, { force: true });
}

/** 让出锁但别的 core 已经接手时，不删它的锁文件。 */

export interface CoreOps {
  start?: (id: string, params: { port?: number }) => Promise<InstanceRecord>;
  stop?: (id: string, force: boolean) => Promise<InstanceRecord>;
  restart?: (id: string) => Promise<InstanceRecord>;
  watch?: () => Promise<WatchStats>;
}

export interface StartCoreOptions {
  home?: string;
  host?: string;
  port?: number;
  intervalMs?: number;
  /** 测试里关掉后台看护；生产默认开 */
  supervise?: boolean;
  /** 测试注入启停与看护实现；不传就走真实的 start/stop/restart/watch */
  ops?: CoreOps;
  log?: (line: string) => void;
}

export interface PalCore {
  info: CoreInfo;
  url: string;
  token: string;
  /** 跑一轮看护（启动时的那一轮就是接管） */
  watch: () => Promise<WatchStats>;
  close: () => Promise<void>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const MAX_BODY = 1_000_000;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new PalError('invalid-input', '请求太大');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    throw new PalError('invalid-input', '请求体不是合法 JSON');
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value, null, 2));
}

/**
 * 起 core：抢锁 → 监听回环 → 写 core.json（客户端从这里发现它）→ 跑第一轮看护（接管）。
 * 同一个 home 只允许一个；第二个会拿到 busy，由客户端去连已经起来的那个。
 */
export async function startCore(options: StartCoreOptions = {}): Promise<PalCore> {
  const home = options.home ?? palHome();
  const host = options.host ?? '127.0.0.1';
  const intervalMs = options.intervalMs ?? DEFAULT_CORE_INTERVAL_MS;
  const log = options.log ?? ((line: string) => appendCoreLog(home, line));
  const lockFd = acquireCoreLock(home);
  const token = randomBytes(16).toString('hex');
  const startedMs = Date.now();

  const startOp: NonNullable<CoreOps['start']> =
    options.ops?.start ??
    ((id, params) => startInstance(id, { ...(params.port ? { port: params.port } : {}), supervise: true }));
  const stopOp: NonNullable<CoreOps['stop']> =
    options.ops?.stop ?? ((id, force) => stopInstance(id, force ? { force: true } : {}));
  const restartOp: NonNullable<CoreOps['restart']> =
    options.ops?.restart ?? ((id) => restartInstance(id, { supervise: true }));
  const tick = async (): Promise<WatchStats> => {
    if (options.ops?.watch) return options.ops.watch();
    // 轮询重起的实例也放进 core 的事件看护里：下一次崩溃就不必等这一轮
    return watchOnce({ start: (id) => startInstance(id, { supervise: true }), log });
  };

  let closed = false;
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const body = errorBody(err);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, body.status, { ok: false, ...body });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://core');
    if (req.method === 'GET' && url.pathname === '/health') {
      requireToken(req);
      sendJson(res, 200, { ok: true, ...info });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/rpc') {
      requireToken(req);
      const body = await readJson(req);
      const op = String(body.op ?? '');
      const params = (body.params ?? {}) as Record<string, unknown>;
      const handler = rpc[op];
      if (!handler) throw new PalError('invalid-input', `core 不认识这个操作：${op}`, {
        hint: 'CLI 与界面各用各的命令，core 只认 start / stop / restart / watch / status / shutdown',
      });
      sendJson(res, 200, { ok: true, result: await handler(params) });
      return;
    }
    throw new PalError('not-found', 'core 没有这个接口');
  }

  function requireToken(req: IncomingMessage): void {
    const supplied = req.headers['x-pal-token'];
    const text = Array.isArray(supplied) ? supplied[0] : supplied;
    if (typeof text !== 'string' || !sameToken(text.trim(), token)) {
      throw new PalError('forbidden', 'core 的凭据不对', {
        hint: 'core.json 是本机凭据：换过 core 之后要重新读，不要复用旧地址',
      });
    }
  }

  const rpc: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    start: (params) => {
      const port = typeof params.port === 'number' ? params.port : undefined;
      return startOp(String(params.id ?? ''), { ...(port ? { port } : {}) });
    },
    stop: (params) => stopOp(String(params.id ?? ''), params.force === true),
    restart: (params) => restartOp(String(params.id ?? '')),
    watch: () => tick(),
    status: async () => ({
      pid: process.pid,
      startedAt: info.startedAt,
      uptimeMs: Date.now() - startedMs,
      intervalMs,
    }),
    shutdown: async () => {
      // 先把答复送出去，再收自己；客户端不因为连接被掐而把「已停」当成失败
      setTimeout(() => {
        void shutdown('rpc');
      }, 20);
      return { stopping: true };
    },
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  const info: CoreInfo = {
    apiVersion: CORE_API_VERSION,
    pid: process.pid,
    host,
    port,
    url: `http://${host}:${port}/`,
    token,
    startedAt: nowIso(),
    version: pkg.version,
    home,
  };
  writeCoreInfo(home, info);
  log(`core 起来：pid ${process.pid}，${info.url}，home ${home}`);

  const controller = new AbortController();
  const loop: Promise<void> =
    options.supervise === false
      ? Promise.resolve()
      : (async (): Promise<void> => {
          while (!controller.signal.aborted) {
            try {
              const stats = await tick();
              if (stats.restarted > 0 || stats.broken > 0) {
                log(
                  `看护：检查 ${stats.checked} 条，重起 ${stats.restarted}，标 broken ${stats.broken}，跳过 ${stats.skipped}`,
                );
              }
            } catch (err) {
              log(`看护这一轮失败（继续）：${errorText(err)}`);
            }
            if (controller.signal.aborted) break;
            await sleep(intervalMs, controller.signal);
          }
        })();

  async function shutdown(reason: string): Promise<void> {
    if (closed) return finished;
    closed = true;
    controller.abort();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await loop.catch(() => {});
    const current = readCoreInfo(home);
    if (current?.pid === process.pid) rmSync(coreFilePath(home), { force: true });
    releaseCoreLock(home, lockFd);
    log(`core 退出（${reason}）`);
    finish();
    return finished;
  }

  return {
    info,
    url: info.url,
    token,
    watch: () => tick(),
    close: () => shutdown('close'),
  };
}
