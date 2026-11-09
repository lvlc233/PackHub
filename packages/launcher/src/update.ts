import { existsSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { planFor, type PackContext, type Plan } from '@packhub/kernel';
import { installPack, loadLock, loadPack, loadState, saveState, withLockPins } from '@packhub/runtime';
import { baselineFromState, hashFile, readBaseline, writeBaseline, type Baseline } from './baseline.ts';
import { withInstanceLock } from './lock.ts';
import { readRecord, type InstanceRecord } from './records.ts';
import { requireInstance } from './catalog.ts';
import { writeInstance } from './recordWrite.ts';
import { targetVarsFor } from './layout.ts';
import { PalError } from './errors.ts';
import { isPidAlive } from './process.ts';
import { fsProblem } from './create.ts';

/**
 * 更新与重新基准化：从 index.ts 搬出（C1）。
 * 依赖都是叶子模块，不 import index.ts，没有循环。
 */

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
  /**
   * 更新成功、但有非致命问题：目前只有「旧文件没删掉」。
   * 每条只带实例内相对路径与原因，不带绝对路径；文件会留在实例里。
   */
  warnings: string[];
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
 * 基线里被本地改过的文件：还在、且内容哈希与基线不一致。
 * 原来这里是 existsSync + createHash，改用 baseline.hashFile 的同一套哈希，语义不变
 * （文件不存在或不是普通文件，hashFile 返回 undefined，按“没改”处理）。
 */
function localChangesOf(
  root: string,
  baseline: Baseline | undefined,
  skip: Iterable<string> = [],
): string[] {
  if (!baseline) return [];
  const excluded = new Set(skip);
  return baseline.files
    .filter((file) => !excluded.has(file.path))
    .filter((file) => {
      const hashed = hashFile(resolve(root, file.path));
      return hashed ? hashed.sha256 !== file.sha256 : false;
    })
    .map((file) => file.path);
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
    throw new PalError('invalid-input', `清单有问题${detail ? `：${detail}` : ''}`, {
      hint: '确认 Pack 目录里有 packhub.yaml，且清单能被解析',
      details: { packDir: resolve(opts.packDir) },
    });
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
  const localChanges = localChangesOf(record.root, baseline);

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
  const warnings: string[] = [];

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
      } catch (err) {
        // 删不掉就留着，下次更新再说；但不能静默：告诉人哪个文件还在
        warnings.push(`旧文件没删掉：${rel}（${fsProblem(err)}）`);
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

  const localChangesAfter = localChangesOf(record.root, baseline, removedFiles);

  return {
    record: readRecord(record.root)!,
    from: `${record.pack.name}@${record.pack.version}`,
    to: `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`,
    changed,
    planHash: plan.planHash,
    removedFiles,
    addedFiles,
    localChanges: [...new Set([...localChanges, ...localChangesAfter])],
    warnings,
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
