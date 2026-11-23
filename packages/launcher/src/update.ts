import { join, resolve, sep } from 'node:path';
import { MANIFEST_FILE, actionOutputs, actionUndo, type OwnedPath, type PackContext, type PlanSnapshot } from '@packhub/kernel';
import {
  installPack,
  loadLock,
  loadPack,
  loadState,
  ownedLabel,
  planOutputs,
  pruneRemoved,
  resolveOwnedPath,
  withLockPins,
} from '@packhub/runtime';
import { requireAdapter } from './layout.ts';
import { baselineFromState, hashFile, readBaseline, writeBaseline, type Baseline } from './baseline.ts';
import { withInstanceLock } from './lock.ts';
import { readRecord, type InstanceRecord } from './records.ts';
import { requireInstance } from './catalog.ts';
import { writeInstance } from './recordWrite.ts';
import { PalError } from './errors.ts';
import { isPidAlive } from './process.ts';
import { packIdentityFromState, planForHome } from './create.ts';
import { assertProfileName, assertProfileTarget } from './validators.ts';

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
   * 更新成功、但有非致命问题：旧文件没删掉、共享配置退回整份重写、
   * 或旧 state 没有计划快照因而跳过清理。
   * 每条只带实例内相对路径与原因，不带绝对路径；文件会留在实例里。
   */
  warnings: string[];
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

/** 同一物理路径只留一条（base 不同但解析结果相同的旧记录合并）。 */
function dedupeByAbs(root: string, home: string | undefined, items: readonly OwnedPath[]): OwnedPath[] {
  const seen = new Set<string>();
  const out: OwnedPath[] = [];
  for (const item of items) {
    const abs = resolveOwnedPath(root, home, item);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(item);
  }
  return out;
}

/**
 * 上一版安装留下的计划快照（`state.packs[key].plan`）。
 *
 * update 的旧产物清理走 runtime 的 `pruneRemoved(root, previous, next)`：共享配置按 key / 块摘、
 * 私有文件整份删。没有快照就什么都删不了——这时不退回「按 written 整文件 rm」（那会连
 * `.claude.json` / `cordis.patch.yml` 里用户自己的条目一起带走），只报一条 warning 跳过清理。
 * 同名各代 key 理论上只会有一个；多个旧 key 都有快照时把 actions 并起来用。
 */
function previousSnapshotOf(
  state: ReturnType<typeof loadState>,
  packName: string,
): PlanSnapshot | undefined {
  const plans = Object.keys(state.packs)
    .filter((key) => key.startsWith(`${packName}@`))
    .map((key) => state.packs[key]?.plan)
    .filter((plan): plan is PlanSnapshot => plan !== undefined);
  if (plans.length === 0) return undefined;
  if (plans.length === 1) return plans[0]!;
  return {
    ...(plans[0]!.harness ? { harness: plans[0]!.harness } : {}),
    planHash: plans.map((plan) => plan.planHash).join('+'),
    actions: plans.flatMap((plan) => plan.actions),
    verify: plans.flatMap((plan) => plan.verify),
    excluded: plans.flatMap((plan) => plan.excluded),
  };
}

/** 一组产物解析成绝对路径（去重）；路径基准按计划 / state 各自带的来。 */
function outputAbsOf(
  root: string,
  home: string | undefined,
  items: readonly OwnedPath[],
): string[] {
  return [...new Set(items.map((item) => resolveOwnedPath(root, home, item)))];
}

/**
 * 把实例里的 Pack 换成另一个版本：先在同一个根上装新版，再清掉上一版独有的文件。
 * 要求实例已停：更新期间有进程在读这些文件，删了会留下半套。
 * 更新前先按基线算本地改动；计划确实会变（changed）且改动非空、又没给 force 就拒绝并抛
 * PalError，一个文件都不写。同版本重跑不写盘，也不拦。
 */
export async function updateInstance(
  nameOrId: string,
  opts: { packDir: string; packRef?: string; force?: boolean; profile?: string },
): Promise<UpdateInstanceResult> {
  const record = requireInstance(nameOrId);
  if (record.pid && isPidAlive(record.pid)) {
    throw new PalError('already-running', `实例还在运行，先停掉再更新：pid ${record.pid}`, {
      hint: 'pal stop <id>，更新完再 pal start',
    });
  }
  const kind = record.harness;
  // 显式给的 profile 先校验；没给就沿用记录里的（缺省不写 = all）。
  // update 只按记录里的 profile 重装；换 profile 是改变安装范围，走 uninstall + install。
  const explicitProfile = opts.profile === undefined ? undefined : assertProfileName(opts.profile);
  if (explicitProfile !== undefined) {
    assertProfileTarget(kind, record.attached === true);
    if (record.profile !== explicitProfile) {
      const installed = record.profile ? `profile「${record.profile}」` : 'all（所有已有 profile）';
      throw new PalError(
        'invalid-input',
        `这个 home 是按 ${installed} 装的，update 不能改成「${explicitProfile}」`,
        {
          hint:
            `换 profile 先 pal uninstall --home ${record.name} 再 pal install ... --profile ${explicitProfile}；` +
            'update 只按记录里的 profile 重装',
        },
      );
    }
  }
  const profile = explicitProfile ?? record.profile;
  const loaded = loadPack(resolve(opts.packDir));
  if (!loaded.manifest) {
    const detail = loaded.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ');
    throw new PalError('invalid-input', `清单有问题${detail ? `：${detail}` : ''}`, {
      hint: `确认 Pack 目录里有 ${MANIFEST_FILE}，且清单能被解析`,
      details: { packDir: resolve(opts.packDir) },
    });
  }
  const read = loadLock(resolve(opts.packDir));
  if (read.problem) throw new PalError('invalid-input', read.problem.message);
  const ctx: PackContext = withLockPins(loaded, read.lock);
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) throw new PalError('invalid-input', `清单有问题：${errors.map((i) => i.message).join('; ')}`);
  if (ctx.manifest.metadata.name !== record.pack.name) {
    throw new PalError(
      'invalid-input',
      `这不是同一个 Pack：实例里是 ${record.pack.name}，新的是 ${ctx.manifest.metadata.name}`,
      { hint: '换 Pack 请新建实例，不要原地替换' },
    );
  }

  // attached home 用宿主已验证的全局落点；managed 用实例根里的 home 段。
  // profile 沿用记录里的选择（或这次的 --profile）：重算计划时只装那一个。
  const { plan, issues } = planForHome(
    ctx,
    kind,
    record.attached === true
      ? { attachedHome: record.root, ...(profile ? { profile } : {}) }
      : { root: record.root },
  );
  if (!plan) throw new PalError('invalid-input', `生成不了计划：${issues.map((i) => i.message).join('; ')}`);

  const before = loadState(record.root);
  const oldKeys = Object.keys(before.packs).filter((key) => key.startsWith(`${record.pack.name}@`));
  // attached 的 home 就是记录根；managed 是根里的 home 段（base: home / absolute 的落点按它解析）
  const adapter = requireAdapter(kind);
  const home =
    record.home ??
    (record.attached === true
      ? record.root
      : adapter.homeDir
        ? join(record.root, adapter.homeDir)
        : undefined);
  // 上一版写过哪些文件：同名各代 key 取并集（install 升级时也把同名旧 key 并进新 key）
  const oldWritten = dedupeByAbs(
    record.root,
    home,
    oldKeys.flatMap((key) => before.packs[key]?.written ?? []),
  );
  // 旧产物清理的唯一依据：state 里这一版的计划快照。没有快照的旧 state 只报 warning，
  // 不回退成「按 written 整文件删」——共享配置里的用户条目就是这么被误删的。
  const previous = previousSnapshotOf(before, record.pack.name);
  const baseline = readBaseline(record.root);
  // 更新会覆盖 Pack 装过的文件，所以先看哪些已经被本地改过：改过的要提前告诉人
  const localChanges = localChangesOf(record.root, baseline);

  // 计划是否变过以 baseline 为准（instance.json 不再存 planHash）；没有 baseline 视为变了
  const changed = baseline?.planHash !== plan.planHash || record.pack.version !== ctx.manifest.metadata.version;

  // P0：计划真的会覆盖 Pack 装过的文件时，先停下来问人；--force / body.force 才继续。
  // 同版本重跑（changed=false）本来不写盘，不拦。
  if (changed && localChanges.length > 0 && !opts.force) {
    const shown = localChanges.slice(0, 5).join('、');
    const more = localChanges.length > 5 ? ` 等 ${localChanges.length} 个文件` : '';
    throw new PalError('invalid-input', `更新会覆盖本地改过的文件：${shown}${more}；确认覆盖请加 --force`, {
      hint: '先备份改动，或 pal verify --home <home> --accept 把当前内容认作基线；确实要覆盖就带 --force（API: body.force=true）',
      details: { localChanges },
    });
  }

  let removedFiles: string[] = [];
  let addedFiles: string[] = [];
  const warnings: string[] = [];

  await withInstanceLock(record.root, 'update', async () => {
    if (!changed) return;
    // 同一 Pack 的新版本要能覆盖旧版本写过的文件；overwrite 只放开"自己的包"
    await installPack(ctx, plan, {
      root: record.root,
      packRoot: resolve(opts.packDir),
      overwrite: true,
      ...(home ? { home } : {}),
    });

    // 旧产物清理交给 runtime：私有的整份删、共享配置按 key / 块摘，用户自己的条目留下。
    // 报告由计划输出推导：removedFiles = 上一版产物里这一版不再产出的（删除失败的也报，
    // 与之前的行为一致）；addedFiles = 这一版新增的产物。
    const produced = outputAbsOf(record.root, home, planOutputs(plan));
    const oldProduced = previous ? outputAbsOf(record.root, home, planOutputs(previous)) : [];
    // 可移除的旧产物：撤销方式是 `none` 的动作（exec / state.dir / delete）本来就不清
    const oldRemovable = previous
      ? outputAbsOf(
          record.root,
          home,
          previous.actions
            .filter((action) => actionUndo(action) !== 'none')
            .flatMap((action) => actionOutputs(action, previous)),
        )
      : [];
    const stillProduced = (abs: string): boolean =>
      produced.some((p) => p === abs || abs.startsWith(`${p}${sep}`) || p.startsWith(`${abs}${sep}`));
    if (previous) {
      const pruned = pruneRemoved(record.root, previous, plan);
      removedFiles = oldRemovable
        .filter((abs) => !stillProduced(abs))
        .map((abs) => ownedLabel(record.root, abs));
      warnings.push(...pruned.warnings);
    } else {
      warnings.push('旧 state 没有计划快照，跳过旧文件清理；重装一次可恢复完整清理');
    }
    // 「新增」按计划产物比对：旧 plan 的产物 + 旧 written（旧 state 没有快照时只能看 written）
    const oldKnown = new Set([...oldProduced, ...outputAbsOf(record.root, home, oldWritten)]);
    addedFiles = produced.filter((abs) => !oldKnown.has(abs)).map((abs) => ownedLabel(record.root, abs));

    // 身份跟 create 一样只认 state：装完恰好一个 Pack 时以它为准，记录里的漂移在这里被纠正；
    // state 读不出来（0/多个/损坏）才退回清单里的名字版本。
    const pack = packIdentityFromState(record.root, {
      name: ctx.manifest.metadata.name,
      version: ctx.manifest.metadata.version,
    });

    writeBaseline(record.root, {
      pack: pack.name,
      version: pack.version,
      harness: kind,
      planHash: plan.planHash,
      files: baselineFromState(record.root),
    });

    const next: InstanceRecord = {
      ...record,
      pack: {
        ...pack,
        ...(opts.packRef ? { ref: opts.packRef } : record.pack.ref ? { ref: record.pack.ref } : {}),
      },
      status: 'installed',
      ...(profile ? { profile } : {}),
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
    // 记录里不再存 planHash：重基准化只刷新文件清单，计划哈希沿用已有 baseline
    planHash: baseline?.planHash ?? '',
    files: baselineFromState(record.root),
    ...(baseline?.ignore ? { ignore: baseline.ignore } : {}),
  });
}
