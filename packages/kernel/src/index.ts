// index.ts	入口与合并

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Issue, Manifest, Plan } from './types.ts';
import { TARGET_IDS } from './types.ts';
import { loadManifest } from './manifest.ts';
import { MANIFEST_FILE, STATE_DIR } from './files.ts';
import { validateGraph, type Graph } from './graph.ts';
import { buildPlan, type PlanOptions } from './plan.ts';
import { TARGET_VARS } from './targets.ts';
import { ISSUE_CODES } from './issueCodes.ts';

export * from './types.ts';
export { MANIFEST_FILE, LOCK_FILE, STATE_DIR, STATE_FILE } from './files.ts';
export { PACKHUB_ENV } from './env.ts';
export { ISSUE_CODES, type IssueCode } from './issueCodes.ts';
export { parseSource, checkSource, isVolatilePin, type ParsedSource, type SourceKind } from './ref.ts';
export {
  loadManifest,
  parseManifest,
  PACK_NAME_PATTERN,
  PACK_VERSION_PATTERN,
  type LoadResult,
} from './manifest.ts';
export { validateGraph, type Graph, type GraphEdge } from './graph.ts';
export {
  CAPABILITY_FORMS,
  CAPABILITY_TOKEN_PATTERN,
  isCapabilityToken,
  parseCapabilityToken,
  type CapabilityForm,
  type ParsedCapability,
} from './capability.ts';
export {
  describeComposition,
  type Composition,
  type CompositionContext,
} from './composition.ts';
export {
  RESOURCE_KINDS,
  buildMcpSpec,
  type InstalledResource,
  type KindContext,
  type ResourceKind,
} from './kinds.ts';
export { buildPlan, type PlanOptions } from './plan.ts';
export { DIR_TARGET_VARS, TARGET_VARS, type TargetVars } from './targets.ts';
export { buildLock, contentHashOf } from './lock.ts';
export {
  PLAN_OPS,
  CODEX_SKILL_YAML,
  actionFromBase,
  actionInputs,
  actionIsShared,
  actionPaths,
  actionRetainWarning,
  actionUndo,
  actionUndoPayload,
  actionWritten,
  execWrapperPath,
  planPathsOf,
  type PlanOpFromBase,
  type PlanOpName,
  type PlanOpSpec,
  type PlanOpUndo,
  type PlanOpUndoPayload,
  type PlanShape,
} from './plan-ops.ts';
export {
  checkLockConsistency,
  type LockConsistency,
  type LockConsistencyStatus,
} from './lockConsistency.ts';
export {
  RESOURCES_API_VERSION,
  parseCatalog,
  searchResources,
  type CatalogEntry,
  type ResourceCatalog,
  type CatalogHit,
} from './catalog.ts';
export { diffActions, describeAction, type ActionDiff } from './diff.ts';
export { canonicalize, sha256, interpolate, deepMerge, isPlainObject, quoteArg } from './util.ts';

export interface PackContext {
  dir: string;
  manifest: Manifest;
  graph: Graph;
  issues: Issue[];
}

/** 读取并校验一个 Pack 目录。所有命令的入口。只读，不写盘、不出网。 */
export function loadPack(dir: string): PackContext {
  const abs = resolve(dir);
  const loaded = loadManifest(join(abs, MANIFEST_FILE));
  if (!loaded.manifest) {
    return {
      dir: abs,
      manifest: undefined as unknown as Manifest,
      graph: undefined as unknown as Graph,
      issues: loaded.issues,
    };
  }

  let manifest = loaded.manifest;
  const inherited: Issue[] = [];

  // 项目级本地覆盖：不进清单、不进锁，只改这次安装的参数
  const localFile = join(abs, STATE_DIR, 'local.yaml');
  if (existsSync(localFile)) {
    try {
      const { manifest: merged, issues: localIssues } = mergeLocalOverrides(
        manifest,
        parseLocalOverrides(localFile),
      );
      manifest = merged;
      inherited.push(...localIssues);
    } catch (err) {
      inherited.push({
        code: ISSUE_CODES.localOverrides,
        severity: 'error',
        message: `${STATE_DIR}/local.yaml 不是合法 YAML：${(err as Error).message}`,
      });
    }
  }

  const { graph, issues } = validateGraph(manifest);
  return { dir: abs, manifest, graph, issues: [...loaded.issues, ...inherited, ...issues] };
}

export interface LocalOverrides {
  modify?: Manifest['modify'];
  vars?: Record<string, string | number | boolean>;
}

function parseLocalOverrides(file: string): LocalOverrides {
  return (parseYaml(readFileSync(file, 'utf8')) ?? {}) as LocalOverrides;
}

/** 读项目根的 `.packhub/local.yaml`；不存在就返回 undefined。 */
export function readLocalOverrides(root: string): { file?: LocalOverrides; issues: Issue[] } {
  const file = join(resolve(root), STATE_DIR, 'local.yaml');
  if (!existsSync(file)) return { issues: [] };
  try {
    return { file: parseLocalOverrides(file), issues: [] };
  } catch (err) {
    return {
      issues: [{ code: ISSUE_CODES.localOverrides, severity: 'error', message: `读不了 ${file}：${(err as Error).message}` }],
    };
  }
}

/** 把 .packhub/local.yaml 合并进清单：只允许覆盖参数，不允许改包身份。 */
export function mergeLocalOverrides(
  manifest: Manifest,
  raw: LocalOverrides,
): { manifest: Manifest; issues: Issue[] } {
  const issues: Issue[] = [];
  if (!raw || typeof raw !== 'object') {
    issues.push({ code: ISSUE_CODES.localOverrides, severity: 'error', message: `${STATE_DIR}/local.yaml 不是一个对象` });
    return { manifest, issues };
  }
  const modify = Array.isArray(raw.modify) ? raw.modify : [];
  for (const [i, m] of modify.entries()) {
    if (!m?.resource) {
      issues.push({ code: ISSUE_CODES.localOverrides, severity: 'error', message: `local.yaml 的 modify[${i}] 缺少 resource` });
    }
  }
  return {
    manifest: {
      ...manifest,
      modify: [...(manifest.modify ?? []), ...modify],
      vars: { ...(manifest.vars ?? {}), ...(raw.vars ?? {}) },
    },
    issues,
  };
}


/** 解析 + 出计划（只读：会读 modify 补丁的文件，但不落盘）。 */
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
          code: ISSUE_CODES.unknownTarget,
          severity: 'error',
          message: `未知 target：${target}（可选 ${TARGET_IDS.join(' / ')}）`,
        },
      ],
    };
  }
  const built = buildPlan(ctx.manifest, ctx.graph, {
    target,
    // 默认落点由 buildPlan 按 target 选（TARGET_VARS）；这里只传显式覆盖
    targetVars: { ...(opts.targetVars ?? {}) },
    packDir: ctx.dir,
    // 平台在这里默认成宿主机；buildPlan 自己不读 process（测试可注入别的平台）
    platform: opts.platform ?? `${process.platform}-${process.arch}`,
    // 这个选项在 buildPlan 里支持，planFor 以前把它丢了：全局同步会多写配置并重复登记 MCP
    ...(opts.skipResourceTypes ? { skipResourceTypes: opts.skipResourceTypes } : {}),
  });
  return { plan: built.plan, issues: built.issues };
}
