import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadState, removePack } from '@packhub/runtime';
import { BASELINE } from './baseline.ts';
import { dropActive, requireInstance } from './catalog.ts';
import { PalError } from './errors.ts';
import { withInstanceLock } from './lock.ts';
import { credentialRels } from './layout.ts';
import { archiveRoot } from './paths.ts';
import { portOwner } from './port.ts';
import { isPidAlive, killTree, waitForExit } from './process.ts';
import { moveAside } from './quarantine.ts';
import { removeLink } from './recordWrite.ts';
import { recordFile, runtimeFile, type InstanceRecord } from './records.ts';
import { killTargetFor } from './start.ts';
import { clearStopping, markStopping } from './stopMark.ts';
import { appendEvent } from './logs.ts';

/**
 * 删实例：先停进程；默认直接删根（删不动就改名归档），keepData 才先按 state 卸包再归档；
 * 最后摘 link/active。从 index.ts 搬来，只依赖 fs/path、runtime 和各叶子模块；不 import index.ts（没有循环）。
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
  throw new PalError('busy', '删不掉这个目录', {
    hint: '有进程还握着里面的文件；结束它，或先关掉正在读它的程序',
    details: { dir },
  });
}

export interface RemoveOptions {
  /**
   * 保留数据：先按 state 卸掉 Pack 装进去的文件，删掉根里的 secrets.json 与宿主凭据文件
   * （`ADAPTERS.credentialFiles`），再把实例根（剩下的 home / 会话）移进 .archive，记录从列表里去掉。
   * 不传则直接删根。
   */
  keepData?: boolean;
  /** 已经在跑就先停掉；默认 true */
  force?: boolean;
  kill?: (pid: number) => void;
  isAlive?: (pid: number) => boolean;
  /** 查端口主人；默认走 portOwner（netstat/lsof） */
  ownerOf?: (port: number) => number | undefined;
  /** 等进程退出的上限；默认 10s（测试用短值） */
  timeoutMs?: number;
}

export interface RemoveResult {
  record: InstanceRecord;
  /** 停掉的进程 pid */
  stopped?: number;
  /**
   * 删除前从实例 state 里读到的 Pack key。它只说明「删之前装过哪些 Pack」，
   * **不是**「这些 Pack 被逐个卸载成功」的凭据：
   * - 默认删除：不逐个卸包，文件随实例根一起消失；根删不掉转归档时，文件仍在归档目录里。
   * - keepData：这些 Pack 确实按 state 卸掉了，归档里只剩 home / 会话（secrets.json 与宿主凭据文件已先删）。
   * - 接管来的实例：不按 state 卸包，恒为空数组。
   * 字段名沿用 uninstalled 是为了不动 server/UI 的 JSON；要改名应连同 API 一起升级。
   */
  uninstalled: string[];
  /** keepData 时的去向；默认删除走了归档兜底时也有值 */
  archivedTo?: string;
  /** 实例根是否真的被删掉：只有默认删除成功才是 true；keepData、接管实例、转归档都是 false */
  removed: boolean;
}

/**
 * 删一份实例：先停进程，再按需处理根。
 * - 默认：直接删根（删不动就改名归档），成功后才摘 link/active；失败则记录、state、Pack 文件都原样留着。
 * - keepData：先按 state 卸包，删掉根里的 secrets.json 与宿主凭据文件，再把剩下的根（home / 会话）归档。
 * 运行中的实例不再出现“删一半”（EBUSY、包卸了目录还在）的情况。
 *
 * 边界（N2）：默认删除不逐文件调 removePack，只删根。当前所有安装落点都在实例根内，
 * 所以根删掉就等于清干净；如果以后引入宿主级副作用（全局 MCP 注册、宿主配置键等），
 * 必须在这里补对应的反向清理，不能只靠删根。
 */
export async function removeInstance(
  nameOrId: string,
  opts: RemoveOptions = {},
): Promise<RemoveResult> {
  const record = requireInstance(nameOrId);
  const isAlive = opts.isAlive ?? isPidAlive;
  const kill = opts.kill ?? killTree;
  const ownerOf = opts.ownerOf ?? ((port: number) => portOwner(port)?.pid);
  const uninstalled: string[] = [];
  let stopped: number | undefined;
  let archivedTo: string | undefined;

  await withInstanceLock(record.root, 'remove', async () => {
    // B12：和 pal stop 用同一套判定——只杀 PAL 自己 spawn 的进程，记录里的 pid 不直接当目标。
    // 判定可疑（端口主人换了、记录缺 spawnPid）就拒杀，删除失败并保持记录。
    const decision = killTargetFor(record, { isAlive, ownerOf });
    for (const warning of decision.warnings) {
      appendEvent(record.root, { event: 'pid-mismatch', message: warning });
    }
    if (decision.refusal) {
      if (opts.force === false) {
        throw new PalError('already-running', `实例还在运行：pid ${record.pid}`, {
          hint: '先 pal stop，或让删除自己停（默认行为）',
        });
      }
      throw new PalError('busy', decision.refusal.message, {
        hint: decision.refusal.hint,
        details: decision.refusal.details,
      });
    }
    const pid = decision.target;
    if (pid !== undefined) {
      if (opts.force === false) {
        throw new PalError('already-running', `实例还在运行：pid ${record.pid}`, {
          hint: '先 pal stop，或让删除自己停（默认行为）',
        });
      }
      stopped = pid;
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
      // D1 拆文件后运行态在 runtime.json；接管目录只摘 PAL 的记录与基线，运行态也一起摘掉
      rmSync(runtimeFile(record.root), { force: true });
      rmSync(join(record.root, BASELINE), { force: true });
      removeLink(record.id);
      dropActive(record.id);
      return;
    }

    // keepData 才逐个卸包：先按 state 删掉 Pack 写进去的文件，再把剩下的根（home / 会话 / 凭据）归档
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
      // 归档是长期留着的东西，不是这次删除的替代品：凭据先删掉，
      // 免得实例根里的 PAL token 跟着进 .archive（copy 策略下它是这份实例独有的）。
      // 宿主自己的凭据文件（ADAPTERS.credentialFiles）同理：按 layout 给的清单删，
      // 只落在适配器 home 段内，实例根上或别的子目录里的同名文件不碰。
      // 删不掉不阻断归档：目录里还会带着它，但至少要让人从 stderr 看到。
      const secrets = join(record.root, 'secrets.json');
      if (existsSync(secrets)) {
        try {
          rmSync(secrets, { force: true });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? '未知原因';
          process.stderr.write(`警告：归档前没能删掉 secrets.json（${code}），归档里仍带着凭据\n`);
        }
      }
      for (const rel of credentialRels(record.harness, record.root, record.home)) {
        const file = join(record.root, rel);
        if (!existsSync(file)) continue;
        try {
          rmSync(file, { force: true });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? '未知原因';
          process.stderr.write(`警告：归档前没能删掉 ${rel}（${code}），归档里仍带着凭据\n`);
        }
      }
      const target = moveAside(record.root, archiveRoot(), {
        reason: '保留数据删除',
        id: record.id,
        name: record.name,
        harness: record.harness,
        pack: record.pack,
      });
      if (!target) {
        throw new PalError('busy', '归档失败', {
          hint: '目录可能被占用；关掉正在读它的程序后重试',
          details: { root: record.root },
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
    // 读包 key 只为结果报告：默认路径不逐个卸包，uninstalled 列的是
    // 「随根一起消失（或随根进归档）的 Pack」，不是「已单独卸载」。
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
