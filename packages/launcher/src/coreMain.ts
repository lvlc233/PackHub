// core 的内部入口：常驻进程不再是一条 pal 命令（命令面收缩），
// 按需拉起（coreClient）与登录计划任务（coreTask）仍从 bin.ts 的同一个入口进：
// `node <入口> __core <动作>`。它不是子命令，不进 --help，也不进 main.subCommands。
import { PACKHUB_ENV } from '@packhub/kernel';
import { isAbsolute, resolve } from 'node:path';
import { PalError, isPalError } from './errors.ts';
import { ensureCore, probeCore, stopCore } from './coreClient.ts';
import { DEFAULT_CORE_INTERVAL_MS, startCore } from './core.ts';
import { coreTaskInstalled, installCoreTask, uninstallCoreTask } from './coreTask.ts';
import { CORE_ENTRY } from './coreEntry.ts';

/** bin.ts 认的隐藏动词（定义在 coreEntry.ts：coreClient 也要用，避免循环 import）。 */
export { CORE_ENTRY };

export type CoreAction = 'run' | 'start' | 'status' | 'stop' | 'install' | 'uninstall';

const CORE_ACTIONS: readonly CoreAction[] = ['run', 'start', 'status', 'stop', 'install', 'uninstall'];

export interface CoreEntryArgs {
  action: CoreAction;
  port: number;
  intervalMs: number;
  home?: string;
  json: boolean;
}

/** 正整数校验：`run --interval` 用；默认值由 DEFAULT_CORE_INTERVAL_MS 定。 */
function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new PalError('invalid-input', `${flag} 要正整数的毫秒数，收到：${value}`, {
      hint: `${CORE_ENTRY} 是内部入口：看护间隔默认 ${DEFAULT_CORE_INTERVAL_MS}`,
    });
  }
  return n;
}

/**
 * 解析内部入口的参数。与命令参数表无关（citty 不参与），所以在这里一次把
 * 动作与标志收齐；未知标志直接报错，不静默忽略（内部调用方只有 coreClient 与计划任务）。
 */
export function parseCoreEntryArgs(argv: string[]): CoreEntryArgs {
  let action: CoreAction | undefined;
  let port = 0;
  let intervalMs = DEFAULT_CORE_INTERVAL_MS;
  let home: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('-')) {
      if (action !== undefined) {
        throw new PalError('invalid-input', `${CORE_ENTRY} 只收一个动作，多出来：${token}`);
      }
      if (!CORE_ACTIONS.includes(token as CoreAction)) {
        throw new PalError('invalid-input', `未知动作：${token}`, {
          hint: `内部动作：${CORE_ACTIONS.join(' / ')}`,
        });
      }
      action = token as CoreAction;
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq >= 0 ? token.slice(0, eq) : token;
    const takeValue = (): string => {
      if (eq >= 0) return token.slice(eq + 1);
      const next = argv[i + 1];
      if (next === undefined) throw new PalError('invalid-input', `${name} 需要一个值`);
      i += 1;
      return next;
    };
    switch (name) {
      case '--port': {
        const raw = takeValue();
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          throw new PalError('invalid-input', `--port 要 0 或正整数，收到：${raw}`, {
            hint: '0 表示让系统挑一个端口',
          });
        }
        port = n;
        break;
      }
      case '--interval':
        intervalMs = positiveInt(takeValue(), '--interval');
        break;
      case '--home':
        home = takeValue();
        break;
      case '--json':
        json = true;
        break;
      default:
        throw new PalError('invalid-input', `未知参数 ${name}`, {
          hint: `${CORE_ENTRY} 的参数只有 --port / --interval / --home / --json`,
        });
    }
  }

  if (action === undefined) {
    throw new PalError('invalid-input', `${CORE_ENTRY} 需要动作`, {
      hint: `内部动作：${CORE_ACTIONS.join(' / ')}；一般由 coreClient 或计划任务发起`,
    });
  }
  return { action, port, intervalMs, ...(home === undefined ? {} : { home }), json };
}

/** --home：计划任务不继承用户环境，得让它自己说数据目录在哪。 */
function applyHome(raw: string | undefined): void {
  const text = String(raw ?? '').trim();
  if (!text) return;
  if (!isAbsolute(text)) {
    throw new PalError('invalid-input', '--home 要绝对路径', { hint: '例如 D:\\PackHubData' });
  }
  process.env[PACKHUB_ENV.home] = resolve(text);
}

/** 内部入口的执行体：bin.ts 在参数解析前把 `__core ...` 交给它。 */
export async function runCoreEntry(argv: string[]): Promise<void> {
  const args = parseCoreEntryArgs(argv);
  applyHome(args.home);

  switch (args.action) {
    case 'run': {
      const started = await startCore({ port: args.port, intervalMs: args.intervalMs }).catch(
        (err: unknown) => {
          // 已经有 core 在跑是正常结局（计划任务与手动拉起撞车）：别报错，否则会被反复重起
          if (isPalError(err) && err.code === 'busy') return undefined;
          throw err;
        },
      );
      if (!started) {
        console.log(args.json ? JSON.stringify({ running: true }) : 'PAL core 已经在运行');
        return;
      }
      console.log(
        args.json
          ? JSON.stringify({ url: started.url, pid: process.pid })
          : `PAL core：${started.url}（pid ${process.pid}）`,
      );
      const shutdown = (): void => {
        void started.close().finally(() => process.exit(0));
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      return;
    }
    case 'start': {
      const info = await ensureCore();
      console.log(
        args.json
          ? JSON.stringify({ pid: info.pid, url: info.url })
          : `PAL core：${info.url}（pid ${info.pid}）`,
      );
      return;
    }
    case 'status': {
      const info = await probeCore();
      const task = process.platform === 'win32' ? coreTaskInstalled() : false;
      if (args.json) {
        console.log(
          JSON.stringify(
            info
              ? {
                  running: true,
                  pid: info.pid,
                  url: info.url,
                  startedAt: info.startedAt,
                  version: info.version,
                  task,
                }
              : { running: false, task },
            null,
            2,
          ),
        );
        return;
      }
      if (!info) {
        console.log('PAL core 没在运行；下一条 pal start / pal stop 会按需拉起它');
      } else {
        console.log(`PAL core  pid ${info.pid}  ${info.url}`);
        console.log(`  起于 ${info.startedAt}  v${info.version}`);
      }
      if (process.platform === 'win32') {
        console.log(`  登录任务：${task ? '已注册' : '未注册'}`);
      }
      return;
    }
    case 'stop': {
      await stopCore();
      console.log('✓ 已停掉 PAL core');
      return;
    }
    case 'install': {
      const task = installCoreTask();
      const info = await ensureCore();
      console.log(`✓ 已注册计划任务：${task.name}`);
      console.log(`  PAL core：${info.url}（pid ${info.pid}）`);
      return;
    }
    case 'uninstall': {
      const result = uninstallCoreTask();
      console.log(result.removed ? '✓ 已删除计划任务' : '· 计划任务本来就不存在');
      return;
    }
  }
}
