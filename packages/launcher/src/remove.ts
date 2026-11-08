import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadState, removePack } from '@packhub/runtime';
import { BASELINE } from './baseline.ts';
import { dropActive, requireInstance } from './catalog.ts';
import { PalError } from './errors.ts';
import { withInstanceLock } from './lock.ts';
import { archiveRoot } from './paths.ts';
import { isPidAlive, killTree, waitForExit } from './process.ts';
import { moveAside } from './quarantine.ts';
import { removeLink } from './recordWrite.ts';
import { recordFile, type InstanceRecord } from './records.ts';
import { clearStopping, markStopping } from './stopMark.ts';

/**
 * 删实例：停进程、按需卸包或归档、摘 link/active。
 * 从 index.ts 搬来，只依赖 fs/path、runtime 和各叶子模块；不 import index.ts（没有循环）。
 */

/**
 * 删目录：Windows 上刚结束的进程可能还握着文件句柄，
 * 所以先重试几次；实在删不掉就改名挪走（rename 通常还能成），不把半个实例留在列表里。
 */
async function removeTreeWithRetry(dir: string, tries = 6): Promise<{ removed: boolean; movedTo?: string }> {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      if (!existsSync(dir)) return { removed: true };
    } catch {
      /* 换下一次 */
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
  }
  const moved = moveAside(dir, archiveRoot(), { reason: '删除时目录被占用，改为归档', from: dir });
  if (moved) return { removed: false, movedTo: moved };
  throw new PalError('busy', `删不掉这个目录：${dir}`, {
    hint: '有进程还握着里面的文件；结束它，或先关掉正在读它的程序',
  });
}

export interface RemoveOptions {
  /** 保留数据：卸掉 Pack 装进去的文件，把实例根移进 .archive，记录从列表里去掉 */
  keepData?: boolean;
  /** 已经在跑就先停掉；默认 true */
  force?: boolean;
  kill?: (pid: number) => void;
  isAlive?: (pid: number) => boolean;
  /** 等进程退出的上限；默认 10s（测试用短值） */
  timeoutMs?: number;
}

export interface RemoveResult {
  record: InstanceRecord;
  /** 停掉的进程 pid */
  stopped?: number;
  uninstalled: string[];
  /** keepData 时的去向 */
  archivedTo?: string;
  /** 目录是否真的删掉了（接管来的实例默认不删） */
  removed: boolean;
}

/**
 * 删一份实例：先停进程，再按需处理根。
 * - 默认：直接删根（删不动就归档），成功后才摘 link/active；失败则记录、state、包都原样留着。
 * - keepData：先按 state 卸包，再把根归档。
 * 运行中的实例不再出现“删一半”（EBUSY、包卸了目录还在）的情况。
 */
export async function removeInstance(
  nameOrId: string,
  opts: RemoveOptions = {},
): Promise<RemoveResult> {
  const record = requireInstance(nameOrId);
  const isAlive = opts.isAlive ?? isPidAlive;
  const kill = opts.kill ?? killTree;
  const uninstalled: string[] = [];
  let stopped: number | undefined;
  let archivedTo: string | undefined;

  await withInstanceLock(record.root, 'remove', async () => {
    if (record.pid && isAlive(record.pid)) {
      if (opts.force === false) {
        throw new PalError('already-running', `实例还在运行：pid ${record.pid}`, {
          hint: '先 pal stop，或让删除自己停（默认行为）',
        });
      }
      stopped = record.pid;
      const pid = record.pid;
      // 标记必须先于 kill 落盘：pal serve 里的看护一看到进程退出就会走 onExit，
      // 没有标记就会把正在删除的 on-failure 实例又拉起来。
      markStopping(record.root, pid);
      try {
        kill(pid);
        const gone = await waitForExit(pid, { isAlive, timeoutMs: opts.timeoutMs ?? 10_000 });
        if (!gone) {
          throw new PalError('busy', `停不掉这个进程：pid ${pid}`, {
            hint: '手工结束它，或用任务管理器；然后重试删除',
          });
        }
      } finally {
        // 成功失败都清：失败留着标记会把之后真实的崩溃一直压掉。
        // 这里在卸包/搬根之前清，归档目录不会带着标记走。
        clearStopping(record.root);
      }
    }

    // 接管来的目录不是 PAL 的：不能按 state 卸包，keepData 也不搬走它；
    // 只摘记录，目录原样保留。
    if (!record.managed) {
      rmSync(recordFile(record.root), { force: true });
      rmSync(join(record.root, BASELINE), { force: true });
      removeLink(record.id);
      dropActive(record.id);
      return;
    }

    // keepData 要先把 Pack 写进去的文件卸掉，再把（剩下的）根归档
    if (opts.keepData) {
      try {
        const state = loadState(record.root);
        for (const key of Object.keys(state.packs)) {
          removePack(record.root, key);
          uninstalled.push(key);
        }
      } catch (err) {
        throw new PalError('install-failed', `卸载 Pack 失败：${(err as Error).message}`, {
          hint: '先手动清掉实例根里的 .packhub 再删，或保留数据后手工处理',
          cause: err,
        });
      }
      const target = moveAside(record.root, archiveRoot(), {
        reason: '保留数据删除',
        id: record.id,
        name: record.name,
        harness: record.harness,
        pack: record.pack,
      });
      if (!target) {
        throw new PalError('busy', `归档失败：${record.root}`, {
          hint: '目录可能被占用；关掉正在读它的程序后重试',
        });
      }
      archivedTo = target;
      removeLink(record.id);
      dropActive(record.id);
      return;
    }

    // 默认删除：根是唯一真实的删除动作，先走它。
    // 顺序反了（先 removePack 再删根）一旦删根失败，包已经卸掉、目录和记录还在，
    // 没有回滚手段；反过来根删不掉就整根原样留着，state 和记录都完整，可以直接重试。
    // 包 key 只在删根前读一次，纯粹为了结果里的 uninstalled 报告（删完 state 就没了）。
    let packKeys: string[] = [];
    try {
      packKeys = Object.keys(loadState(record.root).packs);
    } catch {
      // state 损坏不该挡住删根：目录整个要消失，报告当作没装过包
    }
    const settled = await removeTreeWithRetry(record.root);
    uninstalled.push(...packKeys);
    removeLink(record.id);
    dropActive(record.id);
    if (!settled.removed) archivedTo = settled.movedTo;
  });

  return {
    record,
    ...(stopped ? { stopped } : {}),
    uninstalled,
    ...(archivedTo ? { archivedTo } : {}),
    removed: !opts.keepData && record.managed && !archivedTo,
  };
}
