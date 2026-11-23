// pal 命令面：只在 commands/* 里定义，这里做组装。bin.ts 只拿 main。
import { defineCommand } from 'citty';
import pkg from '../package.json' with { type: 'json' };
import { adopt, list, remove, show } from './commands/instance.ts';
import { health, logs, ps, restart, start, stop } from './commands/lifecycle.ts';
import {
  backup,
  clone,
  exportCmd,
  importCmd,
  leftovers,
  migrate,
  rename,
  restore,
  scan,
} from './commands/carry.ts';
import { core } from './commands/core.ts';
import { audit, cache, config, current, rebaseline, use } from './commands/other.ts';
import { install, rollback, uninstall, update, verify } from './commands/dir.ts';

export const main = defineCommand({
  // 版本号只认 package.json 一份，别在这里手写第二份。
  meta: {
    name: 'pal',
    version: pkg.version,
    description:
      '实例内核：建、起、停、看护、迁移；安装/卸载/校验/回退/更新作用于 target（--into 目录 或 --instance 实例），新建实例用 pal install --new',
  },
  subCommands: {
    install,
    uninstall,
    verify,
    rollback,
    config,
    list,
    show,
    cache,
    remove,
    start,
    stop,
    restart,
    ps,
    core,
    health,
    audit,
    logs,
    use,
    current,
    scan,
    adopt,
    clone,
    rename,
    migrate,
    update,
    rebaseline,
    export: exportCmd,
    import: importCmd,
    backup,
    restore,
    leftovers,
  },
});
