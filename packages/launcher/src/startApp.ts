// `pal start <home> --mode app`：起宿主的桌面 app（窗口），而不是 server / TUI。
//
// app 自己管自己的状态，也不监听端口：PAL 只负责 spawn + 记录 pid（spawnPid），
// 不等 URL、不进 core 看护。可执行文件由模式声明（`LaunchMode.app`：先看环境变量，再按候选路径），
// 解析的通用部分在 apps.ts；能不能用（例如 dsh 只对 attached 开放）由 `mode.available` 回答。
import { spawn as nodeSpawn } from 'node:child_process';
import type { LaunchMode } from '@packhub/kernel';
import { resolveAppBin } from './apps.ts';
import { PalError } from './errors.ts';
import { requireInstance, writeInstance, type InstanceRecord } from './index.ts';
import { requireAdapter } from './layout.ts';
import { assertModeAvailable, defaultAppMode } from './launchModes.ts';
import { appendEvent } from './logs.ts';
import { isPidAlive } from './process.ts';
import { spawnPlanFor, type SpawnFn } from './start.ts';
import { nowIso } from './time.ts';

export interface AppStartOptions {
  /** 直接指定 app 可执行文件；不写就按模式声明的环境变量 / 候选路径解析。 */
  appBin?: string;
  /** 要起的模式；不写就用适配器的默认模式（必须是 app 模式）。 */
  mode?: LaunchMode;
  /** 测试注入；默认 node:child_process 的 spawn。 */
  spawn?: SpawnFn;
  /** 探活；默认 process.ts 的 isPidAlive。 */
  isAlive?: (pid: number) => boolean;
  /** 解析可执行文件时读的环境；默认 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 传给 app 的环境；默认 process.env（再叠宿主 home 环境变量）。 */
  spawnEnv?: NodeJS.ProcessEnv;
}

/**
 * 起桌面 app 并写运行态：`pid = spawnPid = child.pid`，`status = running`，
 * `startedAt = now`，`launchMode = mode.id`，不写 port / url / listenPid。不等待窗口、不打开浏览器。
 *
 * 已经在运行就按现有 already-running 报错，不重复 spawn；上一轮 pid 已死则先把记录标成
 * broken 并收回运行态，避免拿旧 pid 当活的。
 */
export function startAppInstance(idOrName: string, opts: AppStartOptions = {}): InstanceRecord {
  const rec = requireInstance(idOrName);
  const mode = opts.mode ?? defaultAppMode(rec.harness);
  if (!mode) {
    throw new PalError('invalid-input', `宿主 ${rec.harness} 没有 app 模式：不能起桌面 app`, {
      hint: 'pal start <home> --list-modes 看这个宿主的模式表；server / 前台模式用 pal start --mode 起',
      details: { harness: rec.harness },
    });
  }
  if (mode.kind !== 'app') {
    throw new PalError('invalid-input', `模式 ${mode.id} 不是 app 模式：app 启动只认 kind=app`, {
      hint: 'pal start <home> --list-modes 看这个宿主的模式表',
      details: { harness: rec.harness, mode: mode.id, kind: mode.kind },
    });
  }
  if (!mode.app) {
    throw new PalError('invalid-input', `模式 ${mode.id} 是 app 模式，但适配器没声明 app 可执行文件`, {
      details: { harness: rec.harness, mode: mode.id },
    });
  }
  assertModeAvailable(rec, mode);
  const app = mode.app;
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

  const bin =
    opts.appBin ??
    resolveAppBin(app, {
      ...(opts.env ? { env: opts.env } : {}),
      ...(rec.home ? { home: rec.home } : {}),
      label: mode.label,
    });
  // app 常是 .exe：直起；测试里的假 .cmd 垫片仍走 cmd /s /c（与宿主启动同一套判断）
  const plan = spawnPlanFor(bin, []);
  const spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const envName = requireAdapter(rec.harness).homeEnv;
  const env: NodeJS.ProcessEnv = {
    ...(opts.spawnEnv ?? process.env),
    ...(envName && rec.home ? { [envName]: rec.home } : {}),
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
      hint: `检查 ${bin} 是否可执行；或用 ${app.env} 换一个路径`,
      cause: err,
      details: { app: bin },
    });
  }

  // spawn 的失败（ENOENT / EPERM）是异步事件：不给监听器会变成未捕获异常，把 CLI 打崩
  child.once?.('error', ((err: Error) => {
    appendEvent(rec.root, { event: 'app-spawn-error', message: err.message });
  }) as never);

  const pid = child.pid;
  if (pid === undefined) {
    throw new PalError('start-failed', '桌面 app 没有给出 pid', {
      hint: `检查 ${bin} 是否可执行；或用 ${app.env} 换一个路径`,
      details: { app: bin },
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
    launchMode: mode.id,
  };
  delete next.listenPid;
  delete next.port;
  delete next.url;
  delete next.lastError;
  writeInstance(next);
  appendEvent(rec.root, { event: 'app-start', pid, app: bin, mode: mode.id });

  return requireInstance(rec.id)!;
}
