// pal run：前台启动一个 home —— `pal start <home> --mode <默认前台模式>` 的糖。
//
// 与 start 走同一份前台执行（foreground.ts）：设 home 环境变量、读 launch.json、`--dir` 覆盖 cwd、
// stdio 继承、退出码透传；不写 pid、不进 core。宿主没有前台模式（例如 dsh 只有 web / app）时报错，
// 让用户改用 `pal start --mode`。
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { requireInstance } from '../index.ts';
import { PalError } from '../errors.ts';
import { foregroundPlan, LAUNCH_FILE, spawnForeground } from '../foreground.ts';
import { requireAdapter } from '../layout.ts';
import { defaultForegroundMode } from '../launchModes.ts';
import { requireTarget } from './shared.ts';

export const run = defineCommand({
  meta: {
    name: 'run',
    description:
      '前台启动一个 home（= pal start <home> --mode <默认前台模式>）：进入宿主的 TUI，PAL 负责 home 环境变量与工作目录；读 home 里的 launch.json（args/env/dir），退出即结束（不写 pid、不进 core）；宿主没有前台模式时报错',
  },
  args: {
    target: { type: 'positional', required: true, description: 'home id 或名字' },
    dir: { type: 'string', description: '工作目录（覆盖 launch.json；默认当前目录）' },
    'home-root': { type: 'boolean', default: false, description: '在 home 根启动（默认在当前目录）；与 --dir 互斥' },
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
    const adapter = requireAdapter(rec.harness);
    const mode = defaultForegroundMode(rec.harness);
    if (!mode) {
      throw new PalError(
        'invalid-input',
        `宿主 ${rec.harness} 没有前台模式：不能用 pal run`,
        {
          hint: `用 pal start ${rec.id} --mode <模式>（pal start ${rec.id} --list-modes 看有哪些：${
            adapter.modes.map((item) => item.id).join(' / ') || '无'
          }）`,
        },
      );
    }
    if (args['home-root'] && args.dir !== undefined) {
      throw new PalError('invalid-input', '--home-root 与 --dir 只能给一个', {
        hint: '--home-root 在 home 根启动；--dir 指定别的工作目录',
      });
    }
    const plan = foregroundPlan(rec, adapter, mode, {
      ...(args.dir ? { dir: String(args.dir) } : {}),
      ...(args['home-root'] ? { homeRoot: true } : {}),
    });
    if (args['dry-run'] || args.json) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    process.exitCode = (await spawnForeground(plan)) ?? 1;
  },
});
