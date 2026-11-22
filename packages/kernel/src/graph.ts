import type { Issue, Manifest, ResourceSpec } from './types.ts';
import { checkSource, parseSource } from './ref.ts';
import { deepMerge, isPlainObject } from './util.ts';
import { RESOURCE_KINDS } from './kinds.ts';
import { ISSUE_CODES } from './issueCodes.ts';

/** 安装边：provider 必须先于 consumer 装（由 needs 派生）。 */
export interface GraphEdge {
  provider: string;
  consumer: string;
  /** 触发这条边的那条 needs 令牌 */
  capability: string;
}

export interface Graph {
  /** 能力令牌 -> 提供它的 resource id 列表（只含会被安装的资源） */
  providers: Map<string, string[]>;
  /** needs 派生的安装边：provider → consumer */
  edges: GraphEdge[];
  /** 安装顺序（needs 拓扑 + 清单顺序） */
  order: string[];
  resources: Map<string, ResourceSpec>;
  /** 没进计划的资源：为什么这次不装（只有 optional 裁剪与宿主托管两种） */
  excluded: { resource: string; reason: string }[];
}

/** 资源与接线校验：这是 Pack 区别于「资源合集」的硬门槛。 */
export function validateGraph(manifest: Manifest): { graph: Graph; issues: Issue[] } {
  const issues: Issue[] = [];
  const resources = new Map<string, ResourceSpec>();
  const excluded: Graph['excluded'] = [];

  // 补丁必须指向真实存在的资源，否则写了等于没写
  for (const [i, m] of (manifest.modify ?? []).entries()) {
    if (!manifest.resources.some((r) => r.id === m.resource)) {
      issues.push({
        code: ISSUE_CODES.modifyUnknownResource,
        severity: 'error',
        message: `modify[${i}] 指向不存在的资源：${m.resource}`,
      });
      continue;
    }
    // 参数补丁只对真有参数面的类型有意义；其余类型的正文不吃这一口
    if (isPlainObject(m.with)) {
      const type = manifest.resources.find((r) => r.id === m.resource)?.type;
      if (type && RESOURCE_KINDS[type].paramPatch === null) {
        issues.push({
          code: ISSUE_CODES.modifyInvalid,
          severity: 'error',
          message: `modify[${i}]：${m.resource} 是 ${type}，没有可合并的参数；改正文请用 file / at`,
        });
      }
    }
  }

  // 重复 id 在所有资源上查
  const seen = new Set<string>();
  for (const r of manifest.resources) {
    if (seen.has(r.id)) {
      issues.push({ code: ISSUE_CODES.duplicateResourceId, severity: 'error', message: `资源 id 重复：${r.id}` });
    }
    seen.add(r.id);
  }

  // 参数补丁：`modify` 里 with 是对象的那些，并进资源自己的参数（mcp / tool 用得上）。
  // 文件类修改不在这儿做——它要等资源落点算出来，在 plan 里生成动作。
  const paramPatches = new Map<string, Record<string, unknown>>();
  for (const [i, m] of (manifest.modify ?? []).entries()) {
    if (!isPlainObject(m.with)) continue;
    if (m.file || m.at) {
      issues.push({
        code: ISSUE_CODES.modifyInvalid,
        severity: 'error',
        message: `modify[${i}] 的参数补丁不能带 file / at：那是文件修改的字段`,
      });
      continue;
    }
    paramPatches.set(
      m.resource,
      deepMerge(paramPatches.get(m.resource) ?? {}, m.with) as Record<string, unknown>,
    );
  }

  manifest.resources.forEach((raw, index) => {
    const at = `resources[${index}]`;
    const patch = paramPatches.get(raw.id);
    // 参数补丁并到哪儿由 kind 表决定：mcp 并 config，tool2 并 env（值 String() 化）；
    // null 的 kind 在上一轮已经报了 modify-invalid，这里保持与旧实现一致的兜底
    const res: ResourceSpec = !patch
      ? raw
      : RESOURCE_KINDS[raw.type].paramPatch === 'env'
        ? {
            ...raw,
            // 工具的配置面是环境变量：对象形式的补丁并进 env
            env: {
              ...(raw.env ?? {}),
              ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, String(v)])),
            },
          }
        : { ...raw, config: deepMerge(raw.config ?? {}, patch) as Record<string, unknown> };
    resources.set(res.id, res);
    const parsed = parseSource(res.source);
    issues.push(...checkSource(parsed, res.integrity, `${at}.source`));
  });

  // optional 资源：needs 在当前集合里无人提供时自动跳过（级联：跳过后它 provides 的能力也消失）。
  const providersOf = (set: Map<string, ResourceSpec>): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const res of set.values()) {
      for (const cap of res.provides ?? []) {
        map.set(cap, [...(map.get(cap) ?? []), res.id]);
      }
    }
    return map;
  };
  for (;;) {
    const available = providersOf(resources);
    const drop = [...resources.values()].filter(
      (res) =>
        res.optional === true &&
        (res.needs ?? []).some((need) => (available.get(need) ?? []).filter((id) => id !== res.id).length === 0),
    );
    if (drop.length === 0) break;
    for (const res of drop) {
      resources.delete(res.id);
      excluded.push({ resource: res.id, reason: 'optional-unmet' });
    }
  }

  const providers = providersOf(resources);

  // 同一 locator 两个不同 pin → 冲突（宁严不松）
  const byLocator = new Map<string, { pin?: string; id: string }[]>();
  for (const res of resources.values()) {
    const parsed = parseSource(res.source);
    if (parsed.kind === 'local' || parsed.kind === 'http') continue;
    const list = byLocator.get(parsed.locator) ?? [];
    list.push({ pin: parsed.pin, id: res.id });
    byLocator.set(parsed.locator, list);
  }
  for (const [locator, entries] of byLocator) {
    const pins = new Set(entries.map((e) => e.pin));
    if (entries.length > 1 && pins.size > 1) {
      issues.push({
        code: ISSUE_CODES.pinConflict,
        severity: 'error',
        message: `${locator} 在不同资源里锁到不同版本：${entries
          .map((e) => `${e.id}@${e.pin ?? '<无>'}`)
          .join(', ')}；把它们钉到同一个版本再打包`,
      });
    }
  }

  // needs 必须有 provider；同时派生安装边（provider 先于 consumer）
  const edges: GraphEdge[] = [];
  for (const res of resources.values()) {
    for (const need of new Set(res.needs ?? [])) {
      const hits = (providers.get(need) ?? []).filter((id) => id !== res.id);
      if (hits.length === 0) {
        issues.push({
          code: ISSUE_CODES.unmetNeed,
          severity: 'error',
          message: `资源 ${res.id} 需要 ${need}，但没有任何资源 provides 它`,
          path: `resources.${res.id}.needs`,
        });
        continue;
      }
      for (const provider of hits) edges.push({ provider, consumer: res.id, capability: need });
    }
  }

  // 安装顺序只由 needs 派生：provider 先于 consumer；没有依赖关系的资源按清单顺序
  const order = topoSort(resources, providers, issues);
  return { graph: { providers, edges, order, resources, excluded }, issues };
}

function topoSort(
  resources: Map<string, ResourceSpec>,
  providers: Map<string, string[]>,
  issues: Issue[],
): string[] {
  const result: string[] = [];
  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 1 访问中 2 完成

  const visit = (id: string, trail: string[]): void => {
    const st = state.get(id) ?? 0;
    if (st === 2) return;
    if (st === 1) {
      issues.push({
        code: ISSUE_CODES.dependencyCycle,
        severity: 'error',
        message: `能力依赖成环：${[...trail, id].join(' → ')}`,
      });
      return;
    }
    state.set(id, 1);
    const res = resources.get(id);
    // needs 的每个令牌都先装它的全部 provider；自己提供自己的令牌不算边
    for (const need of new Set(res?.needs ?? [])) {
      for (const provider of providers.get(need) ?? []) {
        if (provider === id || !resources.has(provider)) continue;
        visit(provider, [...trail, id]);
      }
    }
    state.set(id, 2);
    result.push(id);
  };

  for (const id of resources.keys()) visit(id, []);
  return result;
}
