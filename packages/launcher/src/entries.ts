import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { TargetId } from '@packhub/kernel';
import { ADAPTERS, dshStartArgs, type StartContext } from './layout.ts';
import { PalError } from './errors.ts';

/**
 * 入口：一个实例可以被跑成的几种形态。每个入口回答五件事——
 * 起什么命令、凭什么算就绪、打开成什么面、怎么终止、能不能绑到实例上。
 *
 * 入口是宿主的属性，不是 PAL 的开关：哪个宿主有哪几个入口写在下面这张表里，
 * 运行态只记「这次用的是哪个入口」，不重新定义入口。
 */
export type EntryKind = 'web' | 'app' | 'tui' | 'headless';

/** 起什么：宿主命令 / 宿主自己的桌面应用 / 新终端里跑宿主命令。 */
export type EntryLaunch = 'host' | 'desktop' | 'terminal';

/** 打开成什么面。none = 没有可打开的界面（headless）。 */
export type EntrySurface = 'browser' | 'window' | 'terminal' | 'none';

/** 终止方式：tree=直接回收进程树；graceful=先请求退出再回收；close-surface=关掉面再回收；exit=等它自己退。 */
export type EntryStop = 'tree' | 'graceful' | 'close-surface' | 'exit';

/** 就绪判据。url 从启动日志里等地址；port 连 TCP；pid 只等到进程稳住；exit 等退出码。 */
export type EntryReady =
  | { kind: 'url'; timeoutMs?: number }
  | { kind: 'port'; port: (ctx: StartContext) => number | undefined; timeoutMs?: number }
  | { kind: 'pid'; settleMs?: number }
  | { kind: 'exit'; timeoutMs?: number };

/** 入口能绑到实例上的东西。binds.home=false 说明它只能跑全局环境，不算实例入口。 */
export interface EntryBinds {
  home: boolean;
  env: boolean;
  port: boolean;
}

export interface EntrySpec {
  kind: EntryKind;
  label: string;
  /** 这个入口把实例跑成什么 */
  summary: string;
  launch: EntryLaunch;
  /** 参数；不经过 shell。task 只给需要任务的入口（headless） */
  args?: (ctx: StartContext & { task?: string }) => string[];
  ready: EntryReady;
  surface: EntrySurface;
  stop: EntryStop;
  binds: EntryBinds;
  /** 这个入口必须有任务文本才能起（headless） */
  needsTask?: boolean;
  /** 已知不可用的原因；运行期还会再探一次（见 entryStates） */
  unavailable?: string;
}

/** 入口在当前这台机器上的状态：能不能起、为什么不能。 */
export interface EntryState extends EntrySpec {
  /** 命令找得到（宿主或桌面应用） */
  available: boolean;
  /** 现在就能起：命令在、没有已知限制 */
  startable: boolean;
  /** 不能起时给用户看的原因 */
  reason?: string;
}

export interface EntryProbe {
  /** 宿主命令的绝对路径（discoverHarness 的结果）；没有说明没装 */
  commandPath?: string;
  /** 实例 home 段；tui profile 这类入口要在它下面找 */
  home?: string;
  /** 实例根：codex app 用来指定工作区 */
  root?: string;
}

const desktopExeCache = new Map<string, string | undefined>();

/** 读一份小文本（垫片），读不到就当空。 */
function readSmall(file: string): string {
  try {
    if (statSync(file).size > 64 * 1024) return '';
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 找 dsh 的桌面应用可执行文件。dsh 的 npm 垫片只指向 CLI，app 是另一份 Electron 程序，
 * 所以按「垫片里的真实路径 + 往上几层」找，认不出就让用户用 PAL_DSH_APP 指定。
 */
export function desktopAppOf(hostPath: string | undefined): string | undefined {
  const key = hostPath ?? '';
  if (desktopExeCache.has(key)) return desktopExeCache.get(key);
  const found = findDesktopApp(hostPath);
  desktopExeCache.set(key, found);
  return found;
}

function findDesktopApp(hostPath: string | undefined): string | undefined {
  const env = process.env.PAL_DSH_APP?.trim();
  if (env) return existsSync(env) ? env : undefined;

  const starts: string[] = [];
  if (hostPath) {
    starts.push(hostPath);
    // 垫片形如 `call "G:\tool\dsh\resources\runtime\cli\bin\dsh.cmd" %*`
    const inner = /call\s+"([^"]+)"/i.exec(readSmall(hostPath))?.[1];
    if (inner) starts.push(inner);
  }
  const names = ['DeepSeek Harness.exe', 'dsh.exe', 'dsh-app.exe'];
  for (const start of starts) {
    let dir = dirname(start);
    for (let depth = 0; depth < 5; depth += 1) {
      for (const name of names) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

export function resetEntryCache(): void {
  desktopExeCache.clear();
}

/* ---------- 宿主 × 入口 ---------- */

const dshWeb: EntrySpec = {
  kind: 'web',
  label: 'Web',
  summary: '跑 web profile，给你一个地址，用浏览器打开',
  launch: 'host',
  args: (ctx) => dshStartArgs(ctx, ADAPTERS.dsh),
  ready: { kind: 'url', ...(ADAPTERS.dsh.start?.readyTimeoutMs ? { timeoutMs: ADAPTERS.dsh.start.readyTimeoutMs } : {}) },
  surface: 'browser',
  stop: 'tree',
  binds: { home: true, env: true, port: true },
};

const dshApp: EntrySpec = {
  kind: 'app',
  label: '桌面应用',
  summary: '起 DeepSeek Harness 桌面应用，窗口由它自己开；PAL 负责拉起与回收',
  launch: 'desktop',
  ready: { kind: 'pid', settleMs: 2_000 },
  surface: 'window',
  stop: 'graceful',
  binds: { home: true, env: true, port: false },
};

const dshTui: EntrySpec = {
  kind: 'tui',
  label: '终端',
  summary: '新开一个终端窗口，在里面跑 tui profile',
  launch: 'terminal',
  args: (ctx) => [...(ctx.patchFile ? ['--patch', ctx.patchFile] : []), '--profile', 'tui'],
  ready: { kind: 'pid', settleMs: 1_500 },
  surface: 'terminal',
  stop: 'close-surface',
  binds: { home: true, env: true, port: false },
};

const dshHeadless: EntrySpec = {
  kind: 'headless',
  label: '一次性',
  summary: '跑 headless profile：一件事去做，做完记退出码',
  launch: 'host',
  args: (ctx) => ['--profile', 'headless', ctx.task ?? ''],
  ready: { kind: 'exit', timeoutMs: 10 * 60_000 },
  surface: 'none',
  stop: 'exit',
  binds: { home: true, env: true, port: false },
  needsTask: true,
};

const codexApp: EntrySpec = {
  kind: 'app',
  label: '桌面应用',
  summary: 'codex app 拉起桌面应用（它自己连 app-server），窗口由它开',
  launch: 'host',
  args: (ctx) => ['app', ctx.root],
  ready: { kind: 'pid', settleMs: 2_000 },
  surface: 'window',
  stop: 'graceful',
  binds: { home: true, env: true, port: false },
};

const codexTui: EntrySpec = {
  kind: 'tui',
  label: '终端',
  summary: '新开一个终端窗口，跑 codex 的交互界面',
  launch: 'terminal',
  ready: { kind: 'pid', settleMs: 1_500 },
  surface: 'terminal',
  stop: 'close-surface',
  binds: { home: true, env: true, port: false },
};

const codexHeadless: EntrySpec = {
  kind: 'headless',
  label: '一次性',
  summary: 'codex exec：跑一条任务，结束记退出码',
  launch: 'host',
  args: (ctx) => ['exec', ctx.task ?? ''],
  ready: { kind: 'exit', timeoutMs: 10 * 60_000 },
  surface: 'none',
  stop: 'exit',
  binds: { home: true, env: true, port: false },
  needsTask: true,
};

const claudeTui: EntrySpec = {
  kind: 'tui',
  label: '终端',
  summary: '新开一个终端窗口，跑 claude 的交互界面',
  launch: 'terminal',
  ready: { kind: 'pid', settleMs: 1_500 },
  surface: 'terminal',
  stop: 'close-surface',
  binds: { home: true, env: true, port: false },
};

const claudeHeadless: EntrySpec = {
  kind: 'headless',
  label: '一次性',
  summary: 'claude -p：跑一条任务，结束记退出码',
  launch: 'host',
  args: (ctx) => ['-p', ctx.task ?? ''],
  ready: { kind: 'exit', timeoutMs: 10 * 60_000 },
  surface: 'none',
  stop: 'exit',
  binds: { home: true, env: true, port: false },
  needsTask: true,
};

/** 宿主 × 入口。顺序就是界面与默认值的顺序：第一个是默认入口。 */
export const ENTRIES: Record<TargetId, EntrySpec[]> = {
  dir: [],
  dsh: [dshWeb, dshApp, dshTui, dshHeadless],
  codex: [codexApp, codexTui, codexHeadless],
  'claude-code': [claudeTui, claudeHeadless],
};

export const ENTRY_KINDS: EntryKind[] = ['web', 'app', 'tui', 'headless'];

export function isEntryKind(value: string): value is EntryKind {
  return (ENTRY_KINDS as string[]).includes(value);
}

/** 某个宿主声明的入口（不探状态）。 */
export function entriesOf(harness: TargetId): EntrySpec[] {
  return ENTRIES[harness] ?? [];
}

export function entryOf(harness: TargetId, kind: EntryKind): EntrySpec | undefined {
  return entriesOf(harness).find((entry) => entry.kind === kind);
}

/**
 * 默认入口：记录里上次用的那个；没有就用声明的第一个。
 * 都不可用时也返回第一个，让「为什么起不来」由 entryStates 说清楚。
 */
export function defaultEntry(harness: TargetId, last?: EntryKind): EntrySpec | undefined {
  const entries = entriesOf(harness);
  if (last) {
    const hit = entries.find((entry) => entry.kind === last);
    if (hit) return hit;
  }
  return entries[0];
}

/** 这个入口的命令能不能找到：桌面应用看单独的 exe，其余看宿主命令。 */
function entryCommand(harness: TargetId, entry: EntrySpec, probe: EntryProbe): string | undefined {
  if (entry.launch === 'desktop') {
    if (harness === 'dsh') return desktopAppOf(probe.commandPath);
    return undefined;
  }
  if (entry.launch === 'terminal') {
    // 终端里跑的仍是宿主命令；终端本身由 terminalPlan 现找
    return probe.commandPath;
  }
  return probe.commandPath;
}

/** tui 入口的 profile 在不在：dsh 的 tui 要事先装过 profile，没装就不给起。 */
function profileProblem(harness: TargetId, entry: EntrySpec, probe: EntryProbe): string | undefined {
  if (harness !== 'dsh' || entry.kind !== 'tui' || !probe.home) return undefined;
  // 只有目录不算装过：dsh 认的是 profile 里有 package.json 的那份
  const dir = join(probe.home, 'profiles', 'tui');
  if (existsSync(join(dir, 'package.json'))) return undefined;
  return '这个实例的 dsh 没有 tui profile：先 dsh plugin --profile tui add <package>，或用 web / 桌面应用入口';
}

/** 一次算出某个宿主所有入口的状态；界面与 CLI 都读这一份。 */
export function entryStates(harness: TargetId, probe: EntryProbe = {}): EntryState[] {
  return entriesOf(harness).map((entry) => {
    const command = entryCommand(harness, entry, probe);
    const available = Boolean(command);
    const problem = entry.unavailable ?? profileProblem(harness, entry, probe);
    const reason = !available
      ? entry.launch === 'desktop'
        ? '找不到宿主桌面应用；用 PAL_DSH_APP 指定可执行文件'
        : '找不到宿主命令；先装它，或用 PAL_*_BIN 指定路径'
      : problem;
    return {
      ...entry,
      available,
      startable: available && !problem,
      ...(reason ? { reason } : {}),
    };
  });
}

/** 解析要起的入口；不认识的名字给出可选值。 */
export function requireEntry(harness: TargetId, kind: string | undefined, last?: EntryKind): EntrySpec {
  const entries = entriesOf(harness);
  if (entries.length === 0) {
    throw new PalError('not-startable', `${ADAPTERS[harness].label} 没有可启动的入口`, {
      hint: ADAPTERS[harness].noStartReason,
      details: { harness },
    });
  }
  if (!kind) return defaultEntry(harness, last) ?? entries[0]!;
  const hit = entries.find((entry) => entry.kind === kind);
  if (!hit) {
    throw new PalError('invalid-input', `${ADAPTERS[harness].label} 没有 ${kind} 入口`, {
      hint: `可选：${entries.map((entry) => entry.kind).join(' / ')}`,
      details: { harness, entry: kind },
    });
  }
  return hit;
}

/* ---------- 终端 ---------- */

export interface TerminalPlan {
  file: string;
  args: string[];
  /** 用的哪种终端：记进运行态，排障时知道窗口是谁开的 */
  kind: 'wt' | 'cmd' | 'linux';
  /** Windows 上终端窗口要看得见，不能 windowsHide */
  visible: boolean;
}

/** PATH 上找可执行文件（只用来找 wt.exe，不展开 PATHEXT 之外的猜测）。 */
function whichSimple(name: string): string | undefined {
  const path = process.env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      /* 下一个 */
    }
  }
  return undefined;
}

function cmdQuote(token: string): string {
  if (!/[\s"&|<>^]/.test(token)) return token;
  return `"${token.replace(/"/g, '\\"')}"`;
}

/**
 * 在终端里跑一条命令。Windows 用 Windows Terminal（有就优先）或 cmd 的 start /wait：
 * start /wait 让终端进程一直挂在 PAL 的 spawnPid 下面，关面就是回收这棵树。
 * 0.x 只承诺 Windows；别的平台用 x-terminal-emulator，找不到就报不可用。
 */
export function terminalPlan(commandPath: string, args: string[], title: string): TerminalPlan {
  const inner = [cmdQuote(commandPath), ...args.map(cmdQuote)].join(' ');
  if (process.platform === 'win32') {
    const wt = whichSimple('wt.exe');
    if (wt) {
      return {
        file: wt,
        args: ['-w', '0', 'nt', '--title', title, process.env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c', inner],
        kind: 'wt',
        visible: true,
      };
    }
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', 'start', '', '/wait', 'cmd.exe', '/k', `"${inner}"`],
      kind: 'cmd',
      visible: true,
    };
  }
  const term = whichSimple('x-terminal-emulator') ?? whichSimple('gnome-terminal');
  if (!term) {
    throw new Error('这个平台找不到可用的终端；PAL 0.x 只承诺 Windows 的终端入口');
  }
  return { file: term, args: ['-e', '/bin/sh', '-lc', `${cmdQuote(commandPath)} ${args.map(cmdQuote).join(' ')}`], kind: 'linux', visible: true };
}
