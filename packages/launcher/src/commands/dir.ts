// pal 的“目录对象”命令：install / uninstall / verify / rollback 直接来自 dirCommands.ts，
// update 在这里接上 --dir 分支（实例语义仍在同一个命令里）。
import { defineCommand } from 'citty';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STATE_FILE } from '@packhub/kernel';
import { requireInstance } from '../index.ts';
import { updateFromRef } from '../service.ts';
import {
  installDir,
  rollbackDir,
  uninstallDir,
  updateStateDir,
  verifyDir,
} from '../dirCommands.ts';
import { PalError } from '../errors.ts';
import { requireTarget } from './shared.ts';

export { installDir, rollbackDir, uninstallDir, verifyDir };

export const update = defineCommand({
  meta: {
    name: 'update',
    description:
      '把 Pack 换成另一个版本：位置参数是实例（要求已停）；更新一个已装目录用 --dir <目录>。目录重装也可用 pal install --into <目录>',
  },
  args: {
    target: {
      type: 'positional',
      required: false,
      description: '实例 id/名字；和 --dir 二选一',
    },
    dir: {
      type: 'string',
      description: '已装过包的目录（含 .packhub/state.json）；和位置参数二选一',
    },
    version: { type: 'string', description: 'registry 版本；不写用 latest' },
    index: { type: 'string', description: 'registry 索引（--dir 用；不写用默认索引）' },
    force: {
      type: 'boolean',
      default: false,
      description: '实例模式：覆盖本地改过的文件；不带时若 Pack 写过的文件被本地改过就拒绝更新',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const target = args.target === undefined ? undefined : String(args.target);
    const dirArg = args.dir === undefined ? undefined : String(args.dir);
    if (target !== undefined && dirArg !== undefined) {
      throw new PalError('invalid-input', 'update 的实例位置参数与 --dir 只能给一个', {
        hint: '更新实例：pal update <实例>；更新目录：pal update --dir <目录>。',
      });
    }
    if (target === undefined && dirArg === undefined) {
      throw new PalError('invalid-input', 'update 需要实例名/id，或用 --dir 指定一个已装目录', {
        hint: '更新目录：pal update --dir <目录>；目录重装也可用 pal install --into <目录>；新建实例用 pal create。',
      });
    }
    if (dirArg !== undefined) {
      // 显式目录更新：读 state 里的包与上次 harness，按 registry 最新版重装
      await updateStateDir(dirArg, {
        ...(args.index ? { index: String(args.index) } : {}),
        ...(args.version ? { version: String(args.version) } : {}),
        json: Boolean(args.json),
      });
      return;
    }
    // 位置参数只收实例：给了一个「装过包的目录」时明确指向 --dir，而不是报「没有这个实例」
    const asDir = resolve(target!);
    if (existsSync(join(asDir, STATE_FILE))) {
      throw new PalError('invalid-input', `update 的位置参数只收实例：${target} 是一个已装目录`, {
        hint: '更新目录用 pal update --dir <目录>；目录重装也可用 pal install --into <目录>。',
      });
    }

    const rec = requireInstance(requireTarget(target!));
    const ref = rec.pack.ref ?? rec.pack.name;
    const log = (line: string): void => {
      if (!args.json) console.error(line);
    };
    const result = await updateFromRef({
      idOrName: rec.id,
      packRef: ref,
      ...(args.index ? { index: String(args.index) } : {}),
      ...(args.version ? { version: String(args.version) } : {}),
      ...(args.force ? { force: true } : {}),
      log,
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`${result.changed ? '✓' : '·'} ${result.from} → ${result.to}`);
    if (result.addedFiles.length > 0) console.log(`  + ${result.addedFiles.length} 个文件`);
    if (result.removedFiles.length > 0) console.log(`  - ${result.removedFiles.length} 个旧文件已清掉`);
    for (const file of result.removedFiles.slice(0, 10)) console.log(`    ${file}`);
    if (result.localChanges.length > 0) {
      console.log(`  ! ${result.localChanges.length} 个文件在改之前被本地改过，现在是新版本的内容；要保留请先备份`);
    }
    if (result.warnings.length > 0) {
      console.log(`  ! ${result.warnings.length} 个旧文件没删掉（更新已完成，这些文件还留在实例里）`);
      for (const line of result.warnings.slice(0, 10)) console.log(`    ${line}`);
      if (result.warnings.length > 10) console.log(`    … 还有 ${result.warnings.length - 10} 条`);
    }
  },
});
