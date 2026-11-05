import { join, resolve } from 'node:path';
import type { Issue, Manifest, Plan } from './types.ts';
import { loadManifest } from './manifest.ts';
import { validateGraph, type Graph } from './graph.ts';
import { buildPlan, TARGET_VARS, type PlanOptions } from './plan.ts';

export * from './types.ts';
export { parseSource, checkSource, isVolatilePin, type ParsedSource, type SourceKind } from './ref.ts';
export { loadManifest, parseManifest, type LoadResult } from './manifest.ts';
export { validateGraph, type Graph } from './graph.ts';
export { buildPlan, DIR_TARGET_VARS, TARGET_VARS, type PlanOptions } from './plan.ts';
export { buildLock } from './lock.ts';
export { diffActions, describeAction, type ActionDiff } from './diff.ts';
export { canonicalize, sha256, interpolate, deepMerge, isPlainObject } from './util.ts';

export interface PackContext {
  dir: string;
  manifest: Manifest;
  graph: Graph;
  issues: Issue[];
}

/** 读取并校验一个 Pack 目录。所有命令的入口。只读，不写盘、不出网。 */
export function loadPack(dir: string): PackContext {
  const abs = resolve(dir);
  const loaded = loadManifest(join(abs, 'packhub.yaml'));
  if (!loaded.manifest) {
    return {
      dir: abs,
      manifest: undefined as unknown as Manifest,
      graph: undefined as unknown as Graph,
      issues: loaded.issues,
    };
  }
  const { graph, issues } = validateGraph(loaded.manifest);
  return { dir: abs, manifest: loaded.manifest, graph, issues: [...loaded.issues, ...issues] };
}

/** 解析 + 出计划（只读：会读 overrides/overlays 的文件，但不落盘）。 */
export function planFor(
  ctx: PackContext,
  opts: Partial<PlanOptions> = {},
): { plan?: Plan; issues: Issue[] } {
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (errors.length) return { issues: errors };
  const target = opts.target ?? 'dir';
  if (!(target in TARGET_VARS)) {
    return {
      issues: [
        {
          code: 'unknown-target',
          severity: 'error',
          message: `未知 target：${target}（可选 dir / dsh / claude-code）`,
        },
      ],
    };
  }
  return buildPlan(ctx.manifest, ctx.graph, {
    target,
    // 默认落点由 buildPlan 按 target 选（TARGET_VARS）；这里只传显式覆盖
    targetVars: { ...(opts.targetVars ?? {}) },
    packDir: ctx.dir,
  });
}
