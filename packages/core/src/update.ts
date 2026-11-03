import { join } from 'node:path';
import { fetchPack } from './registry.ts';
import { loadPack, planFor, installPack, loadState } from './index.ts';
import { diffActions, describeAction } from './diff.ts';
import type { Plan } from './types.ts';

export interface UpdateOptions {
  name: string;
  index: string;
  projectDir: string;
  version?: string;
  target?: string;
  /** 允许覆盖别的包写过的普通文件 */
  overwrite?: boolean;
}

export interface UpdateResult {
  name: string;
  from: string | null;
  to: string;
  changed: boolean;
  planHash: string;
  added: string[];
  removed: string[];
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

  const ctx = loadPack(dest);
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    throw new Error(`新版本清单有错：${errors.map((e) => e.message).join('; ')}`);
  }
  const { plan, issues } = planFor(ctx, { target: (opts.target ?? 'dir') as never });
  if (!plan) throw new Error(`新版本生成不了计划：${issues.map((i) => i.message).join('; ')}`);

  const state = loadState(opts.projectDir);
  const key = Object.keys(state.packs).find((k) => k.startsWith(`${opts.name}@`));
  const previous: Plan | undefined = key ? state.packs[key]?.plan : undefined;

  const before = previous?.actions ?? [];
  const diff = diffActions(before, plan.actions);
  const changed = !previous || previous.planHash !== plan.planHash;

  if (changed) {
    await installPack(ctx, plan, {
      root: opts.projectDir,
      packRoot: dest,
      overwrite: opts.overwrite === true,
    });
  }

  return {
    name: opts.name,
    from: previous ? key ?? null : null,
    to: `${opts.name}@${fetched.version}`,
    changed,
    planHash: plan.planHash,
    added: diff.added.map(describeAction),
    removed: diff.removed.map(describeAction),
  };
}
