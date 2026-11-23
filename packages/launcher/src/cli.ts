// pal 命令面：只在 commands/* 里定义，这里做组装。bin.ts 只拿 main。
// core 不是命令：常驻进程的内部入口在 coreMain.ts，由 bin.ts 在参数解析前直接分派。
import { defineCommand } from 'citty';
import pkg from '../package.json' with { type: 'json' };
import { adopt, list, remove, show } from './commands/instance.ts';
import { health, logs, ps, restart, start, stop } from './commands/lifecycle.ts';
import { run } from './commands/run.ts';
import { backup, clone, exportCmd, importCmd, migrate, restore } from './commands/carry.ts';
import { config, current, use } from './commands/other.ts';
import { install, rollback, uninstall, update, verify } from './commands/dir.ts';

export const main = defineCommand({
  // 版本号只认 package.json 一份，别在这里手写第二份。
  meta: {
    name: 'pal',
    version: pkg.version,
    description:
      '环境内核：建、起、停、看护、迁移；安装/卸载/校验/回退/更新作用于 target（--project 项目 或 --environment 环境），新建环境用 pal install --new',
  },
  subCommands: {
    install,
    uninstall,
    verify,
    rollback,
    config,
    list,
    show,
    remove,
    start,
    run,
    stop,
    restart,
    ps,
    health,
    logs,
    use,
    current,
    adopt,
    clone,
    migrate,
    update,
    export: exportCmd,
    import: importCmd,
    backup,
    restore,
  },
});
