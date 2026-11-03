import type { Issue, Manifest, ResourceSpec } from './types.ts';
import { checkSource, parseSource } from './ref.ts';

export interface Graph {
  /** capability -> 提供它的 resource id 列表 */
  providers: Map<string, string[]>;
  /** 安装顺序（拓扑 + 作者声明优先） */
  order: string[];
  resources: Map<string, ResourceSpec>;
}

/** 资源与接线校验：这是 Pack 区别于「资源合集」的硬门槛。 */
export function validateGraph(manifest: Manifest): { graph: Graph; issues: Issue[] } {
  const issues: Issue[] = [];
  const resources = new Map<string, ResourceSpec>();
  const providers = new Map<string, string[]>();

  manifest.resources.forEach((res, index) => {
    const at = `resources[${index}]`;
    if (resources.has(res.id)) {
      issues.push({
        code: 'duplicate-resource-id',
        severity: 'error',
        message: `资源 id 重复：${res.id}`,
        path: `${at}.id`,
      });
    }
    resources.set(res.id, res);

    const parsed = parseSource(res.source);
    issues.push(...checkSource(parsed, res.integrity, `${at}.source`));

    for (const cap of res.provides ?? []) {
      const list = providers.get(cap) ?? [];
      list.push(res.id);
      providers.set(cap, list);
    }
  });

  // 同一 locator 两个不同 pin → 冲突（宁严不松）
  const byLocator = new Map<string, { pin?: string; id: string }[]>();
  for (const res of manifest.resources) {
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
        code: 'pin-conflict',
        severity: 'error',
        message: `${locator} 在不同资源里锁到不同版本：${entries
          .map((e) => `${e.id}@${e.pin ?? '<无>'}`)
          .join(', ')}；请用 overrides 显式定夺`,
      });
    }
  }

  // needs 必须有 provider
  for (const res of manifest.resources) {
    for (const need of res.needs ?? []) {
      const hits = (providers.get(need) ?? []).filter((id) => id !== res.id);
      if (hits.length === 0) {
        issues.push({
          code: 'unmet-need',
          severity: 'error',
          message: `资源 ${res.id} 需要 ${need}，但没有任何资源 provides 它`,
          path: `resources.${res.id}.needs`,
        });
      }
    }
  }

  // composition.needs：绑定必须真实存在且能提供该 capability
  for (const entry of manifest.composition?.needs ?? []) {
    const hits = providers.get(entry.capability) ?? [];
    if (hits.length === 0) {
      issues.push({
        code: 'unmet-capability',
        severity: 'error',
        message: `composition 要求能力 ${entry.capability}，没有资源提供`,
      });
    }
    if (entry.bind !== undefined) {
      const bound = resources.get(entry.bind);
      if (!bound) {
        issues.push({
          code: 'bad-bind',
          severity: 'error',
          message: `bind 指向不存在的资源：${entry.bind}`,
        });
      } else if (!(bound.provides ?? []).includes(entry.capability)) {
        issues.push({
          code: 'bad-bind',
          severity: 'error',
          message: `资源 ${entry.bind} 未声明 provides ${entry.capability}`,
        });
      }
    }
    for (const req of entry.requires) {
      if (!providers.has(req)) {
        issues.push({
          code: 'unmet-requirement',
          severity: 'error',
          message: `composition 要求 ${entry.capability} 依赖 ${req}，但没有资源提供`,
        });
      }
    }
  }

  // 顺序：作者声明优先，且必须与 dependsOn 相容
  const order = computeOrder(manifest, resources, issues);
  return { graph: { providers, order, resources }, issues };
}

function computeOrder(
  manifest: Manifest,
  resources: Map<string, ResourceSpec>,
  issues: Issue[],
): string[] {
  const declared = manifest.composition?.order;
  if (declared) {
    for (const [i, id] of declared.entries()) {
      if (!resources.has(id)) {
        issues.push({
          code: 'bad-order',
          severity: 'error',
          message: `composition.order[${i}] 引用了不存在的资源：${id}`,
        });
      }
    }
    for (const res of resources.values()) {
      for (const dep of res.dependsOn ?? []) {
        const a = declared.indexOf(dep);
        const b = declared.indexOf(res.id);
        if (a >= 0 && b >= 0 && a > b) {
          issues.push({
            code: 'order-violates-dependency',
            severity: 'error',
            message: `${res.id} 依赖 ${dep}，但 order 里排在它前面`,
          });
        }
      }
    }
    // 作者只声明了顺序的一部分时，其余资源按 manifest 声明顺序追加，不能被丢掉
    const declaredValid = declared.filter((id) => resources.has(id));
    const rest = [...resources.keys()].filter((id) => !declaredValid.includes(id));
    return [...declaredValid, ...rest];
  }
  return topoSort(resources, issues);
}

function topoSort(resources: Map<string, ResourceSpec>, issues: Issue[]): string[] {
  const result: string[] = [];
  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 1 访问中 2 完成

  const visit = (id: string, trail: string[]): void => {
    const st = state.get(id) ?? 0;
    if (st === 2) return;
    if (st === 1) {
      issues.push({
        code: 'dependency-cycle',
        severity: 'error',
        message: `依赖成环：${[...trail, id].join(' → ')}`,
      });
      return;
    }
    state.set(id, 1);
    const res = resources.get(id);
    for (const dep of res?.dependsOn ?? []) {
      if (!resources.has(dep)) {
        issues.push({
          code: 'missing-dependency',
          severity: 'error',
          message: `${id} 依赖不存在的资源 ${dep}`,
        });
        continue;
      }
      visit(dep, [...trail, id]);
    }
    state.set(id, 2);
    result.push(id);
  };

  for (const id of resources.keys()) visit(id, []);
  return result;
}
