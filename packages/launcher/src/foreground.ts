// 前台模式（`kind: 'foreground'`）的执行：PAL 负责 home 环境变量与 cwd，用户不用自己设
// XDG_CONFIG_HOME / CLAUDE_CONFIG_DIR 之类；stdio 继承、退出码透传、不写运行记录。
//
// `pal run` 与 `pal start --mode <前台模式>` 都走这里，区别只在模式是「默认前台模式」还是命令行选的。
//
// 每个 home 可以放一份 launch.json（与 home 根并列）：
//   { "args": [...], "env": { "K": "V" }, "dir": "相对环境根或绝对路径" }
// 合并顺序：模式默认（命令 + home env）< launch.json < 命令行（--dir）。
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { LaunchMode } from '@packhub/kernel';
import { PalError } from './errors.ts';
import type { HarnessAdapter } from './layout.ts';
import type { InstanceRecord } from './records.ts';

export const LAUNCH_FILE = 'launch.json';

export interface LaunchConfig {
  args?: string[];
  env?: Record<string, string>;
  dir?: string;
}

export function readLaunch(root: string): LaunchConfig {
  const file = join(root, LAUNCH_FILE);
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as LaunchConfig;
    return raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    throw new PalError('invalid-input', `${file} 不是合法 JSON：${(err as Error).message}`, {
      hint: '删掉它，或跑 pal run <home> --init 生成一份空模板',
    });
  }
}

/** 合并后的前台启动计划：dry-run / --json 打这一份，exec 也用它。 */
export interface ForegroundPlan {
  command: string;
  args: string[];
  cwd: string;
  /** 本次额外给宿主的环境变量（home 段 + launch.json 的 env） */
  env: Record<string, string>;
}

/**
 * 拼前台启动计划。
 *
 * - 命令：模式的 `command`，缺省用宿主可执行名；
 * - 工作目录：`--dir` > launch.json 的 `dir` > attached home 用当前目录 / managed 用 home 根；
 * - 环境：attached home 不注入 home 环境变量（宿主本来就用它的全局位置），managed 注入。
 */
export function foregroundPlan(
  record: InstanceRecord,
  adapter: HarnessAdapter,
  mode: LaunchMode,
  opts: { dir?: string } = {},
): ForegroundPlan {
  const launch = readLaunch(record.root);
  const cwd = opts.dir
    ? resolve(opts.dir)
    : launch.dir
      ? resolve(record.root, launch.dir)
      : record.attached === true
        ? process.cwd()
        : record.root;
  const argv = [
    ...(mode.args?.({
      port: 0,
      root: record.root,
      ...(record.home ? { home: record.home } : {}),
    }) ?? []),
    ...(launch.args ?? []),
  ];
  const envName = adapter.homeEnv;
  return {
    command: mode.command ?? adapter.executable ?? record.harness,
    args: argv,
    cwd,
    env: {
      ...(envName && record.home && record.attached !== true ? { [envName]: record.home } : {}),
      ...(launch.env ?? {}),
    },
  };
}

/** 前台 exec：stdio 继承，等宿主退出并把退出码交回去。 */
export async function spawnForeground(plan: ForegroundPlan): Promise<number | null> {
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    stdio: 'inherit',
    env: { ...process.env, ...plan.env },
    // Windows 上宿主常是 .cmd/.ps1 垫片
    shell: process.platform === 'win32',
  });
  return new Promise<number | null>((done) => {
    child.on('error', (err) => {
      console.error(`启动失败：${err.message}`);
      done(1);
    });
    child.on('exit', (code) => done(code));
  });
}
