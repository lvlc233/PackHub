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
  /** 被备选组排除的成员：为什么这个实现这次不装 */
  excluded: { resource: string; alternative: string; reason: string }[];
}

/** 资源属于哪个备选组（一个合法的清单里只有一个）；不在任何组里返回 undefined。 */
export function alternativeOf(manifest: Manifest, id: string): string | undefined {
  for (const [name, members] of Object.entries(manifest.alternatives ?? {})) {
    if (members.includes(id)) return name;
  }
  return undefined;
}

/**
 * 备选组的有效实现 = `pick[组] ?? 组内唯一成员`。
 * 成员多于一个又没人选，就报 alternative-unpicked——这次装哪个不确定。
 */
function resolveAlternatives(
  manifest: Manifest,
  issues: Issue[],
): { active: Set<string>; excluded: Graph['excluded']; selected: Set<string> } {
  const groups = manifest.alternatives ?? {};
  const pick = manifest.pick ?? {};
  /** 资源 id → 它所在的备选组（正常只有一个；多个就是清单写错了） */
  const groupsOf = new Map<string, string[]>();

  for (const [name, members] of Object.entries(groups)) {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const id of members) {
      if (seen.has(id)) {
        if (!duplicates.includes(id)) duplicates.push(id);
        continue;
      }
      seen.add(id);
      groupsOf.set(id, [...(groupsOf.get(id) ?? []), name]);
    }
    if (duplicates.length > 0) {
      issues.push({
        code: ISSUE_CODES.alternativeDuplicateMember,
        severity: 'error',
        message: `备选组 ${name} 里重复列了资源：${duplicates.join(', ')}（一个资源在组里只能出现一次）`,
      });
    }
  }

  // 成员必须是本清单里的资源
  for (const [name, members] of Object.entries(groups)) {
    const missing = [...new Set(members)].filter((id) => !manifest.resources.some((r) => r.id === id));
    if (missing.length > 0) {
      issues.push({
        code: ISSUE_CODES.alternativeUnknownResource,
        severity: 'error',
        message: `备选组 ${name} 列了不存在的资源：${missing.join(', ')}（成员只能写本清单里的资源 id）`,
      });
    }
  }

  // 同一个资源只能属于一个备选组：两个组都想装它，清单表达不出选谁
  for (const [id, names] of groupsOf) {
    if (names.length > 1) {
      issues.push({
        code: ISSUE_CODES.resourceInMultipleAlternatives,
        severity: 'error',
        message: `资源 ${id} 同时出现在多个备选组：${names.join(', ')}（一个资源只能占一个组）`,
      });
    }
  }

  for (const [name, impl] of Object.entries(pick)) {
    const members = groups[name];
    if (!members) {
      issues.push({
        code: ISSUE_CODES.alternativeUnknown,
        severity: 'error',
        message: `pick 指向未声明的备选组：${name}`,
      });
      continue;
    }
    if (!manifest.resources.some((r) => r.id === impl)) {
      issues.push({
        code: ISSUE_CODES.pickUnknownResource,
        severity: 'error',
        message: `pick.${name} 指向不存在的资源：${impl}（pick 只能写本清单里的资源 id）`,
      });
      continue;
    }
    if (!members.includes(impl)) {
      issues.push({
        code: ISSUE_CODES.pickNotInAlternatives,
        severity: 'error',
        message: `pick.${name} 指向的 ${impl} 不是这个组的成员（成员：${[...new Set(members)].join(', ') || '无'}）`,
      });
    }
  }

  /** 有效实现：pick 优先，其次组内唯一成员；都定不下来就是 undefined。 */
  const effectiveOf = (name: string): string | undefined => {
    const explicit = pick[name];
    if (explicit !== undefined) return explicit;
    const members = [...new Set(groups[name] ?? [])];
    return members.length === 1 ? members[0] : undefined;
  };

  for (const [name, members] of Object.entries(groups)) {
    if (effectiveOf(name) !== undefined) continue;
    if (members.length < 2) continue; // 空组 / 唯一成员：没得选，不算「该选没选」
    issues.push({
      code: ISSUE_CODES.alternativeUnpicked,
      severity: 'error',
      message: `备选组 ${name} 有 ${members.length} 个成员（${members.join(', ')}）但没有选中任何一个：写 pick.${name}，或用 --pick ${name}=<资源 id> 指定`,
    });
  }

  const active = new Set<string>();
  const excluded: Graph['excluded'] = [];
  for (const res of manifest.resources) {
    const names = groupsOf.get(res.id) ?? [];
    if (names.length === 0 || names.some((name) => effectiveOf(name) === res.id)) {
      active.add(res.id);
      continue;
    }
    excluded.push({ resource: res.id, alternative: names[0] ?? '', reason: 'not-selected' });
  }

  // 「显式选择」= pick 写明，或组内唯一成员自动选中：optional 不该把它静默裁掉
  const selected = new Set<string>();
  for (const name of Object.keys(groups)) {
    const effective = effectiveOf(name);
    if (effective !== undefined) selected.add(effective);
  }
  return { active, excluded, selected };
}

/** 资源与接线校验：这是 Pack 区别于「资源合集」的硬门槛。 */
export function validateGraph(manifest: Manifest): { graph: Graph; issues: Issue[] } {
  const issues: Issue[] = [];
  const resources = new Map<string, ResourceSpec>();

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
  const { active, excluded, selected } = resolveAlternatives(manifest, issues);

  // 重复 id 在所有资源上查（包括没被选中的成员）
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
    // 没被选中的备选组成员：只做结构检查，不进依赖图、不进计划
    if (!active.has(res.id)) return;
    resources.set(res.id, res);
    const parsed = parseSource(res.source);
    issues.push(...checkSource(parsed, res.integrity, `${at}.source`));
  });

  // optional 资源：needs 在当前集合里无人提供时自动跳过（级联：跳过后它 provides 的能力也消失）。
  // 被选中的实现（pick 写明，或组内唯一成员自动选中）不自动跳过——选了它，缺能力应当报错而不是静默换掉。
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
        !selected.has(res.id) &&
        (res.needs ?? []).some((need) => (available.get(need) ?? []).filter((id) => id !== res.id).length === 0),
    );
    if (drop.length === 0) break;
    for (const res of drop) {
      resources.delete(res.id);
      excluded.push({
        resource: res.id,
        alternative: alternativeOf(manifest, res.id) ?? '',
        reason: 'optional-unmet',
      });
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
