import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Issue, Manifest, Plan, ResourceSpec } from './types.ts';
import { loadManifest } from './manifest.ts';
import { validateGraph, type Graph } from './graph.ts';
import { buildPlan, TARGET_VARS, type PlanOptions } from './plan.ts';

export * from './types.ts';
export { parseSource, checkSource, isVolatilePin, type ParsedSource, type SourceKind } from './ref.ts';
export { loadManifest, parseManifest, type LoadResult } from './manifest.ts';
export { validateGraph, type Graph } from './graph.ts';
export { buildPlan, DIR_TARGET_VARS, TARGET_VARS, type PlanOptions } from './plan.ts';
export { buildLock } from './lock.ts';
export {
  parseCatalog,
  searchResources,
  type CatalogEntry,
  type ResourceCatalog,
  type CatalogHit,
} from './catalog.ts';
export { diffActions, describeAction, type ActionDiff } from './diff.ts';
export { canonicalize, sha256, interpolate, deepMerge, isPlainObject } from './util.ts';

export interface PackContext {
  dir: string;
  manifest: Manifest;
  graph: Graph;
  issues: Issue[];
}

/** 读取并校验一个 Pack 目录。所有命令的入口。只读，不写盘、不出网。 */
export function loadPack(dir: string, opts: { seen?: string[] } = {}): PackContext {
  const abs = resolve(dir);
  const seen = opts.seen ?? [];
  if (seen.includes(abs)) {
    const loaded = loadManifest(join(abs, 'packhub.yaml'));
    return {
      dir: abs,
      manifest: undefined as unknown as Manifest,
      graph: undefined as unknown as Graph,
      issues: [
        ...loaded.issues,
        {
          code: 'extends-cycle',
          severity: 'error',
          message: `extends 成环：${[...seen, abs].join(' → ')}`,
        },
      ],
    };
  }
  const loaded = loadManifest(join(abs, 'packhub.yaml'));
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
  if (manifest.extends) {
    const spec = manifest.extends;
    if (spec.startsWith('packhub://')) {
      // 远程父包需要 registry，kernel 不出网；由 runtime 的 loadPackResolved 展开
    } else if (!spec.startsWith('./') && !spec.startsWith('../')) {
      inherited.push({
        code: 'extends-invalid',
        severity: 'error',
        message: `extends 只支持 ./、../ 或 packhub://：${spec}`,
      });
    } else {
      const parentDir = resolve(abs, spec);
      if (!existsSync(join(parentDir, 'packhub.yaml'))) {
        inherited.push({
          code: 'extends-missing',
          severity: 'error',
          message: `extends 指向的父 Pack 不存在：${spec}`,
        });
      } else {
        const parent = loadPack(parentDir, { seen: [...seen, abs] });
        const parentErrors = parent.issues.filter((i) => i.severity === 'error');
        if (!parent.manifest || parentErrors.length > 0) {
          inherited.push({
            code: 'extends-invalid',
            severity: 'error',
            message: `父 Pack（${spec}）不合法：${parentErrors.map((i) => i.message).join('; ')}`,
          });
        } else {
          manifest = mergeManifest(parent.manifest, loaded.manifest, parentDir, abs);
        }
      }
    }
  }

  // 项目级本地覆盖：不进清单、不进锁，只改这次安装的参数
  const localFile = join(abs, '.packhub', 'local.yaml');
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
        code: 'local-overrides',
        severity: 'error',
        message: `.packhub/local.yaml 不是合法 YAML：${(err as Error).message}`,
      });
    }
  }

  const { graph, issues } = validateGraph(manifest);
  return { dir: abs, manifest, graph, issues: [...loaded.issues, ...inherited, ...issues] };
}

export interface LocalOverrides {
  overrides?: Manifest['overrides'];
  bindings?: Record<string, string>;
  paths?: Record<string, string>;
  vars?: Record<string, string | number | boolean>;
  composition?: { env?: Record<string, string | number | boolean> };
}

function parseLocalOverrides(file: string): LocalOverrides {
  return (parseYaml(readFileSync(file, 'utf8')) ?? {}) as LocalOverrides;
}

/** 读项目根的 `.packhub/local.yaml`；不存在就返回 undefined。 */
export function readLocalOverrides(root: string): { overrides?: LocalOverrides; issues: Issue[] } {
  const file = join(resolve(root), '.packhub', 'local.yaml');
  if (!existsSync(file)) return { issues: [] };
  try {
    return { overrides: parseLocalOverrides(file), issues: [] };
  } catch (err) {
    return {
      issues: [{ code: 'local-overrides', severity: 'error', message: `读不了 ${file}：${(err as Error).message}` }],
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
    issues.push({ code: 'local-overrides', severity: 'error', message: '.packhub/local.yaml 不是一个对象' });
    return { manifest, issues };
  }
  const overrides = Array.isArray(raw.overrides) ? raw.overrides : [];
  for (const ov of overrides) {
    if (!ov?.resource) {
      issues.push({ code: 'local-overrides', severity: 'error', message: 'local.yaml 的 overrides 缺少 resource' });
    }
  }
  return {
    manifest: {
      ...manifest,
      overrides: [...(manifest.overrides ?? []), ...overrides],
      bindings: { ...(manifest.bindings ?? {}), ...(raw.bindings ?? {}) },
      paths: { ...(manifest.paths ?? {}), ...(raw.paths ?? {}) },
      vars: { ...(manifest.vars ?? {}), ...(raw.vars ?? {}) },
      composition: {
        ...(manifest.composition ?? {}),
        env: { ...(manifest.composition?.env ?? {}), ...(raw.composition?.env ?? {}) },
      },
    },
    issues,
  };
}

/** 父 Pack 的本地资源改写成相对子 Pack 的路径，子包才能用自己的 packRoot 读。 */
function rebaseLocal(source: string, fromDir: string, toDir: string): string {
  if (!source.startsWith('./') && !source.startsWith('../')) return source;
  const rel = relative(toDir, resolve(fromDir, source)).split(sep).join('/');
  if (rel.startsWith('../')) return rel;
  return `./${rel.replace(/^\.\//, '')}`;
}

/**
 * extends 合并规则：子包同名资源覆盖父包；metadata 与 requires 以子包为准；
 * composition.env / slots / bindings / paths 两边合并；resources / verify 保留父包在前。
 */
export function mergeManifest(
  base: Manifest,
  child: Manifest,
  baseDir: string,
  childDir: string,
): Manifest {
  const resources: ResourceSpec[] = [];
  const byId = new Map<string, ResourceSpec>();
  const push = (res: ResourceSpec, fromDir: string): void => {
    // 父包资源相对父包目录；子包资源保持原样
    const normalized =
      fromDir !== childDir && (res.source.startsWith('./') || res.source.startsWith('../'))
        ? { ...res, source: rebaseLocal(res.source, fromDir, childDir) }
        : res;
    const hit = byId.get(normalized.id);
    if (hit) {
      const index = resources.indexOf(hit);
      resources[index] = normalized;
    } else {
      resources.push(normalized);
    }
    byId.set(normalized.id, normalized);
  };
  for (const res of base.resources) push(res, baseDir);
  for (const res of child.resources) push(res, childDir);

  const mergeEnv = { ...(base.composition?.env ?? {}), ...(child.composition?.env ?? {}) };
  const order = [
    ...new Set([...(base.composition?.order ?? []), ...(child.composition?.order ?? [])]),
  ];
  const needs = [...(base.composition?.needs ?? []), ...(child.composition?.needs ?? [])];

  return {
    ...child,
    extends: undefined,
    resources,
    vars: { ...(base.vars ?? {}), ...(child.vars ?? {}) },
    paths: { ...(base.paths ?? {}), ...(child.paths ?? {}) },
    composition: {
      ...(Object.keys(mergeEnv).length ? { env: mergeEnv } : {}),
      ...(order.length ? { order } : {}),
      ...(needs.length ? { needs } : {}),
    },
    slots: { ...(base.slots ?? {}), ...(child.slots ?? {}) },
    bindings: { ...(base.bindings ?? {}), ...(child.bindings ?? {}) },
    overrides: [...(base.overrides ?? []), ...(child.overrides ?? [])],
    overlays: [
      ...(base.overlays ?? []).map((ov) => ({
        ...ov,
        from: rebaseLocal(ov.from, baseDir, childDir),
      })),
      ...(child.overlays ?? []),
    ],
    install: {
      exec: [...(base.install?.exec ?? []), ...(child.install?.exec ?? [])],
    },
    verify: [...(base.verify ?? []), ...(child.verify ?? [])],
  } as Manifest;
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
