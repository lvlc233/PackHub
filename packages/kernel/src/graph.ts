import type { Issue, Manifest, ResourceSpec } from './types.ts';
import { checkSource, parseSource } from './ref.ts';
import { deepMerge } from './util.ts';

export interface Graph {
  /** capability -> 提供它的 resource id 列表（只含会被安装的资源） */
  providers: Map<string, string[]>;
  /** 安装顺序（拓扑 + 作者声明优先） */
  order: string[];
  resources: Map<string, ResourceSpec>;
  /** 被槽位绑定排除的候选：为什么这个实现这次不装 */
  excluded: { resource: string; slot: string; reason: string }[];
}

/** 槽位：谁占位、绑定了谁、这次装不装。 */
function resolveSlots(manifest: Manifest, issues: Issue[]): { active: Set<string>; excluded: Graph['excluded'] } {
  const slots = manifest.slots ?? {};
  const bindings = manifest.bindings ?? {};
  const candidates = new Map<string, string[]>();

  for (const res of manifest.resources) {
    if (!res.slot) continue;
    if (!slots[res.slot]) {
      issues.push({
        code: 'unknown-slot',
        severity: 'error',
        message: `资源 ${res.id} 占用未声明的槽位：${res.slot}`,
      });
      continue;
    }
    candidates.set(res.slot, [...(candidates.get(res.slot) ?? []), res.id]);
  }

  for (const [slot, impl] of Object.entries(bindings)) {
    if (!slots[slot]) {
      issues.push({
        code: 'binding-unknown-slot',
        severity: 'error',
        message: `bindings 指向未声明的槽位：${slot}`,
      });
      continue;
    }
    const res = manifest.resources.find((r) => r.id === impl);
    if (!res) {
      issues.push({
        code: 'binding-unknown-resource',
        severity: 'error',
        message: `槽位 ${slot} 绑定了不存在的资源：${impl}`,
      });
      continue;
    }
    if (res.slot !== slot) {
      issues.push({
        code: 'binding-wrong-slot',
        severity: 'error',
        message: `资源 ${impl} 并不占用槽位 ${slot}（它属于 ${res.slot ?? '无'}）`,
      });
      continue;
    }
    const contract = slots[slot]?.contract ?? [];
    const missing = contract.filter((c) => !(res.provides ?? []).includes(c));
    if (missing.length > 0) {
      issues.push({
        code: 'slot-contract-unmet',
        severity: 'error',
        message: `槽位 ${slot} 的绑定 ${impl} 缺少契约能力：${missing.join(', ')}`,
      });
    }
  }

  for (const [slot, ids] of candidates) {
    if (!bindings[slot]) {
      issues.push({
        code: 'slot-unbound',
        severity: 'error',
        message: `槽位 ${slot} 有 ${ids.length} 个候选（${ids.join(', ')}）但没有 bindings，装哪个不确定`,
      });
    }
  }

  const active = new Set<string>();
  const excluded: Graph['excluded'] = [];
  for (const res of manifest.resources) {
    if (!res.slot) {
      active.add(res.id);
    } else if (bindings[res.slot] === res.id) {
      active.add(res.id);
    } else {
      excluded.push({ resource: res.id, slot: res.slot, reason: 'unbound-slot' });
    }
  }
  return { active, excluded };
}

/** 路径表必须是相对路径，且不许逃出目标目录。 */
function checkPaths(manifest: Manifest, issues: Issue[]): void {
  for (const [name, value] of Object.entries(manifest.paths ?? {})) {
    if (/^([a-zA-Z]:[\\/]|[\\/])/.test(value) || value.split(/[\\/]/).includes('..')) {
      issues.push({
        code: 'bad-path',
        severity: 'error',
        message: `paths.${name} 必须是目标目录内的相对路径：${value}`,
      });
    }
  }
}

/** 资源与接线校验：这是 Pack 区别于「资源合集」的硬门槛。 */
export function validateGraph(manifest: Manifest): { graph: Graph; issues: Issue[] } {
  const issues: Issue[] = [];
  const resources = new Map<string, ResourceSpec>();
  const providers = new Map<string, string[]>();

  const overrideOf = new Map((manifest.overrides ?? []).map((o) => [o.resource, o]));
  const { active, excluded } = resolveSlots(manifest, issues);
  checkPaths(manifest, issues);

  // 重复 id 在所有资源上查（包括未绑定的候选）
  const seen = new Set<string>();
  for (const r of manifest.resources) {
    if (seen.has(r.id)) {
      issues.push({ code: 'duplicate-resource-id', severity: 'error', message: `资源 id 重复：${r.id}` });
    }
    seen.add(r.id);
  }

  manifest.resources.forEach((raw, index) => {
    const at = `resources[${index}]`;
    // 资源级覆盖：换 pin / 实现 / 安装参数，但不动上游那份清单
    const ov = overrideOf.get(raw.id);
    const res: ResourceSpec = ov
      ? {
          ...raw,
          ...(ov.source ? { source: ov.source } : {}),
          ...(ov.config ? { config: deepMerge(raw.config ?? {}, ov.config) as Record<string, unknown> } : {}),
        }
      : raw;
    // 未绑定槽位的候选：只做结构检查，不进依赖图、不进计划
    if (!active.has(res.id)) return;
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
        code: 'pin-conflict',
        severity: 'error',
        message: `${locator} 在不同资源里锁到不同版本：${entries
          .map((e) => `${e.id}@${e.pin ?? '<无>'}`)
          .join(', ')}；请用 overrides 显式定夺`,
      });
    }
  }

  // needs 必须有 provider
  for (const res of resources.values()) {
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
  return { graph: { providers, order, resources, excluded }, issues };
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
