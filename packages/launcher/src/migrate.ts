import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PalError } from './errors.ts';
import { isPidAlive } from './process.ts';
import { instancesRoot, newId } from './paths.ts';
import { LOCK, readLock, releaseInstanceLock, withInstanceLockSync } from './lock.ts';
import { readRecord, readRecordResult, type InstanceRecord } from './records.ts';
import { DEFAULT_ISOLATION, parseIsolation } from './isolation.ts';
import { readActiveMap, requireInstance, writeActiveMap } from './catalog.ts';
import { nowIso } from './time.ts';
import { writeInstance } from './recordWrite.ts';
import { assertNameFree } from './validators.ts';

/**
 * 复制 / 改名 / 迁移：整个实例根的搬运与记录改写。
 * 从 index.ts 搬出来；不 import index.ts（避免循环），重名检查用 validators.ts 的 assertNameFree
 * （不经过 create.ts，避免为一个校验函数拖上整个建实例模块）。
 */

/** 复制一份实例：连 home 一起拷，得到可独立改的副本；端口与运行信息清空。 */
export async function cloneInstance(
  nameOrId: string,
  opts: { name: string; root?: string; activate?: boolean } = { name: '' },
): Promise<InstanceRecord> {
  const source = requireInstance(nameOrId);
  const name = opts.name.trim();
  if (!name) throw new PalError('invalid-input', '复制出来的实例要一个新名字');
  assertNameFree(name);
  if (source.pid && isPidAlive(source.pid)) {
    throw new PalError('already-running', `源实例还在运行：pid ${source.pid}`, {
      hint: '先停掉源实例再复制，拷一份正在写的 home 没有意义',
    });
  }
  const id = newId();
  const target = resolve(opts.root ?? join(instancesRoot(), id));
  if (existsSync(target)) {
    throw new PalError('root-occupied', '目标目录已存在', {
      hint: '换一个还没被占用的目录',
      details: { target },
    });
  }
  try {
    cpSync(source.root, target, { recursive: true, force: true, errorOnExist: false });
  } catch (err) {
    if (!source.managed) {
      throw new PalError('busy', `复制失败：${(err as Error).message}`, { cause: err });
    }
    throw err;
  }
  // 复制来的运行痕迹一律作废
  rmSync(join(target, 'logs'), { recursive: true, force: true });
  rmSync(join(target, LOCK), { force: true });
  rmSync(join(target, 'secrets.json'), { force: true });
  const record: InstanceRecord = {
    ...source,
    id,
    name,
    root: target,
    ...(source.home ? { home: source.home.replace(source.root, target) } : {}),
    // 复制体沿用源的隔离策略；源记录里缺这一段或写坏了就按默认来
    isolation: parseIsolation(source.isolation) ?? DEFAULT_ISOLATION,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'installed',
    // 目标目录是这里新建并拷贝出来的，删实例时整个根都归 PAL 管
    managed: true,
    // 复制体不是从 Pack 重建的：只记它从哪份实例拷来，绝不复用源的 pack 来源
    origin: { kind: 'copy', from: source.id },
    ports: [],
    restart: source.restart ?? 'never',
    maxRestarts: source.maxRestarts ?? 3,
  };
  delete record.pid;
  delete record.spawnPid;
  delete record.listenPid;
  delete record.port;
  delete record.url;
  // 入口也回到未启动状态：复制体没跑过，不知道下次用哪个入口
  delete record.entry;
  delete record.endpoint;
  delete record.exitCode;
  delete record.startedAt;
  delete record.lastExit;
  delete record.lastError;
  writeInstance(record);
  if (opts.activate) {
    const map = readActiveMap();
    map[record.harness] = record.id;
    writeActiveMap(map);
  }
  return record;
}

export function renameInstance(nameOrId: string, newName: string): InstanceRecord {
  const record = requireInstance(nameOrId);
  const name = newName.trim();
  if (!name) throw new PalError('invalid-input', '新名字不能为空');
  if (name === record.name) return record;
  // 重名检查与写记录必须在同一把锁里：并发 rename/remove/update 时，
  // 检查和落盘之间插进来的写会把名字或记录覆盖掉。
  return withInstanceLockSync(record.root, 'rename', () => {
    // 锁内重读：等锁期间记录可能已经被别的进程改过或删掉
    const current = readRecord(record.root);
    if (!current) {
      // 记录已经没了就不能拿旧内存写回去，否则等于把删掉的实例复活
      throw new PalError('unknown-instance', `这个实例已经不在了：${nameOrId}`);
    }
    if (current.name === name) return current;
    assertNameFree(name);
    writeInstance({ ...current, name });
    // 读回落盘结果，别把内存里的 draft 当事实
    return readRecord(record.root)!;
  });
}

/** 回滚迁移：把目录挪回原路径，并把记录改回旧 root。 */
function rollbackMigrate(
  record: InstanceRecord,
  target: string,
): { ok: boolean; scene: string; error?: string } {
  try {
    renameSync(target, record.root);
  } catch (err) {
    return {
      ok: false,
      scene: `目录没能挪回 ${record.root}，现场还在 ${target}`,
      error: (err as Error).message,
    };
  }
  // 目录已经回来了；如果记录已经写成新路径，再把它改回旧路径
  const current = readRecord(record.root);
  if (current && current.id === record.id && current.root === record.root) {
    return { ok: true, scene: record.root };
  }
  try {
    writeInstance(record);
    return { ok: true, scene: record.root };
  } catch (err) {
    return {
      ok: false,
      scene: `目录已挪回 ${record.root}，但记录仍指向 ${target}`,
      error: (err as Error).message,
    };
  }
}

export interface MigrateOptions {
  /** 测试用：替换 rename，模拟跨盘（抛 EXDEV）。生产路径不传。 */
  rename?: (from: string, to: string) => void;
  /** 测试用：跳过 rename，直接走复制路径。 */
  forceCopy?: boolean;
}

export interface MigrateResult {
  record: InstanceRecord;
  /** rename：同盘原子改名；copy：跨盘复制后落位。 */
  movedBy: 'rename' | 'copy';
}

function isCrossDevice(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'EXDEV';
}

/**
 * 把实例根从 from 挪到 to。同盘用 rename（原子、可回滚）；跨盘 rename 会报 EXDEV，
 * 这时先复制到目标盘的临时目录，再在同盘内 rename 成正式目录，最后删旧根。
 *
 * 复制不是原子的：中途失败只删临时目录，旧根不动；复制完落位失败也只删临时目录。
 * 真正的“切换”发生在写记录那一步——记录指向新根成功后，旧根才删。
 */
function moveRoot(from: string, to: string, opts: MigrateOptions): 'rename' | 'copy' {
  if (!opts.forceCopy) {
    try {
      (opts.rename ?? renameSync)(from, to);
      return 'rename';
    } catch (err) {
      if (!isCrossDevice(err)) {
        throw new PalError('busy', `挪不动这个实例根：${(err as Error).message}`, {
          hint: '目标目录可能被占用、权限不足，或父目录不可写；跨盘会自动复制',
          details: { root: from, target: to },
          cause: err,
        });
      }
    }
  }
  // 临时目录必须落在目标盘：复制完的 rename 是同盘操作，才能原子落位
  const staging = `${to}.pal-partial-${process.pid}-${Date.now().toString(36)}`;
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch {
    /* 残留临时目录删不掉时，下一次复制还会用新的名字 */
  }
  try {
    cpSync(from, staging, {
      recursive: true,
      force: true,
      errorOnExist: false,
      preserveTimestamps: true,
    });
  } catch (err) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* 清不掉临时目录不影响“旧实例没动”这个结论 */
    }
    throw new PalError('busy', `跨盘复制失败：${(err as Error).message}`, {
      hint: '旧实例没有动；检查目标盘剩余空间、权限，以及是否有文件被占用',
      details: { root: from, target: to },
      cause: err,
    });
  }
  try {
    renameSync(staging, to);
  } catch (err) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* 同上 */
    }
    throw new PalError('busy', `复制完成但落位失败：${(err as Error).message}`, {
      hint: '目标目录可能被别的进程占用；旧实例没有动',
      details: { root: from, target: to },
      cause: err,
    });
  }
  return 'copy';
}

/** 在实例锁里执行迁移：移动目录与写记录是一个整体；写记录失败就回滚目录。 */
function migrateLocked(
  record: InstanceRecord,
  target: string,
  owned: boolean,
  opts: MigrateOptions,
): MigrateResult {
  const mode = moveRoot(record.root, target, opts);

  try {
    const next: InstanceRecord = {
      ...record,
      root: target,
      ...(record.home ? { home: record.home.replace(record.root, target) } : {}),
    };
    writeInstance(next);
    // 不能静默：写记录返回后必须能从新根读回同一份记录
    const read = readRecordResult(target);
    if (!read.record) {
      throw new PalError('record-corrupt', `迁移后读不到新根的记录：${read.error ?? '没有 instance.json'}`, {
        hint: '写记录没有真正落盘，迁移会回滚',
        details: { root: record.root, target },
      });
    }
    // 锁文件跟着目录搬到了新根；只清我们这次迁移写进去的那一把
    const atTarget = readLock(target);
    if (owned && atTarget?.pid === process.pid && atTarget.op === 'migrate') {
      releaseInstanceLock(target);
    }
    // copy 模式：记录已经指向新根，旧根这时才删；删不掉就整次撤回，别留下两个根
    if (mode === 'copy') {
      try {
        rmSync(record.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (err) {
        try {
          rmSync(target, { recursive: true, force: true });
        } catch {
          /* 撤不掉新根时把现场写进 details */
        }
        // 旧根里的记录本来就还在；外部实例的 .links 可能已经被写向新根，写回旧记录把指针改回来
        try {
          writeInstance(record);
        } catch {
          /* 旧记录没坏；写回失败不影响“至少别两头都算数” */
        }
        throw new PalError('busy', '复制完成但旧根删不掉，迁移已撤回', {
          hint: '停掉可能正占用旧根的程序（宿主、编辑器、杀毒扫描）后重试',
          details: { root: record.root, target, reason: (err as Error).message },
          cause: err,
        });
      }
    }
    return { record: read.record, movedBy: mode };
  } catch (err) {
    if (mode === 'copy') {
      // 记录没切过去（或切了但读不回来）：撤掉新根，旧根与旧记录原样留着
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        /* 撤不掉新根时下面把现场写进 details */
      }
      throw err instanceof PalError
        ? err
        : new PalError('internal', '迁移写记录失败，已撤回新根', {
            hint: '旧实例还在原处，可以重试',
            details: { root: record.root, target, reason: (err as Error).message },
            cause: err,
          });
    }
    const rollback = rollbackMigrate(record, target);
    if (!rollback.ok) {
      if (owned) releaseInstanceLock(target);
      throw new PalError('internal', '迁移写记录失败，回滚也失败', {
        hint: '目录与记录可能已经不在同一处；先确认实例目录在旧根还是新根，再手工恢复',
        cause: err,
        details: {
          root: record.root,
          target,
          scene: rollback.scene,
          reason: (err as Error).message,
          ...(rollback.error ? { rollbackError: rollback.error } : {}),
        },
      });
    }
    throw new PalError(
      err instanceof PalError ? err.code : 'internal',
      '迁移写记录失败，已回滚',
      {
        hint: '实例根与记录都回到迁移前的位置，可以重试',
        cause: err,
        details: { root: record.root, target, reason: (err as Error).message },
      },
    );
  }
}

/** 把实例根整体挪到别处（换盘、整理目录），记录里的路径一起改。 */
export function migrateInstanceDetailed(
  nameOrId: string,
  to: string,
  opts: MigrateOptions = {},
): MigrateResult {
  const record = requireInstance(nameOrId);
  if (record.pid && isPidAlive(record.pid)) {
    throw new PalError('already-running', `实例还在运行：pid ${record.pid}`, { hint: '先停掉再迁移' });
  }
  const target = resolve(to);
  if (existsSync(target)) {
    throw new PalError('root-occupied', '目标已存在', {
      hint: '换一个还没被占用的目录',
      details: { target },
    });
  }
  mkdirSync(dirname(target), { recursive: true });
  return withInstanceLockSync(record.root, 'migrate', (owned) =>
    migrateLocked(record, target, owned, opts),
  );
}

/** 兼容旧调用：只要记录。跨盘复制与旧根残留的细节用 migrateInstanceDetailed。 */
export function migrateInstance(nameOrId: string, to: string): InstanceRecord {
  return migrateInstanceDetailed(nameOrId, to).record;
}
