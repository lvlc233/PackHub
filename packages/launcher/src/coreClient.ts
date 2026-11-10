import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { readCoreInfo, type CoreInfo } from './core.ts';
import { PalError, type PalErrorCode } from './errors.ts';
import { palHome } from './paths.ts';
import { isPidAlive } from './process.ts';

/**
 * core 的客户端：发现、按需拉起、发命令。
 *
 * CLI、`pal serve`、桌面壳都走这里。客户端不持有实例句柄——所以它随时可以退出、重开，
 * 实例与看护不受影响。
 */

export interface CoreClientOptions {
  home?: string;
  /** 测试注入；默认 node:child_process 的 spawn */
  spawn?: (file: string, args: string[], options: Record<string, unknown>) => ChildProcess;
  /** 等 core 起来的上限；默认 15s */
  waitMs?: number;
  /** 单次 RPC 的超时；默认 30s（安装/启动可能慢，这一层只防挂死） */
  timeoutMs?: number;
  /** 探活超时；默认 1s */
  probeMs?: number;
  env?: NodeJS.ProcessEnv;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * core 活着吗：pid 还在 + /health 用 core.json 里的 token 答 ok。
 * 只读 core.json，不拉起——拉起是 ensureCore 的事。
 */
export async function probeCore(options: CoreClientOptions = {}): Promise<CoreInfo | undefined> {
  const info = readCoreInfo(options.home ?? palHome());
  if (!info || !isPidAlive(info.pid)) return undefined;
  try {
    const res = await fetch(new URL('health', info.url), {
      headers: { 'x-pal-token': info.token },
      signal: AbortSignal.timeout(options.probeMs ?? 1000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { ok?: unknown; pid?: unknown };
    return body?.ok === true && body.pid === info.pid ? info : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 拉起 core：同一条命令行（node + 当前入口 + core run），脱离本进程。
 * 它自己抢锁；抢不到说明别人已经起了，客户端只要等 /health 通。
 */
export function spawnCore(home: string, options: CoreClientOptions = {}): ChildProcess {
  const entry = process.argv[1];
  if (!entry) {
    throw new PalError('core-unavailable', '找不到 PAL 的入口，起不了 core', {
      hint: '从 pal 命令或打包后的 pal.cjs 启动；直接 node 调用时要把入口路径给它',
    });
  }
  const spawnFn = options.spawn ?? (nodeSpawn as unknown as (file: string, args: string[], opts: Record<string, unknown>) => ChildProcess);
  const child = spawnFn(process.execPath, [...process.execArgv, entry, 'core', 'run'], {
    cwd: process.cwd(),
    env: { ...process.env, PACKHUB_HOME: home, ...(options.env ?? {}) },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref?.();
  return child;
}

/** 有就返回，没有就拉起一个；拉起失败（或超时）报 core-unavailable。 */
export async function ensureCore(options: CoreClientOptions = {}): Promise<CoreInfo> {
  const found = await probeCore(options);
  if (found) return found;

  const home = options.home ?? palHome();
  let child: ChildProcess | undefined;
  try {
    child = spawnCore(home, options);
  } catch (err) {
    if (err instanceof PalError) throw err;
    throw new PalError('core-unavailable', `起不了 PAL core：${(err as Error).message}`, {
      cause: err,
      details: { home },
    });
  }

  const deadline = Date.now() + (options.waitMs ?? 15_000);
  while (Date.now() < deadline) {
    const info = await probeCore({ ...options, home });
    if (info) return info;
    await sleep(120);
  }
  throw new PalError('core-unavailable', 'PAL core 没有起来', {
    hint: `看 ${join(home, 'core.log')}；也可以在终端跑 pal core run 看它为什么退`,
    details: { home, exitCode: child.exitCode },
  });
}

interface RpcReply {
  ok?: boolean;
  result?: unknown;
  error?: string;
  code?: string;
  hint?: string;
  details?: Record<string, unknown>;
}

async function rpc<T>(info: CoreInfo, op: string, params: Record<string, unknown>, options: CoreClientOptions): Promise<T> {
  let res: Response;
  try {
    res = await fetch(new URL('rpc', info.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pal-token': info.token },
      body: JSON.stringify({ op, params }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw new PalError('core-unavailable', `连不上 PAL core（${info.url}）`, {
      hint: 'core 可能刚崩或刚被停；再执行一次会按需拉起',
      details: { pid: info.pid },
      cause: err,
    });
  }

  let body: RpcReply;
  try {
    body = (await res.json()) as RpcReply;
  } catch {
    throw new PalError('core-unavailable', `PAL core 的回答读不了（HTTP ${res.status}）`, {
      details: { url: info.url },
    });
  }
  if (!res.ok || body.ok !== true) {
    throw new PalError((body.code ?? 'internal') as PalErrorCode, body.error ?? 'core 调用失败', {
      ...(body.hint ? { hint: body.hint } : {}),
      ...(body.details ? { details: body.details } : {}),
    });
  }
  return body.result as T;
}

/**
 * 向 core 发一条命令。core 不在就拉起来；调用中途 core 没了（正好被杀）就再拉一次、重试一次。
 * 这样「杀 core」之后的下一条命令既能把 core 拉回来，也不会把这次操作丢在半路。
 */
export async function coreCall<T>(
  op: string,
  params: Record<string, unknown> = {},
  options: CoreClientOptions = {},
): Promise<T> {
  const info = await ensureCore(options);
  try {
    return await rpc<T>(info, op, params, options);
  } catch (err) {
    if (!(err instanceof PalError) || err.code !== 'core-unavailable') throw err;
    const again = await ensureCore(options);
    return rpc<T>(again, op, params, options);
  }
}

/** 关掉 core（只停监督者；实例进程不动，下一次命令会重新拉起 core 接管它们）。 */
export async function stopCore(options: CoreClientOptions = {}): Promise<void> {
  await coreCall('shutdown', {}, options);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await probeCore(options))) return;
    await sleep(100);
  }
  throw new PalError('busy', 'PAL core 没有按命令退出', {
    hint: '可能卡在一条正在执行的操作上；看 core.log，或结束 core.json 里记的 pid',
  });
}
