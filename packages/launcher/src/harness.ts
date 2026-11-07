import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, sep } from 'node:path';
import type { TargetId } from '@packhub/kernel';
import { ADAPTERS, HARNESS_IDS, isHarnessId } from './layout.ts';
import { PalError } from './errors.ts';

/** 宿主发现结果：装了没有、在哪、什么版本、能不能由 PAL 起。 */
export interface HarnessInfo {
  id: TargetId;
  label: string;
  /** project：项目目录，不是可执行宿主 */
  kind: 'project' | 'host';
  homeDir?: string;
  homeEnv?: string;
  executable?: string;
  available: boolean;
  commandPath?: string;
  version?: string;
  startable: boolean;
  /** 不可启动时的能力说明 */
  reason?: string;
  /** 探测失败时的原因（不等于不可用，可能是超时） */
  probeError?: string;
}

export interface DiscoverOptions {
  /** 只查 PATH 不跑 --version，避免测试/CI 卡在慢启动上 */
  probeVersion?: boolean;
  timeoutMs?: number;
}

const WINDOWS_EXTS = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
  .split(';')
  .map((ext) => ext.trim().toLowerCase())
  .filter(Boolean);

function fileNameOf(command: string): string {
  const last = command.split(/[\\/]/).pop() ?? command;
  return last.replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase();
}

/** 在 PATH 里找一个可执行文件；Windows 按 PATHEXT 展开。不调用 shell，不猜。 */
export function whichSync(command: string): string | undefined {
  const candidates: string[] = [];
  const hasSep = command.includes('/') || command.includes('\\');
  if (isAbsolute(command) || hasSep) {
    candidates.push(command);
  } else {
    const path = process.env.PATH ?? '';
    for (const dir of path.split(delimiter)) {
      if (!dir) continue;
      candidates.push(join(dir, command));
    }
  }
  // Windows 上同名文件可能同时有 .cmd 垫片和无扩展名的 bash 壳；先认 PATHEXT 里的可执行形式
  const exts =
    process.platform === 'win32' && extname(command) === ''
      ? [...WINDOWS_EXTS, '']
      : [''];

  for (const candidate of candidates) {
    for (const ext of exts) {
      const file = candidate + ext;
      try {
        const stat = statSync(file);
        if (!stat.isFile()) continue;
        if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) continue;
        return file;
      } catch {
        /* 下一个 */
      }
    }
  }
  return undefined;
}

/** cmd.exe 垫片：带空格/符号的参数包起来，整条命令再包一层引号（/s 会剥掉外层）。 */
function cmdQuote(token: string): string {
  if (!/[\s"&|<>^]/.test(token)) return token;
  return `"${token.replace(/"/g, '\\"')}"`;
}

/** 跑 `--version`：Windows 的 .cmd/.bat 垫片必须过 cmd，.ps1 走 PowerShell。 */
function runVersion(commandPath: string, args: string[], timeoutMs: number): string | undefined {
  const ext = process.platform === 'win32' ? extname(commandPath).toLowerCase() : '';
  let file = commandPath;
  let argv = args;
  let verbatim = false;
  if (ext === '.cmd' || ext === '.bat') {
    file = process.env.ComSpec ?? 'cmd.exe';
    const inner = [cmdQuote(commandPath), ...args.map(cmdQuote)].join(' ');
    argv = ['/d', '/s', '/c', `"${inner}"`];
    verbatim = true;
  } else if (ext === '.ps1') {
    file = process.env.PAL_POWERSHELL ?? 'powershell.exe';
    argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', commandPath, ...args];
  }
  const res = spawnSync(file, argv, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
  });
  const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
  if (res.error || res.status !== 0) return undefined;
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line;
}

const cache = new Map<string, HarnessInfo>();

export function resetHarnessCache(): void {
  cache.clear();
}

/** 环境变量覆盖：PAL_DSH_BIN / PAL_CLAUDE_BIN / PAL_CODEX_BIN 里可以写命令名或绝对路径。 */
function binaryOverride(id: TargetId): string | undefined {
  const key = `PAL_${id.toUpperCase().replace(/-/g, '_')}_BIN`;
  return process.env[key]?.trim() || undefined;
}

export function harnessBinary(id: TargetId): string | undefined {
  return binaryOverride(id) ?? ADAPTERS[id].executable;
}

/** 发现一个宿主：可执行文件、版本、是否可启动。 */
export function discoverHarness(id: TargetId, opts: DiscoverOptions = {}): HarnessInfo {
  const adapter = ADAPTERS[id];
  const binary = harnessBinary(id);
  const cacheKey = `${id}|${binary ?? ''}|${opts.probeVersion === false ? 'noprobe' : 'probe'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const base: HarnessInfo = {
    id,
    label: adapter.label,
    kind: adapter.start ? 'host' : 'project',
    ...(adapter.homeDir ? { homeDir: adapter.homeDir } : {}),
    ...(adapter.homeEnv ? { homeEnv: adapter.homeEnv } : {}),
    ...(binary ? { executable: binary } : {}),
    available: false,
    startable: Boolean(adapter.start),
    ...(!adapter.start && adapter.noStartReason ? { reason: adapter.noStartReason } : {}),
  };

  if (!binary) {
    cache.set(cacheKey, base);
    return base;
  }

  const commandPath = whichSync(binary);
  if (!commandPath) {
    cache.set(cacheKey, base);
    return base;
  }

  const info: HarnessInfo = { ...base, available: true, commandPath };
  if (opts.probeVersion !== false && adapter.versionArgs) {
    const version = runVersion(commandPath, adapter.versionArgs, opts.timeoutMs ?? 6_000);
    if (version) info.version = version.replace(/^v/i, '').slice(0, 80);
    else info.probeError = `${binary} ${adapter.versionArgs.join(' ')} 没有返回版本`;
  }
  cache.set(cacheKey, info);
  return info;
}

export function discoverAll(opts: DiscoverOptions = {}): HarnessInfo[] {
  return HARNESS_IDS.map((id) => discoverHarness(id, opts));
}

/** 解析并校验 harness 名；不认识的名字给可选值，不再拿包声明去挡。 */
export function requireHarness(value: string): TargetId {
  const harness = value.trim() || 'dir';
  if (!isHarnessId(harness)) {
    throw new PalError('unknown-harness', `没有这个宿主：${harness}`, {
      hint: `可选：${HARNESS_IDS.join(' / ')}`,
      details: { harness, choices: HARNESS_IDS },
    });
  }
  return harness;
}

/** 启动前确认宿主真的存在；找不到时给出装法而不是让 spawn 抛 ENOENT。 */
export function requireHarnessBinary(id: TargetId): HarnessInfo {
  const info = discoverHarness(id);
  if (!info.startable) {
    throw new PalError('not-startable', `${ADAPTERS[id].label} 没有可启动的常驻服务`, {
      hint: info.reason,
    });
  }
  if (!info.available) {
    throw new PalError('harness-missing', `找不到 ${info.executable ?? id} 命令`, {
      hint:
        id === 'dsh'
          ? '装 dsh（npm i -g deepseek-harness）或用 PAL_DSH_BIN 指定路径；也可以在界面里先“体检”看探测结果。'
          : `装 ${info.executable ?? id} 或用 PAL_${id.toUpperCase().replace(/-/g, '_')}_BIN 指定路径。`,
    });
  }
  return info;
}

/** 诊断用：宿主目录是否存在（不创建）。 */
export function harnessHomeExists(root: string, id: TargetId): boolean {
  const adapter = ADAPTERS[id];
  if (!adapter.homeDir) return false;
  return existsSync(join(root, adapter.homeDir + sep));
}
