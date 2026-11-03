import { join, resolve } from 'node:path';
import type { Issue, Manifest, Plan } from './types.ts';
import { loadManifest } from './manifest.ts';
import { validateGraph, type Graph } from './graph.ts';
import { buildPlan, DIR_TARGET_VARS, type PlanOptions } from './plan.ts';
import { buildLock } from './lock.ts';
import { applyPlan, loadState, type ApplyOptions, type ApplyResult } from './install.ts';
import { runChecks, type CheckResult } from './verify.ts';

export * from './types.ts';
export { parseSource, checkSource, isVolatilePin, type ParsedSource, type SourceKind } from './ref.ts';
export { loadManifest, parseManifest, type LoadResult } from './manifest.ts';
export { validateGraph, type Graph } from './graph.ts';
export { buildPlan, DIR_TARGET_VARS, type PlanOptions } from './plan.ts';
export { buildLock } from './lock.ts';
export {
  applyPlan,
  loadState,
  removePack,
  atomicWrite,
  type ApplyOptions,
  type ApplyResult,
  type RemoveResult,
  type ActionOutcome,
  type ActionStatus,
} from './install.ts';
export { download, resolveDownloadUrl, FetchError, type FetchResult } from './download.ts';
export { addResource, setBinding, inferId, type AddResourceInput, type AddResourceResult } from './authoring.ts';
export { diffActions, describeAction, type ActionDiff } from './diff.ts';
export { runChecks, type CheckResult, type CheckStatus, type VerifyOptions } from './verify.ts';
export { canonicalize, sha256, interpolate, deepMerge, isPlainObject } from './util.ts';

export interface PackContext {
  dir: string;
  manifest: Manifest;
  graph: Graph;
  issues: Issue[];
}

/** 读取并校验一个 Pack 目录。所有命令的入口。 */
export function loadPack(dir: string): PackContext {
  const abs = resolve(dir);
  const loaded = loadManifest(join(abs, 'packhub.yaml'));
  if (!loaded.manifest) {
    return { dir: abs, manifest: undefined as unknown as Manifest, graph: undefined as unknown as Graph, issues: loaded.issues };
  }
  const { graph, issues } = validateGraph(loaded.manifest);
  return { dir: abs, manifest: loaded.manifest, graph, issues: [...loaded.issues, ...issues] };
}

/** 解析 + 出计划（纯函数，不落盘）。 */
export function planFor(ctx: PackContext, opts: Partial<PlanOptions> = {}): { plan?: Plan; issues: Issue[] } {
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (errors.length) return { issues: errors };
  return buildPlan(ctx.manifest, ctx.graph, {
    target: opts.target ?? 'dir',
    targetVars: { ...DIR_TARGET_VARS, ...(opts.targetVars ?? {}) },
    packDir: ctx.dir,
  });
}

export function installPack(
  ctx: PackContext,
  plan: Plan,
  opts: Omit<ApplyOptions, 'root'> = {},
): Promise<ApplyResult> {
  return applyPlan(plan, { ...opts, root: ctx.dir });
}

export function verifyPack(dir: string, plan: Plan): CheckResult[] {
  return runChecks(plan.verify, { root: resolve(dir) });
}
