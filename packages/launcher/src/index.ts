import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { planFor, type PackContext, type Plan, type TargetId } from '@packhub/kernel';
import {
  installPack,
  loadLock,
  loadPack,
  loadState,
  saveState,
  withLockPins,
} from '@packhub/runtime';
import { targetVarsFor } from './layout.ts';
import { PalError } from './errors.ts';
import { isPidAlive } from './process.ts';
import { instancesRoot, newId, stamp } from './paths.ts';
import {
  baselineFromState,
  readBaseline,
  writeBaseline,
  type Baseline,
} from './baseline.ts';
import { LOCK, readLock, releaseInstanceLock, withInstanceLock, withInstanceLockSync } from './lock.ts';
import { readRecord, readRecordResult, recordFile, type InstanceRecord } from './records.ts';
import { listInstances, readActiveMap, requireInstance, writeActiveMap } from './catalog.ts';
import { nowIso } from './time.ts';
import { writeInstance } from './recordWrite.ts';
import { assertHarness, assertNameFree } from './create.ts';

// 锁与基线的实现搬到了 lock.ts / baseline.ts；这里继续按原名导出，调用方（start/server/cli/测试）不受影响
export { instanceLock, withInstanceLock } from './lock.ts';
export { BASELINE, readBaseline, writeBaseline } from './baseline.ts';
export { baselineFromState } from './baseline.ts';
export type { Baseline, BaselineFile } from './baseline.ts';
export { nowIso } from './time.ts';

// 记录的读写搬到了 records.ts；这里继续按原名导出，调用方（start/server/cli/测试）不受影响
export { API_VERSION, RECORD, readRecord, readRecordResult, recordFile } from './records.ts';
export type { InstanceRecord, InstanceStatus, RecordRead } from './records.ts';

// 写记录（带 .links 副作用）搬到了 recordWrite.ts；removeLink 只是内部用，不对外导出
export { writeInstance } from './recordWrite.ts';

// 隔离与失败现场搬到了 quarantine.ts；入口继续按原名导出（moveAside 原本就没导出，这里也不导出）
export { quarantineInstance, failInstance } from './quarantine.ts';

// 实例清单与「当前实例」一览表搬到了 catalog.ts；入口继续按原名导出（dropActive、safeFiles 只是包内用，不导出）
export {
  activeMapPath,
  listInstances,
  readActiveMap,
  readInstance,
  requireInstance,
  scanInstances,
  writeActiveMap,
} from './catalog.ts';
export type { InstanceScan } from './catalog.ts';

// 建实例与接管搬到了 create.ts；入口继续按原名导出（assertNameFree、assertHarness 只是包内共用，不对外导出）
export { adoptInstance, createInstance, seedHome } from './create.ts';
export type { AdoptOptions, CreateInstanceOptions } from './create.ts';

// 删除搬到了 remove.ts；入口继续按原名导出（removeTreeWithRetry 只是内部用，不导出）
export { removeInstance } from './remove.ts';
export type { RemoveOptions, RemoveResult } from './remove.ts';

/* ---------- 更新与重新基准化 ---------- */

export interface UpdateInstanceResult {
  record: InstanceRecord;
  from: string;
  to: string;
  changed: boolean;
  planHash: string;
  /** 上一版有、这一版不再需要的文件 */
  removedFiles: string[];
  addedFiles: string[];
  /** 上一版文件里被本地改过、更新会覆盖的（保护提示） */
  localChanges: string[];
}

function writtenOf(root: string, names: string[]): string[] {
  const state = loadState(root);
  const out = new Set<string>();
  for (const key of names) {
    for (const rel of state.packs[key]?.written ?? []) out.add(rel);
  }
  return [...out];
}

/** 计划会写到的路径：更新后据此判断上一版的哪些文件已经没人要了。 */
function planTargets(plan: Plan): Set<string> {
  const out = new Set<string>();
  for (const action of plan.actions) {
    if (
      action.op === 'write' ||
      action.op === 'link.skill' ||
      action.op === 'unpack' ||
      action.op === 'link.bin' ||
      action.op === 'state.dir'
    ) {
      out.add(action.to);
    } else if (action.op === 'instruction') {
      out.add(action.file);
    } else if (action.op === 'merge.config') {
      out.add(action.path);
    } else if (action.op === 'register.mcp') {
      out.add(action.path ?? '.packhub/config.json');
    }
  }
  return out;
}

/**
 * 把实例里的 Pack 换成另一个版本：先在同一个根上装新版，再清掉上一版独有的文件。
 * 要求实例已停：更新期间有进程在读这些文件，删了会留下半套。
 * 更新前先按基线算本地改动；计划确实会变（changed）且改动非空、又没给 force 就拒绝并抛
 * PalError，一个文件都不写。同版本重跑不写盘，也不拦。
 */
export async function updateInstance(
  nameOrId: string,
  opts: { packDir: string; packRef?: string; force?: boolean },
): Promise<UpdateInstanceResult> {
  const record = requireInstance(nameOrId);
  if (record.pid && isPidAlive(record.pid)) {
    throw new PalError('already-running', `实例还在运行，先停掉再更新：pid ${record.pid}`, {
      hint: 'pal stop <id>，更新完再 pal start',
    });
  }
  const harness = record.harness;
  const loaded = loadPack(resolve(opts.packDir));
  if (!loaded.manifest) {
    const detail = loaded.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ');
    throw new PalError('invalid-input', `清单有问题：${detail || opts.packDir}`);
  }
  const ctx: PackContext = withLockPins(loaded, loadLock(resolve(opts.packDir)));
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) throw new PalError('invalid-input', `清单有问题：${errors.map((i) => i.message).join('; ')}`);
  if (!ctx.manifest.metadata.targets.includes(harness)) {
    throw new PalError('invalid-input', `这个包没有声明 target ${harness}`);
  }
  if (ctx.manifest.metadata.name !== record.pack.name) {
    throw new PalError(
      'invalid-input',
      `这不是同一个 Pack：实例里是 ${record.pack.name}，新的是 ${ctx.manifest.metadata.name}`,
      { hint: '换 Pack 请新建实例，不要原地替换' },
    );
  }

  const targetVars = targetVarsFor(harness);
  const { plan, issues } = planFor(ctx, { target: harness, ...(targetVars ? { targetVars } : {}) });
  if (!plan) throw new PalError('invalid-input', `生成不了计划：${issues.map((i) => i.message).join('; ')}`);

  const before = loadState(record.root);
  const oldKeys = Object.keys(before.packs).filter((key) => key.startsWith(`${record.pack.name}@`));
  const oldWritten = writtenOf(record.root, oldKeys);
  const baseline = readBaseline(record.root);
  // 更新会覆盖 Pack 装过的文件，所以先看哪些已经被本地改过：改过的要提前告诉人
  const localChanges = baseline
    ? baseline.files
        .filter((file) => {
          try {
            const abs = resolve(record.root, file.path);
            return (
              existsSync(abs) &&
              createHash('sha256').update(readFileSync(abs)).digest('hex') !== file.sha256
            );
          } catch {
            return false;
          }
        })
        .map((file) => file.path)
    : [];

  const changed = record.planHash !== plan.planHash || record.pack.version !== ctx.manifest.metadata.version;

  // P0：计划真的会覆盖 Pack 装过的文件时，先停下来问人；--force / body.force 才继续。
  // 同版本重跑（changed=false）本来不写盘，不拦。
  if (changed && localChanges.length > 0 && !opts.force) {
    const shown = localChanges.slice(0, 5).join('、');
    const more = localChanges.length > 5 ? ` 等 ${localChanges.length} 个文件` : '';
    throw new PalError('invalid-input', `更新会覆盖本地改过的文件：${shown}${more}；确认覆盖请加 --force`, {
      hint: '先备份改动，或 pal rebaseline <id> 把当前内容认作基线；确实要覆盖就带 --force（API: body.force=true）',
      details: { localChanges },
    });
  }

  let removedFiles: string[] = [];
  let addedFiles: string[] = [];

  await withInstanceLock(record.root, 'update', async () => {
    if (!changed) return;
    // 同一 Pack 的新版本要能覆盖旧版本写过的文件；overwrite 只放开"自己的包"
    await installPack(ctx, plan, { root: record.root, packRoot: resolve(opts.packDir), overwrite: true });

    // install 已经把同名的旧 key 并进新 key、written 取并集；这里清掉新计划不再要的文件
    const targets = planTargets(plan);
    removedFiles = oldWritten.filter((rel) => !targets.has(rel));
    addedFiles = [...targets].filter((rel) => !oldWritten.includes(rel));
    for (const rel of removedFiles) {
      const abs = resolve(record.root, rel);
      if (!abs.startsWith(resolve(record.root))) continue;
      try {
        if (existsSync(abs) && statSync(abs).isFile()) rmSync(abs, { force: true });
      } catch {
        /* 删不掉就留着，下次更新再说 */
      }
    }

    const after = loadState(record.root);
    const key = Object.keys(after.packs).find((item) => item.startsWith(`${ctx.manifest.metadata.name}@`));
    const recordState = key ? after.packs[key] : undefined;
    if (recordState) {
      const stale = new Set(removedFiles);
      recordState.written = recordState.written.filter((rel) => !stale.has(rel));
    }
    saveState(record.root, after);

    writeBaseline(record.root, {
      pack: ctx.manifest.metadata.name,
      version: ctx.manifest.metadata.version,
      harness,
      planHash: plan.planHash,
      files: baselineFromState(record.root),
    });

    const next: InstanceRecord = {
      ...record,
      pack: {
        name: ctx.manifest.metadata.name,
        version: ctx.manifest.metadata.version,
        ...(opts.packRef ? { ref: opts.packRef } : record.pack.ref ? { ref: record.pack.ref } : {}),
      },
      planHash: plan.planHash,
      status: 'installed',
    };
    delete next.lastError;
    writeInstance(next);
  });

  const localChangesAfter = baseline
    ? baseline.files
        .filter((file) => !new Set(removedFiles).has(file.path))
        .filter((file) => {
          try {
            const abs = resolve(record.root, file.path);
            return existsSync(abs) && createHash('sha256').update(readFileSync(abs)).digest('hex') !== file.sha256;
          } catch {
            return false;
          }
        })
        .map((file) => file.path)
    : [];

  return {
    record: readRecord(record.root)!,
    from: `${record.pack.name}@${record.pack.version}`,
    to: `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`,
    changed,
    planHash: plan.planHash,
    removedFiles,
    addedFiles,
    localChanges: [...new Set([...localChanges, ...localChangesAfter])],
  };
}

/** 重新基准化：把当前磁盘状态认作基线（本地改动被"接受"，体检不再报漂移）。 */
export function rebaselineInstance(nameOrId: string): Baseline {
  const record = requireInstance(nameOrId);
  const baseline = readBaseline(record.root);
  // ignore 必须随 files 一起交给 writeBaseline：写盘后改返回值不会落进 baseline.json
  return writeBaseline(record.root, {
    pack: record.pack.name,
    version: record.pack.version,
    harness: record.harness,
    planHash: record.planHash,
    files: baselineFromState(record.root),
    ...(baseline?.ignore ? { ignore: baseline.ignore } : {}),
  });
}

/* ---------- 复制 / 改名 / 迁移 / 模板 ---------- */

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
    throw new PalError('root-occupied', `目标目录已存在：${target}`);
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
  delete record.port;
  delete record.url;
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

/** 在实例锁里执行迁移：rename 与写记录是一个整体，写记录失败就把目录挪回去。 */
function migrateLocked(record: InstanceRecord, target: string, owned: boolean): InstanceRecord {
  try {
    renameSync(record.root, target);
  } catch (err) {
    throw new PalError('busy', `挪不动这个实例根：${(err as Error).message}`, {
      hint: '跨盘时先手动复制再删；或换一个同盘目录',
      cause: err,
    });
  }

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
    return read.record;
  } catch (err) {
    const rollback = rollbackMigrate(record, target);
    if (!rollback.ok) {
      if (owned) releaseInstanceLock(target);
      throw new PalError('internal', `迁移写记录失败，回滚也失败；${rollback.scene}：${(err as Error).message}`, {
        hint: rollback.error,
        cause: err,
        details: { root: record.root, target },
      });
    }
    throw new PalError(
      err instanceof PalError ? err.code : 'internal',
      `迁移写记录失败，已回滚（目录回到 ${record.root}）：${(err as Error).message}`,
      { hint: '实例根与记录都回到迁移前的位置，可以重试', cause: err, details: { root: record.root, target } },
    );
  }
}

/** 把实例根整体挪到别处（换盘、整理目录），记录里的路径一起改。 */
export function migrateInstance(nameOrId: string, to: string): InstanceRecord {
  const record = requireInstance(nameOrId);
  if (record.pid && isPidAlive(record.pid)) {
    throw new PalError('already-running', `实例还在运行：pid ${record.pid}`, { hint: '先停掉再迁移' });
  }
  const target = resolve(to);
  if (existsSync(target)) {
    throw new PalError('root-occupied', `目标已存在：${target}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  return withInstanceLockSync(record.root, 'migrate', (owned) => migrateLocked(record, target, owned));
}

export interface InstanceTemplate {
  apiVersion: 'packhub.dev/instance-template/v0';
  name: string;
  harness: TargetId;
  pack: { name: string; version: string; ref?: string };
  origin?: InstanceRecord['origin'];
  createdAt: string;
  /** 接管来的实例没有可复现的来源，导出时明确写出来 */
  reproducible: boolean;
  note?: string;
}

export function exportTemplate(nameOrId: string): InstanceTemplate {
  const record = requireInstance(nameOrId);
  const reproducible = record.origin?.kind === 'pack' && Boolean(record.origin.ref);
  return {
    apiVersion: 'packhub.dev/instance-template/v0',
    name: record.name,
    harness: record.harness,
    pack: record.pack,
    ...(record.origin ? { origin: record.origin } : {}),
    createdAt: nowIso(),
    reproducible,
    ...(reproducible
      ? {}
      : { note: '这份实例不是用 Pack 引用建的，导出的模板只能记录它是什么，不能复原内容' }),
  };
}

export function writeTemplate(template: InstanceTemplate, file: string): string {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(resolve(file), JSON.stringify(template, null, 2) + '\n', 'utf8');
  return resolve(file);
}

export function readTemplate(file: string): InstanceTemplate {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new PalError('not-found', `没有这个模板文件：${abs}`);
  let data: InstanceTemplate;
  try {
    data = JSON.parse(readFileSync(abs, 'utf8')) as InstanceTemplate;
  } catch (err) {
    throw new PalError('invalid-input', `模板读不了：${(err as Error).message}`, { cause: err });
  }
  if (data?.apiVersion !== 'packhub.dev/instance-template/v0') {
    throw new PalError('invalid-input', '不是 PAL 实例模板（apiVersion 不对）');
  }
  if (!data.reproducible) {
    throw new PalError('invalid-input', `这份模板不可复现：${data.note ?? '没有来源引用'}`, {
      hint: '从 Pack registry 或 .phub / git+ 引用建的实例才能导出可复现模板',
    });
  }
  return data;
}
