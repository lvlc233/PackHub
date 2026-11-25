// `pal ui` 的 CLI 边界：安装 / 管理 / 体检都 spawn 同一条 pal 命令，UI 不重写这些逻辑。
//
// 为什么 spawn 自己而不是依赖 PATH 上的 `pal`：全局安装时 `process.argv[1]` 是 pal.mjs，
// 开发时是 bin.ts 且 `process.execArgv` 带 `--experimental-strip-types`；两种都能起同一个入口，
// 也不会用到 PATH 上另一份旧版 pal。参数走 spawn 数组，天然没有 shell 拼接；只有终端窗口那一条
// 要给 shell 一个命令字符串（那里对名字做引号转义）。
//
// 代价（见 decisions「pal ui」）：UI 与子进程之间只有 stdout / stderr / exit code 一层，
// 进度只能整段返回；超时是杀进程，子进程留下的半成品由 CLI 自己的失败路径处理。
import { spawn } from 'node:child_process';
import { harnessIds, isHarnessId } from '@packhub/kernel';
import { PalError } from './errors.ts';
import { killTree } from './process.ts';

/** 安装 / 更新可能取包、跑清单里的 exec：给 120s；其余动作 60s。 */
export const INSTALL_TIMEOUT_MS = 120_000;
export const ACTION_TIMEOUT_MS = 60_000;
/** 子进程输出上限：只用于给人看，超了截尾，别让刷屏的输出撑爆内存。 */
const MAX_OUTPUT = 512 * 1024;
/** 超时 kill 之后等 close 的兜底：有些平台 close 来得慢，别让页面一直转。 */
const KILL_GRACE_MS = 2_000;

/** 怎么起 pal：可执行文件 + 它的 node 参数 + 入口脚本。默认从当前进程派生（见 defaultPalCommand）。 */
export interface PalCommand {
  execPath: string;
  execArgv: string[];
  entry: string;
}

export interface PalRunOptions {
  /** 子进程工作目录；不写就用当前目录（记录根不存在时调用方也不给） */
  cwd?: string;
  timeoutMs?: number;
}

export interface PalRunResult {
  /** 退出码；被信号结束或起不来时是 null */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 超时被 kill：页面按失败显示，输出里能看到的只有已经写出来的部分 */
  timedOut?: boolean;
}

/** 跑一条 pal 命令。测试注入桩，默认 spawn 自己。 */
export type PalRunner = (args: string[], options?: PalRunOptions) => Promise<PalRunResult>;

/** 当前进程的 pal 入口：全局安装是 pal.mjs，开发时是 bin.ts（execArgv 带 strip-types）。 */
export function defaultPalCommand(): PalCommand {
  const entry = process.argv[1];
  if (!entry) {
    throw new PalError('internal', '找不到 pal 入口：process.argv[1] 是空的', {
      hint: '从 `pal ui` 启动时它一定有值；在测试里请注入 runPal',
    });
  }
  return { execPath: process.execPath, execArgv: [...process.execArgv], entry };
}

/** spawn 的 argv：node 参数 + 入口 + 子命令参数（不经过 shell）。 */
export function palArgv(command: PalCommand, args: string[]): string[] {
  return [...command.execArgv, command.entry, ...args];
}

/** 追加输出并截到上限（保留开头：错误原因通常在最前面，尾部由调用方自己截）。 */
function append(current: string, chunk: Buffer): string {
  if (current.length >= MAX_OUTPUT) return current;
  return (current + chunk.toString('utf8')).slice(0, MAX_OUTPUT);
}

/**
 * 跑一条 pal 子命令，收 stdout / stderr / 退出码。
 * 超时用进程树 kill（Windows 上 taskkill /T），返回 timedOut + 已收到的输出。
 */
export function runPalCommand(
  args: string[],
  options: PalRunOptions = {},
  command: PalCommand = defaultPalCommand(),
): Promise<PalRunResult> {
  const timeoutMs = options.timeoutMs ?? ACTION_TIMEOUT_MS;
  const argv = palArgv(command, args);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
    };

    let child;
    try {
      child = spawn(command.execPath, argv, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: `起不了 pal 子进程：${(err as Error).message}` });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', (err) => {
      // ENOENT 这类起不来：没有 close 事件可等
      stderr = append(stderr, Buffer.from(`起不了 pal 子进程：${err.message}`));
      finish(null);
    });
    child.once('close', (code) => finish(code));
    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
      setTimeout(() => finish(null), KILL_GRACE_MS).unref?.();
    }, timeoutMs);
  });
}

/* ---------- install / plan ---------- */

export type InstallTarget = 'managed' | 'attached' | 'project';

/** 一次安装请求（`/api/plan` 与 `/api/install` 共用）：形状就是页面表单的字段。 */
export interface InstallRequest {
  source: string;
  host: string;
  target: InstallTarget;
  name?: string;
  root?: string;
  home?: string;
  project?: string;
  profile?: string;
  fromHome?: string;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 把 POST body 变成安装请求。只做「缺参 / 未知宿主 / target 互斥」这类用法错（400）；
 * 其余（profile 适用范围、名字冲突、attached 支持）交给 pal install 自己判，UI 不另写一份。
 */
export function parseInstallRequest(body: Record<string, unknown>): InstallRequest {
  const source = text(body.source);
  if (!source) {
    throw new PalError('invalid-input', '安装要一个包来源：source', {
      hint: '本地目录路径 / .phub 文件 / registry 名（name 或 name@version）',
    });
  }
  const host = text(body.host);
  if (!host) {
    throw new PalError('invalid-input', '安装要一个宿主：host', { hint: `可选 ${harnessIds().join(' / ')}` });
  }
  if (!isHarnessId(host)) {
    throw new PalError('invalid-input', `未知宿主：${host}`, {
      hint: `可选 ${harnessIds().join(' / ')}`,
      details: { host, choices: harnessIds() },
    });
  }
  const target = (text(body.target) ?? 'managed') as InstallTarget;
  if (target !== 'managed' && target !== 'attached' && target !== 'project') {
    throw new PalError('invalid-input', `target 只能是 managed / attached / project，收到：${target}`, {
      hint: 'managed = 建命名 home；attached = 装进宿主全局目录（--home）；project = 装进项目（--project）',
    });
  }
  const home = text(body.home);
  if (target === 'attached' && !home) {
    throw new PalError('invalid-input', 'attached target 要 home：宿主的真实全局目录', {
      hint: '例如 ~/.config/opencode、~/.claude；~ 由 pal install 展开',
    });
  }
  const project = text(body.project);
  if (target === 'project' && !project) {
    throw new PalError('invalid-input', 'project target 要 project：项目目录', {
      hint: '项目目录不存在时 pal install 会创建它',
    });
  }
  // 参数与 target 的搭配不静默忽略：CLI 会因为这些退 2，这里先给同一件事的 400
  if (target !== 'project' && text(body.project)) {
    throw new PalError('invalid-input', '--project 只能配 project target', {
      hint: 'target 三选一：managed / attached（--home）/ project（--project）',
    });
  }
  if (target !== 'attached' && home !== undefined) {
    throw new PalError('invalid-input', '--home 只能配 attached target', {
      hint: 'managed 用名字（可选 --root）；project 用 --project',
    });
  }
  if (target === 'project' && text(body.name)) {
    throw new PalError('invalid-input', '--name 只用于 managed / attached home', {
      hint: '--project 装的是宿主会打开的项目目录，没有 home 名',
    });
  }
  if (target !== 'managed' && text(body.root)) {
    throw new PalError('invalid-input', '--root 只能配 managed target', {
      hint: 'attached 用 --home 指定目录；项目用 --project 指定项目目录',
    });
  }
  if (target !== 'managed' && text(body.fromHome)) {
    throw new PalError('invalid-input', '--from-home 只能配 managed target', {
      hint: 'attached 的 home 就是宿主全局目录，凭据本来在那里；项目没有 home 段',
    });
  }
  if (target !== 'attached' && text(body.profile)) {
    throw new PalError('invalid-input', '--profile 只对 attached target 有意义', {
      hint: 'profile 是 dsh 的全局子空间（--home 的 attached dsh）；managed 与项目没有 per-profile 的 MCP 配置',
    });
  }
  const request: InstallRequest = { source, host, target };
  // 只带这个 target 认识的参数：--project 没有名字 / root / profile，--home 没有 root / from-home
  if (target !== 'project') {
    const name = text(body.name);
    if (name) request.name = name;
  }
  if (target === 'managed') {
    const root = text(body.root);
    if (root) request.root = root;
    const fromHome = text(body.fromHome);
    if (fromHome) request.fromHome = fromHome;
  }
  if (target === 'attached') {
    request.home = home;
    const profile = text(body.profile);
    if (profile) request.profile = profile;
  }
  if (target === 'project') request.project = project;
  return request;
}

/** `pal install ...` 的 argv；`dryRun` 时加 `--dry-run --json`（计划要机器可读）。 */
export function installArgs(request: InstallRequest, opts: { dryRun?: boolean } = {}): string[] {
  const args = ['install', request.source, '--host', request.host];
  if (request.target === 'managed') {
    if (request.name) args.push('--name', request.name);
    if (request.root) args.push('--root', request.root);
    if (request.fromHome) args.push('--from-home', request.fromHome);
  } else if (request.target === 'attached') {
    args.push('--home', request.home!);
    if (request.name) args.push('--name', request.name);
    if (request.profile) args.push('--profile', request.profile);
  } else {
    args.push('--project', request.project!);
  }
  if (opts.dryRun) args.push('--dry-run', '--json');
  return args;
}

/* ---------- home 级动作 ---------- */

export const HOME_ACTIONS = ['update', 'rollback', 'verify', 'uninstall', 'remove'] as const;
export type HomeAction = (typeof HOME_ACTIONS)[number];

export function isHomeAction(value: unknown): value is HomeAction {
  return typeof value === 'string' && (HOME_ACTIONS as readonly string[]).includes(value);
}

/**
 * home 级动作的 argv：update / rollback / verify / uninstall 用 `--home <id>`，remove 用位置参数。
 * remove 带 `--yes`：spawn 出来的进程没有 TTY，不带它 pal remove 会按「非交互环境」退 2。
 */
export function homeActionArgs(action: HomeAction, id: string, profile?: string): string[] {
  switch (action) {
    case 'update':
      return ['update', '--home', id, ...(profile ? ['--profile', profile] : [])];
    case 'rollback':
      return ['rollback', '--home', id];
    case 'verify':
      return ['verify', '--home', id];
    case 'uninstall':
      return ['uninstall', '--home', id];
    case 'remove':
      return ['remove', id, '--yes'];
  }
}

/** 动作的超时：update 会取包，按安装那条算。 */
export function homeActionTimeout(action: HomeAction): number {
  return action === 'update' ? INSTALL_TIMEOUT_MS : ACTION_TIMEOUT_MS;
}

/* ---------- 终端窗口 ---------- */

export interface TerminalRequest {
  /** 要在窗口里执行的命令（`pal run <名字>`） */
  command: string;
  title: string;
}

export interface TerminalOpened {
  /** 实际起的窗口命令行（wt.exe / cmd / x-terminal-emulator …），给页面显示与排障 */
  window: string;
}

/** 开终端窗口。测试注入桩，默认见 openTerminalWindow。 */
export type TerminalOpener = (request: TerminalRequest) => Promise<TerminalOpened>;

/**
 * PowerShell 里的一个参数：只有含空白或单引号时才包单引号。
 * 用单引号（PowerShell 里单引号字符串不插值，内部单引号写两遍），这样命令字符串里没有双引号——
 * `cmd /c start "" powershell -Command "<命令>"` 那条路径靠 Node 给整个参数加双引号，内层不能再有双引号。
 */
export function psToken(value: string): string {
  return /[\s']/.test(value) ? `'${value.replaceAll("'", "''")}'` : value;
}

/** 前台模式的终端命令：`pal run <名字>`（名字按 PowerShell 规则转义）。 */
export function foregroundCommand(name: string): string {
  return `pal run ${psToken(name)}`;
}

/** 给人看的命令行（只用于显示与排障，不拿去执行）。 */
function displayCommand(file: string, args: string[]): string {
  return [file, ...args.map((arg) => (arg === '' || /[\s"]/.test(arg) ? JSON.stringify(arg) : arg))].join(' ');
}

/** 起一个 detached 子进程并等它真的起来（ENOENT 这类走 error 事件）。 */
function spawnDetached(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

/**
 * 默认的终端窗口：Windows 优先 `wt.exe`（`-w 0 new-tab` 复用窗口），没有就
 * `cmd /c start "" powershell -NoExit -Command <命令>`；其它平台按常见终端依次试。
 * 全失败抛 internal（HTTP 500），页面显示原因。
 */
export async function openTerminalWindow(request: TerminalRequest): Promise<TerminalOpened> {
  if (process.platform === 'win32') {
    const wtArgs = ['-w', '0', 'new-tab', '--title', request.title, 'powershell', '-NoExit', '-Command', request.command];
    try {
      await spawnDetached('wt.exe', wtArgs);
      return { window: displayCommand('wt.exe', wtArgs) };
    } catch {
      // 没有 Windows Terminal（或它不在 PATH 上）：退回 cmd start
    }
    const startArgs = ['/c', 'start', '', 'powershell', '-NoExit', '-Command', request.command];
    try {
      await spawnDetached('cmd.exe', startArgs);
      return { window: displayCommand('cmd.exe', startArgs) };
    } catch (err) {
      throw new PalError('internal', `打不开终端窗口：${(err as Error).message}`, {
        hint: 'Windows 上需要 wt.exe（Windows Terminal）或 cmd.exe；也可以手动跑返回的命令',
        details: { command: request.command },
      });
    }
  }
  const candidates: Array<{ file: string; args: string[] }> = [
    { file: 'x-terminal-emulator', args: ['-e', 'sh', '-c', request.command] },
    { file: 'gnome-terminal', args: ['--', 'sh', '-c', request.command] },
    { file: 'konsole', args: ['-e', 'sh', '-c', request.command] },
    { file: 'xterm', args: ['-e', 'sh', '-c', request.command] },
  ];
  const problems: string[] = [];
  for (const candidate of candidates) {
    try {
      await spawnDetached(candidate.file, candidate.args);
      return { window: displayCommand(candidate.file, candidate.args) };
    } catch (err) {
      problems.push(`${candidate.file}: ${(err as Error).message}`);
    }
  }
  throw new PalError('internal', '打不开终端窗口：没有可用的终端模拟器', {
    hint: '试过 x-terminal-emulator / gnome-terminal / konsole / xterm；也可以手动跑返回的命令',
    details: { command: request.command, problems },
  });
}
