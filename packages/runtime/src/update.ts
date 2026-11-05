import { join } from 'node:path';
import { fetchPack } from './registry.ts';
import { loadPack, planFor, installPack, loadState, loadLock, withLockPins } from './index.ts';
import { pruneRemoved } from './install.ts';
import { diffActions, describeAction } from '@packhub/kernel';
import type { Plan } from '@packhub/kernel';

export interface UpdateOptions {
  name: string;
  index: string;
  projectDir: string;
  version?: string;
  target?: string;
  /** 允许覆盖别的包写过的普通文件 */
  overwrite?: boolean;
  /** 锁与清单对不上也继续（默认拒绝） */
  allowStaleLock?: boolean;
}

export interface UpdateResult {
  name: string;
  from: string | null;
  to: string;
  changed: boolean;
  planHash: string;
  added: string[];
  removed: string[];
  /** 升级时真正从磁盘清掉的旧产物 */
  pruned: string[];
  /** 无法安全撤销的项（留给人工确认） */
  warnings: string[];
}

/**
 * 取新版本、算差异、装上去。
 * 差异来自 state 里存的上一份计划快照，所以能说清「多了什么、少了什么」。
 */
export async function updatePack(opts: UpdateOptions): Promise<UpdateResult> {
  const dest = join(opts.projectDir, '.packhub/packs', opts.name);
  const fetched = await fetchPack({
    name: opts.name,
    index: opts.index,
    ...(opts.version ? { version: opts.version } : {}),
    dest,
  });

  const raw = loadPack(dest);
  const lock = loadLock(dest);
  const ctx = withLockPins(raw, lock);
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    throw new Error(`新版本清单有错：${errors.map((e) => e.message).join('; ')}`);
  }

  const state = loadState(opts.projectDir);
  const key = Object.keys(state.packs).find((k) => k.startsWith(`${opts.name}@`));
  const previous: Plan | undefined = key ? state.packs[key]?.plan : undefined;
  const previousActions = key ? state.packs[key]?.actions ?? [] : [];
  // 没显式指定 target 就沿用上次安装的，避免更新时把 claude-code 的投影换成 dir
  const target = opts.target ?? previous?.target ?? 'dir';
  if (!ctx.manifest.metadata.targets.includes(target as never)) {
    throw new Error(
      `这个包没有声明 target ${target}（声明：${ctx.manifest.metadata.targets.join(', ')}）`,
    );
  }

  const { plan, issues } = planFor(ctx, { target: target as never });
  if (!plan) throw new Error(`新版本生成不了计划：${issues.map((i) => i.message).join('; ')}`);

  if (lock?.plan) {
    const lockTarget = String(lock.plan.target ?? 'dir');
    const { plan: lockPlan } = planFor(ctx, { target: lockTarget as never });
    if (lockPlan && lockPlan.planHash !== lock.planHash && !opts.allowStaleLock) {
      throw new Error('新版本的锁与清单对不上（清单在锁定后被改过）；确认后用 --allow-stale-lock 继续');
    }
  }

  const before = previous?.actions ?? [];
  const diff = diffActions(before, plan.actions);
  const changed = !previous || previous.planHash !== plan.planHash;

  let pruned: string[] = [];
  let warnings: string[] = [];
  if (changed) {
    await installPack(ctx, plan, {
      root: opts.projectDir,
      packRoot: dest,
      overwrite: opts.overwrite === true,
    });
    // 新版本装完再清旧产物：先删后装会在中途失败时留下空档
    if (previous) {
      const result = pruneRemoved(opts.projectDir, previous, plan, previousActions);
      pruned = result.removed;
      warnings = result.warnings;
    }
  }

  return {
    name: opts.name,
    from: previous ? key ?? null : null,
    to: `${opts.name}@${fetched.version}`,
    changed,
    planHash: plan.planHash,
    added: diff.added.map(describeAction),
    removed: diff.removed.map(describeAction),
    pruned,
    warnings,
  };
}
