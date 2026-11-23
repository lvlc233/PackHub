// pal run：前台启动一个 home。宿主是 TUI 时，由 PAL 负责 home 环境变量与 cwd，
// 用户不再需要自己设 XDG_CONFIG_HOME / CLAUDE_CONFIG_DIR 之类；退出码透传。
//
// 每个 home 可以放一份 launch.json（与 home 根并列）：
//   { "args": [...], "env": { "K": "V" }, "dir": "相对环境根或绝对路径" }
// 合并顺序：宿主默认（命令 + home env）< launch.json < 命令行（--dir）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { defineCommand } from 'citty';
import { requireHarness } from '@packhub/kernel';
import { requireInstance } from '../index.ts';
import { PalError } from '../errors.ts';
import { requireTarget } from './shared.ts';

interface LaunchConfig {
  args?: string[];
  env?: Record<string, string>;
  dir?: string;
}

const LAUNCH_FILE = 'launch.json';

function readLaunch(root: string): LaunchConfig {
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

export const run = defineCommand({
  meta: {
    name: 'run',
    description:
      '前台启动一个 home：进入宿主的 TUI，PAL 负责 home 环境变量与工作目录；读 home 里的 launch.json（args/env/dir），退出即结束（不写 pid、不进 core）；attached home 不注入 home 环境变量',
  },
  args: {
    target: { type: 'positional', required: true, description: 'home id 或名字' },
    dir: { type: 'string', description: '覆盖 launch.json 的工作目录（默认 home 根）' },
    init: { type: 'boolean', default: false, description: `生成空的 ${LAUNCH_FILE} 模板（已存在则不覆盖）` },
    'dry-run': { type: 'boolean', default: false, description: '只打印合并后的命令/环境变量/cwd，不启动' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const rec = requireInstance(requireTarget(args.target));
    if (args.init) {
      const file = join(rec.root, LAUNCH_FILE);
      if (existsSync(file)) {
        throw new PalError('invalid-input', `${file} 已存在；要重置先删掉它`);
      }
      writeFileSync(file, `${JSON.stringify({ args: [], env: {}, dir: '' }, null, 2)}\n`, 'utf8');
      console.log(`written ${file}`);
      return;
    }
    if (rec.status === 'running') {
      throw new PalError('invalid-input', `home ${rec.name} 正在运行：先 pal stop ${rec.id}`);
    }
    const spec = requireHarness(rec.harness);
    const tpl = spec.start;
    if (!tpl || tpl.mode !== 'foreground') {
      throw new PalError(
        'invalid-input',
        `宿主 ${rec.harness} 不是前台宿主：用 pal start ${rec.id}（server 型由 core 托管）`,
      );
    }
    const launch = readLaunch(rec.root);
    // attached home 是宿主的全局配置目录，不适合当工作目录：只按 launch.json / --dir 决定；
    // 两者都没有就用当前目录。managed home 仍默认落在 home 根。
    const cwd = args.dir
      ? resolve(String(args.dir))
      : launch.dir
        ? resolve(rec.root, launch.dir)
        : rec.attached === true
          ? process.cwd()
          : rec.root;
    const argv = [...tpl.args({ port: 0, root: rec.root, ...(rec.home ? { home: rec.home } : {}) }), ...(launch.args ?? [])];
    const envName = spec.home?.env;
    // attached home 就是宿主自己的全局位置：宿主会按它默认的路径找配置，不再指一个环境变量过去
    const extraEnv = {
      ...(envName && rec.home && rec.attached !== true ? { [envName]: rec.home } : {}),
      ...(launch.env ?? {}),
    };
    if (args['dry-run'] || args.json) {
      console.log(JSON.stringify({ command: tpl.command, args: argv, cwd, env: extraEnv }, null, 2));
      return;
    }
    const child = spawn(tpl.command, argv, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
      // Windows 上宿主常是 .cmd/.ps1 垫片
      shell: process.platform === 'win32',
    });
    const code = await new Promise<number | null>((done) => {
      child.on('error', (err) => {
        console.error(`启动失败：${err.message}`);
        done(1);
      });
      child.on('exit', (exitCode) => done(exitCode));
    });
    process.exitCode = code ?? 1;
  },
});
