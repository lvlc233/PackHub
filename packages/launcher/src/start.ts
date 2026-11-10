import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
} from 'node:fs';
import { extname, join } from 'node:path';
import { ADAPTERS, parseStartUrl, type HarnessAdapter } from './layout.ts';
import { listInstances, readInstance, requireInstance, writeInstance, nowIso, type InstanceRecord } from './index.ts';
import { mergeRecord, partitionRecord } from './records.ts';
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
import { clearStopping, isStopping, markStopping } from './stopMark.ts';

export { isPidAlive, killTree } from './process.ts';
// 标记实现搬到了 stopMark.ts；这里继续按原名导出，调用方（cli/server/测试）不受影响
export { clearStopping, isStopping, markStopping, stoppingMarkFile } from './stopMark.ts';

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

/* ---------- 宿主环境 ---------- */

/**
 * 传给宿主的变量只从这份清单里挑，不再整份继承 PAL 的 process.env。
 * 名字按大小写不敏感匹配（Windows 就是），输出统一用这里写的规范名 —— 这样
 * Windows 上实际叫 `Path`、`SystemRoot` 的那份也能稳定命中。
 *
 * Windows 上缺 SystemRoot/PATH 会直接起不来，缺 TEMP 时 npm/node-gyp 报错，
 * 所以这些不是「顺手带一下」，是启动前提。
 */
export const HOST_ENV_KEEP: readonly string[] = [
  // 找命令、起子进程（宿主还要 npx 起 MCP，靠的就是它）
  'PATH',
  'PATHEXT',
  // Windows 系统目录与命令解释器：SystemRoot 缺了连 DLL/证书都加载不了
  'SystemRoot',
  'WINDIR',
  'SystemDrive',
  'ComSpec',
  // 临时目录
  'TEMP',
  'TMP',
  // 用户与 home：宿主自己的配置/缓存默认落在这里（实例 home 由 homeEnv 单独指过去）
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'USERNAME',
  'USERDOMAIN',
  'USER',
  'LOGNAME',
  // Linux 上同类的配置/缓存目录（只给路径，不是凭据）
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  // 语言/终端：不做 UTF-8 与 TTY 判断会乱码或改变输出格式，地址就等不到了
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'SHELL',
  'TZ',
  // 运行时/硬件信息（node:os 与部分原生模块读）
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
];

/** LC_ALL / LC_CTYPE 这类本地化变量按前缀保留。 */
const HOST_ENV_KEEP_PATTERNS: readonly RegExp[] = [/^LC_[A-Z]+$/];

/** 名字命中这些片段的变量一律不继承：凭据、口令都在里面。 */
export const HOST_ENV_BLOCK = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** 这些前缀属于 PAL 自己或某一家的凭据/配置：实例该用自己 home 里的那份。 */
export const HOST_ENV_BLOCK_PREFIXES: readonly string[] = [
  'PACKHUB_', // PAL 的根目录/实例目录
  'PAL_', // 启动器自己的开关（PAL_DSH_BIN 之类）
  'ANTHROPIC_',
  'OPENAI_',
  'DEEPSEEK_',
  'GEMINI_',
  'GOOGLE_',
  'AZURE_',
  'AWS_',
  'GITHUB_',
  'GH_',
  'GITLAB_',
  'HUGGINGFACE_',
  'HF_',
  'TAVILY_',
  'MOONSHOT_',
  'DASHSCOPE_',
];

/**
 * 代理变量：只是网络出口，不是凭据；实例要下载依赖/连 MCP 就得靠它。
 * 按原名原样保留（不做规范名改写）：curl 认小写，不少工具认大写，两种拼法都别丢。
 */
export const HOST_ENV_KEEP_AS_IS: readonly string[] = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];

const HOST_ENV_AS_IS_UPPER = new Set(HOST_ENV_KEEP_AS_IS);

const HOST_ENV_CANONICAL = new Map(HOST_ENV_KEEP.map((name) => [name.toUpperCase(), name]));

function isBlockedHostEnv(name: string): boolean {
  const upper = name.toUpperCase();
  if (HOST_ENV_BLOCK_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  return HOST_ENV_BLOCK.test(name);
}

function isKeptHostEnv(name: string): boolean {
  const upper = name.toUpperCase();
  if (HOST_ENV_CANONICAL.has(upper)) return true;
  return HOST_ENV_KEEP_PATTERNS.some((pattern) => pattern.test(upper));
}

/**
 * 构造宿主进程的环境：保留项 → 适配器的 homeEnv（实例自己的 home）→ 显式 extra。
 * 纯函数，不读 process.env，规则可以单独测。
 *
 * - 剔除优先于保留：宁可少给一个变量，也不把密钥带进宿主。
 * - extra 是调用方显式给的，最后应用、覆盖前面的结果（包括 homeEnv）—— 显式就是知情。
 */
export function hostEnv(
  base: Record<string, string | undefined>,
  adapter: Pick<HarnessAdapter, 'homeEnv'> | undefined,
  home: string | undefined,
  extra?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (isBlockedHostEnv(name)) continue;
    const upper = name.toUpperCase();
    // 代理按原名带过去；其余保留项统一成规范名（Windows 上实际可能叫 Path）
    if (HOST_ENV_AS_IS_UPPER.has(upper)) {
      env[name] = value;
      continue;
    }
    if (!isKeptHostEnv(name)) continue;
    env[HOST_ENV_CANONICAL.get(upper) ?? upper] = value;
  }
  if (adapter?.homeEnv && home) env[adapter.homeEnv] = home;
  if (extra) {
    for (const [name, value] of Object.entries(extra)) {
      if (typeof value === 'string') env[name] = value;
    }
  }
  return env;
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
  /**
   * 显式补充给宿主的变量。不传就只给保留清单 + 实例 home；
   * 传了按名覆盖前面的结果（也就能把被剔除的项显式给回去）。
   */
  env?: Record<string, string>;
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
    delete healed.spawnPid;
    delete healed.listenPid;
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
  // 只给宿主它跑起来需要的：整份 process.env 会把 PAL 的 key/代理/PACKHUB_* 带进去，
  // 实例的隔离就靠实例自己的 home（homeEnv）与凭据播种，环境穿透等于绕开它
  const env = hostEnv(process.env, adapter, rec.home, opts.env);

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
      // 实例要在 core 退出后继续跑：只有脱离当前进程组才不会被一起收掉。
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

  // 运行态里的进程证据：spawnPid 是唯一可杀目标，listenPid 只作证据（B12）。
  // Windows 上 spawn 的是 cmd 垫片，真正监听的是它的子进程，所以两者本来就常常不同。
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
  // 端口反查到的监听者只是证据：记录它，但 kill 目标永远是 spawnPid（B12）
  const listenPid = opts.ownerOf ? opts.ownerOf(listenPort) : portOwner(listenPort)?.pid;
  const pid = spawnPid ?? listenPid;
  const split = splitUrl(ready.url);
  writeSecrets(rec.root, split.secrets);

  const current = readInstance(rec.id)!;
  const next: InstanceRecord = {
    ...current,
    status: 'running',
    ...(pid ? { pid } : {}),
    ...(spawnPid ? { spawnPid } : {}),
    ...(listenPid ? { listenPid } : {}),
    port: ready.port ?? port,
    ports: [...new Set([...(current.ports ?? []), ready.port ?? port])].slice(-5),
    url: split.url,
    startedAt: nowIso(),
    harnessVersion: info.version ?? current.harnessVersion,
  };
  delete next.lastError;
  writeInstance(next);
  appendEvent(rec.root, {
    event: 'ready',
    pid,
    spawnPid,
    listenPid,
    port: next.port,
    url: split.url,
  });

  if (opts.supervise) attachSupervisor(next, exited);
  return { record: readInstance(rec.id)!, logFile: log.file, url: ready.url };
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: string;
}

export interface ExitTracker {
  /** 已经退出时拿到退出信息；还在跑返回 undefined */
  peek: () => ExitInfo | undefined;
  /** 等到退出或超时：退出返回退出信息，超时返回 undefined */
  wait: (timeoutMs: number) => Promise<ExitInfo | undefined>;
}

/**
 * 跟踪子进程退出。'exit' 只会来一次，就把它变成一个只 resolve 一次的 Promise：
 * wait 用 Promise.race 等它，超时靠一个 setTimeout 兜底。退出（或超时）后立刻清掉 timer，
 * 所以 attachSupervisor 挂 24h 也只是「一个等着的事件」，不再每 50ms 醒一次。
 */
export function trackExit(child: ReturnType<SpawnFn>): ExitTracker {
  let exit: ExitInfo | undefined;
  let settle: ((info: ExitInfo) => void) | undefined;
  const exited = new Promise<ExitInfo>((resolve) => {
    settle = resolve;
  });
  child.once?.('exit', ((code: number | null, signal: NodeJS.Signals | null) => {
    exit = { code, signal: signal ?? null, at: nowIso() };
    settle?.(exit);
    // 只 resolve 一次；之后 wait 直接读 exit
    settle = undefined;
  }) as never);
  return {
    peek: () => exit,
    wait: async (timeoutMs) => {
      // 已经退出：直接给结果，不建 timer
      if (exit) return exit;
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const timedOut = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, timeoutMs));
      });
      try {
        const info = await Promise.race([exited, timedOut]);
        // 超时和 exit 撞在同一拍时，退出信息优先：只要真退了就不报超时
        return info ?? exit;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

/**
 * 启动期只读日志尾部窗口找地址。waitForReady 每 100ms 轮询一次，宿主输出大时
 * 整份读（readFileSync）会把启动期变成持续的全文件 IO/CPU，而且越读越慢。
 *
 * 窗口 128KB 的依据：dsh 的就绪地址打在启动输出末尾（banner、插件加载之后，
 * 监听成功那一行），真实日志里地址距文件尾通常只有几 KB；128KB 留了约两个数量级
 * 的余量，即使地址前多出几屏插件/告警输出也还在窗口内，而每 100ms 读 128KB 的
 * 代价可以忽略。若地址真的更早、被挤出窗口，最终超时错误里的 tailLog 仍会给出日志
 * 尾部（那是失败路径上的一次性读取，不按启动期频率发生），不会因此看不到原因。
 */
const READY_TAIL_BYTES = 128 * 1024;

/**
 * 读文件尾部最多 maxBytes 字节：先 open + fstat 拿大小，再从 size-maxBytes 定位读，
 * 大文件不整份进内存。起点可能落在多字节 UTF-8 字符中间，那个字符会变成替换符；
 * 地址是 ASCII，不影响解析。
 */
function readTail(file: string, maxBytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= 0) return '';
    const length = Math.min(size, maxBytes);
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8', 0, read);
  } finally {
    closeSync(fd);
  }
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
      const hit = parseStartUrl(readTail(logFile, READY_TAIL_BYTES), rec.harness);
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
 * 这一进程正按「子进程退出事件」看护的 pid。
 * core 之外没人再做事件看护；轮询看护（watch.ts）跳过这些 pid，同一个实例不会有两个监督者。
 */
const supervisedPids = new Set<number>();

export function isSupervisedPid(pid: number | undefined): boolean {
  return typeof pid === 'number' && supervisedPids.has(pid);
}

/**
 * 进程退出就把结果写进记录（退出码、信号），on-failure 的实例按退避重起。
 * 只有留在同一个进程里的看护者能拿到退出事件——现在只有 core 会调它。
 */
export function attachSupervisor(record: InstanceRecord, tracker: ExitTracker): void {
  if (record.pid !== undefined) supervisedPids.add(record.pid);
  void tracker.wait(24 * 60 * 60 * 1000).then(async (info) => {
    if (!info) return;
    await onExit(record, info);
  });
}

async function onExit(record: InstanceRecord, info: ExitInfo): Promise<void> {
  try {
    await handleExit(record, info);
  } finally {
    if (record.pid !== undefined) supervisedPids.delete(record.pid);
  }
}

async function handleExit(record: InstanceRecord, info: ExitInfo): Promise<void> {
  const current = readInstance(record.id);
  if (!current) return;
  // 主动停止：stopInstance 在 kill 之前落了标记。onExit 可能比 stopInstance 收尾更早到，
  // 也可能晚到（标记已清、记录已是 stopped），两种情况都不能当成崩溃。
  if (isStopping(current.root, record.pid)) {
    appendEvent(current.root, { event: 'exit-stopped', code: info.code, signal: info.signal, pid: record.pid });
    return;
  }
  // 记录已经归别人了（新一轮启动换了 pid）：老看护不替它写状态，更不能重起
  if (current.pid !== undefined && current.pid !== record.pid) return;
  // stopInstance 已经收尾过（标记清掉了）：这次退出是被 stop 收掉的，不是崩溃
  if (current.status === 'stopped') return;
  const restarts = (current.lastExit?.restarts ?? 0) + 1;
  appendEvent(current.root, { event: 'exit', code: info.code, signal: info.signal, restarts });
  const crashed = { ...current, status: 'broken' as const, lastExit: { ...info, restarts } };
  delete crashed.pid;
  delete crashed.spawnPid;
  delete crashed.listenPid;
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

/**
 * B12：pid 归属判定。
 *
 * 记录里最多有三个 pid：
 * - `spawnPid`：PAL 自己 spawn 出来的，**唯一**允许 kill 的目标；
 * - `listenPid`：启动后按端口反查到的监听者，只作证据。Windows 上 spawn 的是 cmd 垫片，
 *   真正监听的是它的子进程，所以两者不同是常态，不是异常；
 * - `pid`：兼容字段，= `spawnPid ?? listenPid`，不额外承担 kill 目标语义。
 *
 * 判定只回答「能不能杀、杀谁」：spawnPid 活着就只杀它；进程树没了、端口却换到别人手里就拒杀。
 * 旧记录（没有 spawnPid）里 `pid` 是反查来的监听者，只有端口主人与它一致时才当目标，
 * 其余情况拒杀；`--force` 也只允许退回「按记录里的 pid 处理」，永远不会去杀 listenPid。
 */
export type KillRefusalReason = 'listen-not-ours' | 'pid-suspect';

export interface KillRefusal {
  reason: KillRefusalReason;
  message: string;
  hint: string;
  details: Record<string, unknown>;
}

export interface KillDecision {
  /** 要杀的 pid；undefined = 不发 kill，按已停处理 */
  target?: number;
  /** 可疑现场：默认拒杀，由调用方抛 busy */
  refusal?: KillRefusal;
  /** --force 时允许改用的目标：只可能是记录自己的 pid，永远不会是 listenPid */
  forceTarget?: number;
  /** 证据对不上但不该改目标的提醒（例如 listenPid 变了） */
  warnings: string[];
}

export interface KillProbe {
  isAlive: (pid: number) => boolean;
  ownerOf: (port: number) => number | undefined;
}

/** 拒杀时统一的行动建议：不要去杀记录里的 pid。 */
const SUSPECT_HINT = '确认端口主人后手工处理；不要直接杀记录里的 pid';

export function killTargetFor(record: InstanceRecord, probe: KillProbe): KillDecision {
  const warnings: string[] = [];
  const port = record.port;
  // 端口反查（netstat/lsof）不便宜：只在真的要拿证据时查一次。查不到就是 undefined，不代表「没有主人」。
  let ownerQueried = false;
  let ownerPid: number | undefined;
  const owner = (): number | undefined => {
    if (!ownerQueried) {
      ownerQueried = true;
      ownerPid = port === undefined ? undefined : probe.ownerOf(port);
    }
    return ownerPid;
  };

  // a. 自己 spawn 的进程还活着：只杀它；listenPid 变了也只是提醒
  if (record.spawnPid !== undefined) {
    const spawnPid = record.spawnPid;
    if (probe.isAlive(spawnPid)) {
      const listenPid = record.listenPid;
      const current = listenPid === undefined ? undefined : owner();
      if (listenPid !== undefined && current !== undefined && current !== listenPid) {
        warnings.push(
          `端口 ${port} 的主人从 listenPid ${listenPid} 换成了 ${current}：只杀本实例的 spawnPid ${spawnPid}`,
        );
      }
      return { target: spawnPid, warnings };
    }
    // b. 进程树已经没了，但端口主人还活着且就是当初记下的监听者：不是我们的进程，拒杀
    const listenPid = record.listenPid;
    if (listenPid !== undefined && owner() === listenPid && probe.isAlive(listenPid)) {
      return {
        refusal: {
          reason: 'listen-not-ours',
          message: '监听进程还活着，但不在本实例的进程树里',
          hint: SUSPECT_HINT,
          details: { port, spawnPid, listenPid, owner: ownerPid },
        },
        warnings,
      };
    }
    return { warnings };
  }

  // c. legacy（没有 spawnPid）：`pid` 是旧版反查来的监听者，只能当嫌疑人
  const pid = record.pid;
  if (pid === undefined || !probe.isAlive(pid)) return { warnings };
  const current = owner();
  if (current !== undefined && current !== pid) {
    return {
      refusal: {
        reason: 'pid-suspect',
        message: '监听进程还活着，但不在本实例的进程树里',
        hint: SUSPECT_HINT,
        details: { port, pid, owner: current },
      },
      warnings,
    };
  }
  if (current === undefined) {
    // 端口上查不到主人：无法确认 pid 是谁，按可疑处理（--force 才按记录里的 pid 处理）
    return {
      refusal: {
        reason: 'pid-suspect',
        message: '记录里的 pid 还活着，但端口上查不到主人，没法确认它是本实例的进程',
        hint: '先确认这个进程；pal stop --force 会按记录里的 pid 处理',
        details: { port, pid },
      },
      forceTarget: pid,
      warnings,
    };
  }
  // d. 证据一致（端口主人就是记录里的 pid）：按旧行为杀它
  return { target: pid, warnings };
}

export interface StopOptions {
  kill?: (pid: number) => void;
  isAlive?: (pid: number) => boolean;
  /** 查端口主人；默认走 portOwner（netstat/lsof） */
  ownerOf?: (port: number) => number | undefined;
  /** 跳过可疑拒杀：仍不会杀 listenPid，只影响「记录里的 pid 能不能当目标」 */
  force?: boolean;
  timeoutMs?: number;
}

/** 收回运行态里的进程证据：pid/spawnPid/listenPid/port/url 一起清。 */
function withoutProcessState<T extends Pick<InstanceRecord, 'pid' | 'spawnPid' | 'listenPid' | 'port' | 'url'>>(
  record: T,
): Omit<T, 'pid' | 'spawnPid' | 'listenPid' | 'port' | 'url'> {
  const { pid: _pid, spawnPid: _spawnPid, listenPid: _listenPid, port: _port, url: _url, ...rest } = record;
  return rest;
}

export async function stopInstance(idOrName: string, opts: StopOptions = {}): Promise<InstanceRecord> {
  const rec = requireInstance(idOrName);
  if (!rec.pid) {
    throw new PalError('not-running', `实例没有在运行：${rec.name}`, {
      hint: rec.status === 'broken' ? '状态已经是异常，可以直接删或重起' : undefined,
    });
  }
  const alive = opts.isAlive ?? isPidAlive;
  const ownerOf = opts.ownerOf ?? ((port: number) => portOwner(port)?.pid);
  const decision = killTargetFor(rec, { isAlive: alive, ownerOf });
  for (const warning of decision.warnings) appendEvent(rec.root, { event: 'pid-mismatch', message: warning });
  if (decision.refusal && !opts.force) {
    throw new PalError('busy', decision.refusal.message, {
      hint: decision.refusal.hint,
      details: decision.refusal.details,
    });
  }
  // --force 只让「记录里的 pid」变成可杀目标；listenPid 永远不进这里
  const target = decision.refusal ? decision.forceTarget : decision.target;
  const stoppingPid = target ?? rec.pid;
  // 标记必须先于 kill 落盘：看护可能活在另一个进程（pal serve）里，它一看到退出就会走 onExit
  markStopping(rec.root, stoppingPid);
  try {
    if (target !== undefined && alive(target)) {
      (opts.kill ?? killTree)(target);
      const gone = await waitForExit(target, {
        isAlive: alive,
        timeoutMs: opts.timeoutMs ?? STOP_TIMEOUT_MS,
      });
      if (!gone) {
        throw new PalError('busy', `停不掉这个进程：pid ${target}`, {
          hint: '它可能卡在 IO 上；用任务管理器结束，或等一会儿再试',
        });
      }
    }
    const next: InstanceRecord = { ...withoutProcessState(rec), status: 'stopped' };
    writeInstance(next);
    clearSecrets(rec.root);
    appendEvent(rec.root, { event: 'stop', pid: stoppingPid });
    return readInstance(rec.id)!;
  } finally {
    // 成功失败都清：失败时留着标记，后面真实的崩溃会被一直压掉
    clearStopping(rec.root);
  }
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

/**
 * 状态视图：记录 + 只算不写的运行态提示。
 * `stale` 只出现在视图里（进程已死或 pid 缺席），永远不写进 instance.json。
 */
export type InstanceView = InstanceRecord & { stale?: true };

/**
 * 推导一条记录要落盘的状态：pid 已经不在就当 broken 并收回 pid/port/url，其余原样返回。
 * 只动运行态：配置侧原样带过去，未知字段也不丢。
 */
function deriveStatus(rec: InstanceRecord, isAlive: (pid: number) => boolean): InstanceRecord {
  if (!rec.pid || isAlive(rec.pid)) return rec;
  const { config, runtime } = partitionRecord(rec);
  return mergeRecord(config, {
    ...withoutProcessState(runtime),
    status: 'broken',
    lastExit: runtime.lastExit ?? { code: null, signal: null, at: nowIso(), restarts: 0 },
  });
}

/**
 * 纯函数版状态视图：只算不写。GET 这类读路径用它，读列表/体检不会改 instance.json，
 * 也不会把坏记录搬进 .quarantine。
 *
 * 与 deriveStatus 的差别是 running 但 pid 缺席也算 stale：记录说在跑、却没有可核对的 pid，
 * 调用方应当能看出这是「视图推断」而不是「已确认并刷新过」。
 */
export function statusView(records: InstanceRecord[], isAlive: (pid: number) => boolean = isPidAlive): InstanceView[] {
  return records.map((rec) => {
    if (rec.status !== 'running') return deriveStatus(rec, isAlive);
    if (rec.pid && isAlive(rec.pid)) return rec;
    const rest = withoutProcessState(rec);
    return {
      ...rest,
      status: 'broken',
      lastExit: rec.lastExit ?? { code: null, signal: null, at: nowIso(), restarts: 0 },
      stale: true,
    };
  });
}

/** 进程已经不在了的实例标成 broken，并记下端口收回了；其余原样返回。 */
export function refreshStatuses(isAlive: (pid: number) => boolean = isPidAlive): InstanceRecord[] {
  return listInstances().map((rec) => {
    const next = deriveStatus(rec, isAlive);
    if (next !== rec) {
      // stale 是视图字段：即便某份记录里混进了它，落盘前也剥掉
      const { stale: _stale, ...persisted } = next as InstanceView;
      writeInstance(persisted);
    }
    return next;
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
