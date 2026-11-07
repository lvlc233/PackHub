import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ADAPTERS, parseStartUrl } from './layout.ts';
import { listInstances, readInstance, requireInstance, writeInstance, nowIso, type InstanceRecord } from './index.ts';
import { PalError } from './errors.ts';
import { discoverHarness, requireHarnessBinary, whichSync } from './harness.ts';
import { appendEvent, closeLog, openLog, tailLog } from './logs.ts';
import {
  describePortConflict,
  findFreePort,
  isPortFree,
  isPortListening,
  portOwner,
} from './port.ts';
import { clearSecrets, splitUrl, writeSecrets } from './secrets.ts';
import { isPidAlive, killTree, waitForExit } from './process.ts';
import { writeDshMcpPatch } from './mcp.ts';

export { isPidAlive, killTree } from './process.ts';

export type SpawnFn = (
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: 'ignore' | Array<'ignore' | number>;
    detached?: boolean;
    windowsHide?: boolean;
    windowsVerbatimArguments?: boolean;
  },
) => { pid?: number; unref?: () => void; once?: (event: string, cb: (...args: never[]) => void) => void };

/** cmd.exe 垫片要的引号：带空格/&|<> 的参数包起来，内部引号转义。 */
function cmdQuote(token: string): string {
  if (!/[\s"&|<>^]/.test(token)) return token;
  return `"${token.replace(/"/g, '\\"')}"`;
}

export interface SpawnPlan {
  file: string;
  args: string[];
  verbatim: boolean;
}

/**
 * 把「命令 + 参数」变成一次真实 spawn。
 * 不拼 shell 字符串：只有 Windows 的 .cmd/.bat 垫片必须过 cmd.exe（它不是可执行文件）。
 */
export function spawnPlanFor(commandPath: string, args: string[]): SpawnPlan {
  const ext = process.platform === 'win32' ? extname(commandPath).toLowerCase() : '';
  if (ext === '.cmd' || ext === '.bat') {
    // cmd /s /c 会剥掉最外层引号，所以整条命令要再包一层，否则带空格的路径会被截断
    const inner = [cmdQuote(commandPath), ...args.map(cmdQuote)].join(' ');
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${inner}"`],
      verbatim: true,
    };
  }
  if (ext === '.ps1') {
    return {
      file: process.env.PAL_POWERSHELL ?? 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', commandPath, ...args],
      verbatim: false,
    };
  }
  return { file: commandPath, args, verbatim: false };
}

export interface StartOptions {
  timeoutMs?: number;
  /** 指定端口；不写就用上次的端口（还空着）或让系统挑 */
  port?: number;
  spawn?: SpawnFn;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
  /** 起完后挂守护：进程崩了就按退避重起（只有长生命周期进程该用） */
  supervise?: boolean;
  /** 查监听进程 pid 的方式；测试里可以给假实现 */
  ownerOf?: (port: number) => number | undefined;
  /** 就绪探测间隔（测试用） */
  pollMs?: number;
}

export interface StartResult {
  record: InstanceRecord;
  logFile: string;
  /** 启动输出里等到的原始地址（含凭据），只给调用方看，不落记录 */
  url: string;
}

const STOP_TIMEOUT_MS = 10_000;

function aliveOf(opts: StartOptions): (pid: number) => boolean {
  return opts.isAlive ?? isPidAlive;
}

/**
 * 起一个实例：按宿主的入口拉起进程，cwd=实例根，home 用实例自己的那一段。
 * 启动输出直接写实例的 logs/start.log（轮转 + 打码），从日志里等地址；
 * 等不到就收掉进程，并把日志尾部贴进错误里。
 */
export async function startInstance(
  idOrName: string,
  opts: StartOptions = {},
): Promise<InstanceRecord> {
  const result = await startInstanceDetailed(idOrName, opts);
  return result.record;
}

export async function startInstanceDetailed(
  idOrName: string,
  opts: StartOptions = {},
): Promise<StartResult> {
  const rec = requireInstance(idOrName);
  const adapter = ADAPTERS[rec.harness];
  if (!adapter.start) {
    throw new PalError('not-startable', `${adapter.label} 没有可启动的常驻服务`, {
      hint: adapter.noStartReason ?? '这个宿主只支持装配 home，PAL 不托管它的进程',
      details: { harness: rec.harness },
    });
  }
  const alive = aliveOf(opts);
  if (rec.pid && alive(rec.pid)) {
    throw new PalError('already-running', `实例已在运行：pid ${rec.pid}`, {
      hint: rec.url ? `已经在这个地址上：${rec.url}` : '要重起就先 pal stop',
      details: { pid: rec.pid, port: rec.port },
    });
  }

  // 启动前自愈：上一轮留下的 pid 已经不在了，先把它标成异常，别拿旧端口当活的
  if (rec.pid && !alive(rec.pid)) {
    appendEvent(rec.root, { event: 'stale-pid', pid: rec.pid });
    const healed = { ...rec, status: 'broken' as const };
    delete healed.pid;
    delete healed.port;
    delete healed.url;
    writeInstance(healed);
  }

  const info = requireHarnessBinary(rec.harness);
  const commandPath = info.commandPath ?? whichSync(adapter.executable ?? rec.harness);
  if (!commandPath) {
    throw new PalError('harness-missing', `找不到 ${adapter.executable ?? rec.harness} 命令`, {
      hint: `装它，或用 PAL_${rec.harness.toUpperCase().replace(/-/g, '_')}_BIN 指定路径`,
    });
  }

  // 端口：显式指定时被占要报占用者；否则沿用上次端口，再不行让系统挑
  let port: number;
  if (opts.port !== undefined) {
    const free = await isPortFree(opts.port);
    if (!free) {
      const owner = portOwner(opts.port);
      throw new PalError('port-in-use', describePortConflict(opts.port, owner), {
        hint: '换一个端口，或先结束占用者',
        details: { port: opts.port, owner },
      });
    }
    port = opts.port;
  } else if (rec.port && (await isPortFree(rec.port))) {
    port = rec.port;
  } else {
    port = await findFreePort();
  }

  if (rec.home) mkdirSync(rec.home, { recursive: true });
  mkdirSync(join(rec.root, 'logs'), { recursive: true });

  // dsh 的 MCP 接线：Pack 里的 mcp 资源写成 --patch 层，随启动生效
  let patchFile: string | undefined;
  if (rec.harness === 'dsh' && rec.home) {
    try {
      const patch = writeDshMcpPatch(rec.root, rec.home);
      if (patch.servers > 0) patchFile = patch.file;
    } catch (err) {
      appendEvent(rec.root, { event: 'mcp-patch-failed', message: (err as Error).message });
    }
  }

  const args = adapter.start.args({
    port,
    root: rec.root,
    ...(rec.home ? { home: rec.home } : {}),
    ...(patchFile ? { patchFile } : {}),
  });
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (adapter.homeEnv && rec.home) env[adapter.homeEnv] = rec.home;

  const log = openLog(rec.root);
  const plan = spawnPlanFor(commandPath, args);
  const spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  appendEvent(rec.root, { event: 'start', harness: rec.harness, port, command: commandPath, args });

  let child: ReturnType<SpawnFn>;
  try {
    child = spawnFn(plan.file, plan.args, {
      cwd: rec.root,
      env,
      stdio: ['ignore', log.fd, log.fd],
      detached: true,
      windowsHide: true,
      ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (err) {
    closeLog(log.fd);
    throw new PalError('start-failed', `起不了 ${commandPath}：${(err as Error).message}`, {
      hint: `检查这个路径是否可执行；日志：${log.file}`,
      cause: err,
    });
  }

  const spawnPid = child.pid;
  const exited = trackExit(child);
  // 起完就该放手：CLI 不因为宿主还活着而挂着；看护交给 pal serve
  child.unref?.();

  const timeoutMs = opts.timeoutMs ?? adapter.start.readyTimeoutMs ?? 20_000;
  const ready = await waitForReady(log.file, rec, timeoutMs, exited, opts.pollMs ?? 100);
  closeLog(log.fd);

  if (!ready.ok) {
    if (spawnPid) (opts.kill ?? killTree)(spawnPid);
    const tail = tailLog(rec.root, 20);
    const why = ready.exited
      ? `宿主退出（code ${ready.exited.code ?? '-'}，signal ${ready.exited.signal ?? '-'}）`
      : `等地址超时（${Math.round(timeoutMs / 1000)}s）`;
    writeInstance({
      ...readInstance(rec.id)!,
      status: 'broken',
      lastExit: { code: ready.exited?.code ?? null, signal: ready.exited?.signal ?? null, at: nowIso(), restarts: 0 },
      lastError: { code: 'start-failed', message: why, at: nowIso() },
    });
    throw new PalError('start-failed', `${rec.name} 起不来：${why}`, {
      hint: tail ? `日志尾部：\n${tail}` : `日志：${log.file}`,
      details: { logFile: log.file, exitCode: ready.exited?.code ?? null },
    });
  }

  // pid 要记真正在监听的进程（Windows 上 .cmd 垫片会让 spawn 的 pid 是 cmd 的）
  const listenPort = ready.port ?? port;
  const ownerPid = opts.ownerOf ? opts.ownerOf(listenPort) : portOwner(listenPort)?.pid;
  const pid = ownerPid ?? spawnPid;
  const split = splitUrl(ready.url);
  writeSecrets(rec.root, split.secrets);

  const current = readInstance(rec.id)!;
  const next: InstanceRecord = {
    ...current,
    status: 'running',
    ...(pid ? { pid } : {}),
    port: ready.port ?? port,
    ports: [...new Set([...(current.ports ?? []), ready.port ?? port])].slice(-5),
    url: split.url,
    startedAt: nowIso(),
    harnessVersion: info.version ?? current.harnessVersion,
  };
  delete next.lastError;
  writeInstance(next);
  appendEvent(rec.root, { event: 'ready', pid, port: next.port, url: split.url });

  if (opts.supervise) attachSupervisor(next, exited);
  return { record: readInstance(rec.id)!, logFile: log.file, url: ready.url };
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: string;
}

interface ExitTracker {
  /** 已经退出时拿到退出信息；还在跑返回 undefined */
  peek: () => ExitInfo | undefined;
  wait: (timeoutMs: number) => Promise<ExitInfo | undefined>;
}

function trackExit(child: ReturnType<SpawnFn>): ExitTracker {
  let exit: ExitInfo | undefined;
  child.once?.('exit', ((code: number | null, signal: NodeJS.Signals | null) => {
    exit = { code, signal: signal ?? null, at: nowIso() };
  }) as never);
  return {
    peek: () => exit,
    wait: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (!exit && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return exit;
    },
  };
}

async function waitForReady(
  logFile: string,
  rec: InstanceRecord,
  timeoutMs: number,
  exited: ExitTracker,
  pollMs: number,
): Promise<{ ok: true; url: string; port?: number } | { ok: false; exited?: ExitInfo }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dead = exited.peek();
    if (dead) return { ok: false, exited: dead };
    try {
      const hit = parseStartUrl(readFileSync(logFile, 'utf8'), rec.harness);
      if (hit) return { ok: true, url: hit.url, ...(hit.port ? { port: hit.port } : {}) };
    } catch {
      /* 日志还没出现 */
    }
    if (Date.now() >= deadline) return { ok: false };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/* ---------- 守护 ---------- */

/**
 * 进程退出就把结果写进记录（退出码、信号），on-failure 的实例按退避重起。
 * 只有活在同一个进程里的 PAL（pal serve）能看护；CLI 起完就退出，状态靠下次刷新。
 */
export function attachSupervisor(record: InstanceRecord, tracker: ExitTracker): void {
  void tracker.wait(24 * 60 * 60 * 1000).then(async (info) => {
    if (!info) return;
    await onExit(record, info);
  });
}

async function onExit(record: InstanceRecord, info: ExitInfo): Promise<void> {
  const current = readInstance(record.id);
  if (!current) return;
  const restarts = (current.lastExit?.restarts ?? 0) + 1;
  appendEvent(current.root, { event: 'exit', code: info.code, signal: info.signal, restarts });
  const crashed = { ...current, status: 'broken' as const, lastExit: { ...info, restarts } };
  delete crashed.pid;
  delete crashed.port;
  delete crashed.url;
  writeInstance(crashed);
  if (current.restart !== 'on-failure') return;
  if (restarts > (current.maxRestarts ?? 3)) return;
  // 退避：1s, 2s, 4s…
  await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (restarts - 1), 30_000)));
  try {
    await startInstance(current.id, { supervise: true });
  } catch {
    /* 重起失败已经写进 lastError，交给下一次刷新 */
  }
}

/* ---------- 停止 ---------- */

export interface StopOptions {
  kill?: (pid: number) => void;
  isAlive?: (pid: number) => boolean;
  timeoutMs?: number;
}

export async function stopInstance(idOrName: string, opts: StopOptions = {}): Promise<InstanceRecord> {
  const rec = requireInstance(idOrName);
  if (!rec.pid) {
    throw new PalError('not-running', `实例没有在运行：${rec.name}`, {
      hint: rec.status === 'broken' ? '状态已经是异常，可以直接删或重起' : undefined,
    });
  }
  const alive = opts.isAlive ?? isPidAlive;
  if (!alive(rec.pid)) {
    const { pid: _pid, port: _port, url: _url, ...rest } = rec;
    const next: InstanceRecord = { ...rest, status: 'stopped' };
    writeInstance(next);
    clearSecrets(rec.root);
    return readInstance(rec.id)!;
  }
  (opts.kill ?? killTree)(rec.pid);
  const gone = await waitForExit(rec.pid, {
    isAlive: alive,
    timeoutMs: opts.timeoutMs ?? STOP_TIMEOUT_MS,
  });
  if (!gone) {
    throw new PalError('busy', `停不掉这个进程：pid ${rec.pid}`, {
      hint: '它可能卡在 IO 上；用任务管理器结束，或等一会儿再试',
    });
  }
  const { pid: _pid, port: _port, url: _url, ...rest } = rec;
  const next: InstanceRecord = { ...rest, status: 'stopped' };
  writeInstance(next);
  clearSecrets(rec.root);
  appendEvent(rec.root, { event: 'stop', pid: rec.pid });
  return readInstance(rec.id)!;
}

export async function restartInstance(idOrName: string, opts: StartOptions = {}): Promise<InstanceRecord> {
  const rec = requireInstance(idOrName);
  if (rec.pid) {
    try {
      await stopInstance(rec.id);
    } catch (err) {
      if (!(err instanceof PalError) || err.code !== 'not-running') throw err;
    }
  }
  return startInstance(rec.id, opts);
}

/** 进程已经不在了的实例标成 broken，并记下端口收回了；其余原样返回。 */
export function refreshStatuses(isAlive: (pid: number) => boolean = isPidAlive): InstanceRecord[] {
  return listInstances().map((rec) => {
    if (rec.pid && !isAlive(rec.pid)) {
      const { pid: _pid, port: _port, url: _url, ...rest } = rec;
      const next: InstanceRecord = {
        ...rest,
        status: 'broken',
        lastExit: rec.lastExit ?? { code: null, signal: null, at: nowIso(), restarts: 0 },
      };
      writeInstance(next);
      return next;
    }
    return rec;
  });
}

/** 实例是不是真的还能访问：进程活着 + 端口有人听。 */
export async function isReachable(rec: InstanceRecord): Promise<boolean> {
  if (!rec.pid || !isPidAlive(rec.pid)) return false;
  if (!rec.port) return true;
  return isPortListening(rec.port);
}

export function logTailFor(rec: InstanceRecord, lines = 20): string {
  return tailLog(rec.root, lines);
}

export function logFileOf(rec: InstanceRecord): string {
  const file = join(rec.root, 'logs', 'start.log');
  return existsSync(file) ? file : join(rec.root, 'logs');
}
