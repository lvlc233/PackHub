// `pal start <dsh> --app`：起 dsh 的 Electron 桌面 app，而不是 dsh web 页面。
//
// app 自己管 desktop profile，也不监听端口：PAL 只负责 spawn + 记录 pid（spawnPid），
// 不等 URL、不进 core 看护。只支持 attached dsh——managed 的 home 是 PAL 自己那一段，
// app 能不能用 DSH_HOME 指过去还没确认（见 docs/decisions.md 的「app 启动只对 attached dsh」）。
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PalError } from './errors.ts';
import { requireInstance, writeInstance, type InstanceRecord } from './index.ts';
import { appendEvent } from './logs.ts';
import { isPidAlive } from './process.ts';
import { spawnPlanFor, type SpawnFn } from './start.ts';
import { nowIso } from './time.ts';

/** 指定 app 可执行文件的环境变量；设了就不用猜安装位置。 */
export const DSH_APP_ENV = 'PAL_DSH_APP_BIN';
/** dsh 桌面端的可执行文件名。 */
export const DSH_APP_NAME = 'DeepSeek Harness.exe';

export interface AppBinLookup {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
}

/** 名字按大小写不敏感读：Windows 的 process.env 就是，测试里给的对象也照同一套规则。 */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper) return value;
  }
  return undefined;
}

/**
 * Windows 常见安装位置，按查找顺序：
 * `%LOCALAPPDATA%\Programs\...` → `%ProgramFiles%\...` → `%ProgramFiles(x86)%\...` → `%LOCALAPPDATA%\...`。
 * 目录变量没设就跳过；重复的路径只留第一次。
 */
export function dshAppCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const localAppData = envValue(env, 'LOCALAPPDATA');
  const roots = [
    localAppData ? join(localAppData, 'Programs') : undefined,
    envValue(env, 'ProgramFiles'),
    envValue(env, 'ProgramFiles(x86)'),
    localAppData,
  ];
  const out: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    const candidate = join(root, 'DeepSeek Harness', DSH_APP_NAME);
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * 解析 app 可执行文件：`PAL_DSH_APP_BIN` 优先，其次 Windows 常见安装位置。
 * 都找不到（或显式变量指向的文件不存在）报 invalid-input（退出 2），提示设置变量。
 */
export function resolveDshAppBin(lookup: AppBinLookup = {}): string {
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  const exists = lookup.exists ?? existsSync;

  const explicit = envValue(env, DSH_APP_ENV)?.trim();
  if (explicit) {
    if (exists(explicit)) return explicit;
    throw new PalError('invalid-input', `${DSH_APP_ENV} 指向的文件不存在：${explicit}`, {
      hint: `把它指向 ${DSH_APP_NAME} 的实际路径；清掉这个变量则按常见安装位置查找`,
      details: { env: DSH_APP_ENV, path: explicit },
    });
  }

  if (platform === 'win32') {
    for (const candidate of dshAppCandidates(env)) {
      if (exists(candidate)) return candidate;
    }
  }

  throw new PalError('invalid-input', `找不到 dsh 桌面 app（${DSH_APP_NAME}）`, {
    hint: `先安装 DeepSeek Harness，或设置 ${DSH_APP_ENV} 指向 ${DSH_APP_NAME}`,
    details: { env: DSH_APP_ENV, candidates: platform === 'win32' ? dshAppCandidates(env) : [] },
  });
}

export interface AppStartCheck {
  /** 本次命令行的 --profile：与 --app 互斥（app 自己管 desktop profile）。 */
  profile?: string;
}

/**
 * `--app` 的用法检查：只对 attached dsh 开放，且不能和 `--profile` 同时给。
 * 顺序是先看宿主、再看互斥、最后看 attached——每条都给具体的下一步。
 */
export function assertAppStartable(record: InstanceRecord, check: AppStartCheck = {}): void {
  if (record.harness !== 'dsh') {
    throw new PalError('invalid-input', `--app 只对 dsh 有意义：${record.harness} 没有桌面 app`, {
      hint: 'app 是 dsh 的 Electron 桌面端；其它宿主用 pal run <home>，server 型才用 pal start',
      details: { harness: record.harness },
    });
  }
  if (check.profile !== undefined) {
    throw new PalError('invalid-input', '--app 与 --profile 互斥：app 自己管 desktop profile', {
      hint: '起桌面 app 就不指定 profile；要挑 web / desktop 的 profile 就起 web 页面（去掉 --app）',
      details: { profile: check.profile },
    });
  }
  if (record.attached !== true) {
    throw new PalError(
      'invalid-input',
      'managed 的 app 启动要先确认它能用 DSH_HOME 指到实例；目前用 --home 的 attached dsh，或先 pal start 起 web',
      {
        hint: '用 --home <dsh home> 装一份 attached 记录，或先 pal start <名字> 起 web 页面',
      },
    );
  }
}

export interface AppStartOptions {
  /** 直接指定 app 可执行文件；不写就按 PAL_DSH_APP_BIN / Windows 常见路径解析。 */
  appBin?: string;
  /** 测试注入；默认 node:child_process 的 spawn。 */
  spawn?: SpawnFn;
  /** 探活；默认 process.ts 的 isPidAlive。 */
  isAlive?: (pid: number) => boolean;
  /** 解析可执行文件时读的环境；默认 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 传给 app 的环境；默认 process.env（再叠 DSH_HOME）。 */
  spawnEnv?: NodeJS.ProcessEnv;
}

/**
 * 起 dsh 桌面 app 并写运行态：`pid = spawnPid = child.pid`，`status = running`，
 * `startedAt = now`，不写 port / url / listenPid。不等待窗口、不打开浏览器。
 *
 * 已经在运行就按现有 already-running 报错，不重复 spawn；上一轮 pid 已死则先把记录标成
 * broken 并收回运行态，避免拿旧 pid 当活的。
 */
export function startAppInstance(idOrName: string, opts: AppStartOptions = {}): InstanceRecord {
  const rec = requireInstance(idOrName);
  assertAppStartable(rec);
  const alive = opts.isAlive ?? isPidAlive;

  if (rec.pid && alive(rec.pid)) {
    throw new PalError('already-running', `实例已在运行：pid ${rec.pid}`, {
      hint: '要重起就先 pal stop',
      details: { pid: rec.pid },
    });
  }

  if (rec.pid && !alive(rec.pid)) {
    appendEvent(rec.root, { event: 'stale-pid', pid: rec.pid });
    const healed: InstanceRecord = { ...rec, status: 'broken' };
    delete healed.pid;
    delete healed.spawnPid;
    delete healed.listenPid;
    delete healed.port;
    delete healed.url;
    writeInstance(healed);
  }

  const app = opts.appBin ?? resolveDshAppBin(opts.env ? { env: opts.env } : {});
  // app 是 .exe：直起；测试里的假 .cmd 垫片仍走 cmd /s /c（与宿主启动同一套判断）
  const plan = spawnPlanFor(app, []);
  const spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const env: NodeJS.ProcessEnv = {
    ...(opts.spawnEnv ?? process.env),
    ...(rec.home ? { DSH_HOME: rec.home } : {}),
  };

  let child: ReturnType<SpawnFn>;
  try {
    child = spawnFn(plan.file, plan.args, {
      cwd: rec.root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
      ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (err) {
    throw new PalError('start-failed', `起不了桌面 app：${(err as Error).message}`, {
      hint: `检查 ${app} 是否可执行；或用 ${DSH_APP_ENV} 换一个路径`,
      cause: err,
      details: { app },
    });
  }

  // spawn 的失败（ENOENT / EPERM）是异步事件：不给监听器会变成未捕获异常，把 CLI 打崩
  child.once?.('error', ((err: Error) => {
    appendEvent(rec.root, { event: 'app-spawn-error', message: err.message });
  }) as never);

  const pid = child.pid;
  if (pid === undefined) {
    throw new PalError('start-failed', '桌面 app 没有给出 pid', {
      hint: `检查 ${app} 是否可执行；或用 ${DSH_APP_ENV} 换一个路径`,
      details: { app },
    });
  }
  // 起完就放手：app 自己活着，CLI 不需要一直持有句柄
  child.unref?.();

  const current = requireInstance(rec.id);
  const next: InstanceRecord = {
    ...current,
    status: 'running',
    pid,
    spawnPid: pid,
    startedAt: nowIso(),
  };
  delete next.listenPid;
  delete next.port;
  delete next.url;
  delete next.lastError;
  writeInstance(next);
  appendEvent(rec.root, { event: 'app-start', pid, app });

  return requireInstance(rec.id)!;
}
