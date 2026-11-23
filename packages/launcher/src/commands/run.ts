// pal run：前台启动一个环境。宿主是 TUI 时，由 PAL 负责 home 环境变量与 cwd，
// 用户不再需要自己设 XDG_CONFIG_HOME / CLAUDE_CONFIG_DIR 之类；退出码透传。
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { defineCommand } from 'citty';
import { requireHarness } from '@packhub/kernel';
import { requireInstance } from '../index.ts';
import { PalError } from '../errors.ts';
import { requireTarget } from './shared.ts';

export const run = defineCommand({
  meta: {
    name: 'run',
    description:
      '前台启动一个环境：进入宿主的 TUI，PAL 负责设 home 环境变量与工作目录；退出即结束（不写 pid、不进 core）',
  },
  args: {
    target: { type: 'positional', required: true, description: '环境 id 或名字' },
    dir: { type: 'string', description: '在哪个目录启动（默认环境根）' },
    'dry-run': { type: 'boolean', default: false, description: '只打印将执行的命令/环境变量/cwd，不启动' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const rec = requireInstance(requireTarget(args.target));
    if (rec.status === 'running') {
      throw new PalError('invalid-input', `环境 ${rec.name} 正在运行：先 pal stop ${rec.id}`);
    }
    const spec = requireHarness(rec.harness);
    const tpl = spec.start;
    if (!tpl || tpl.mode !== 'foreground') {
      throw new PalError(
        'invalid-input',
        `宿主 ${rec.harness} 不是前台宿主：用 pal start ${rec.id}（server 型由 core 托管）`,
      );
    }
    const cwd = args.dir ? resolve(String(args.dir)) : rec.root;
    const argv = tpl.args({ port: 0, root: rec.root, ...(rec.home ? { home: rec.home } : {}) });
    const envName = spec.home?.env;
    const extraEnv = envName && rec.home ? { [envName]: rec.home } : {};
    if (args['dry-run'] || args.json) {
      const out = {
        command: tpl.command,
        args: argv,
        cwd,
        env: extraEnv,
      };
      console.log(JSON.stringify(out, null, 2));
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
