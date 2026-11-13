import type { Issue, Manifest, ResourceSpec, TargetId } from './types.ts';
import { checkSource, parseSource } from './ref.ts';
import { deepMerge, isPlainObject } from './util.ts';

/** 已知的 harness 名称；requires.agent 写别的名字只警告，不阻断（新 harness 不该让旧包装不上）。 */
export const KNOWN_AGENTS = ['dsh', 'claude-code', 'codex', 'opencode'] as const;

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

/** 资源与接线校验：这是 Pack 区别于「资源合集」的硬门槛。 */
export function validateGraph(manifest: Manifest): { graph: Graph; issues: Issue[] } {
  const issues: Issue[] = [];
  const resources = new Map<string, ResourceSpec>();

  // 补丁必须指向真实存在的资源，否则写了等于没写
  for (const [i, m] of (manifest.modify ?? []).entries()) {
    if (!manifest.resources.some((r) => r.id === m.resource)) {
      issues.push({
        code: 'modify-unknown-resource',
        severity: 'error',
        message: `modify[${i}] 指向不存在的资源：${m.resource}`,
      });
      continue;
    }
    // 参数补丁只对真有参数的东西有意义；skill / prompt / knowledge 的正文不吃这一口
    if (isPlainObject(m.with)) {
      const type = manifest.resources.find((r) => r.id === m.resource)?.type;
      if (type !== 'mcp' && type !== 'tool') {
        issues.push({
          code: 'modify-invalid',
          severity: 'error',
          message: `modify[${i}]：${m.resource} 是 ${type}，没有可合并的参数；改正文请用 file / at`,
        });
      }
    }
  }
  const { active, excluded } = resolveSlots(manifest, issues);

  // requires.agent 只做提示：写错名字不阻断安装，但要让人看见
  const agent = manifest.requires?.agent;
  if (agent && !(KNOWN_AGENTS as readonly string[]).includes(agent)) {
    issues.push({
      code: 'unknown-agent',
      severity: 'warning',
      message: `requires.agent=${agent} 不在已知 harness（${KNOWN_AGENTS.join(' / ')}）里；按通用安装继续`,
    });
  }
  if (
    agent &&
    ['dir', 'dsh', 'claude-code', 'codex'].includes(agent) &&
    !manifest.metadata.targets.includes(agent as TargetId)
  ) {
    issues.push({
      code: 'agent-target-mismatch',
      severity: 'warning',
      message: `requires.agent=${agent}，但 metadata.targets 没有声明 ${agent}；这个包不会装进该 harness`,
    });
  }

  // 重复 id 在所有资源上查（包括未绑定的候选）
  const seen = new Set<string>();
  for (const r of manifest.resources) {
    if (seen.has(r.id)) {
      issues.push({ code: 'duplicate-resource-id', severity: 'error', message: `资源 id 重复：${r.id}` });
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
        code: 'modify-invalid',
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
    const res: ResourceSpec = !patch
      ? raw
      : raw.type === 'tool'
        ? {
            ...raw,
            // 工具的配置面是环境变量：对象形式的补丁并进 env
            env: {
              ...(raw.env ?? {}),
              ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, String(v)])),
            },
          }
        : { ...raw, config: deepMerge(raw.config ?? {}, patch) as Record<string, unknown> };
    // 未绑定槽位的候选：只做结构检查，不进依赖图、不进计划
    if (!active.has(res.id)) return;
    resources.set(res.id, res);
    const parsed = parseSource(res.source);
    issues.push(...checkSource(parsed, res.integrity, `${at}.source`));
  });

  // optional 资源：needs 在当前集合里无人提供时自动跳过（级联：跳过后它 provides 的能力也消失）。
  // 显式绑定到槽位的实现不自动跳过——作者已经点名要它，缺能力应当报错而不是静默换掉。
  const explicitlyBound = (res: ResourceSpec): boolean =>
    Boolean(res.slot && manifest.bindings?.[res.slot] === res.id);
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
        !explicitlyBound(res) &&
        (res.needs ?? []).some((need) => (available.get(need) ?? []).filter((id) => id !== res.id).length === 0),
    );
    if (drop.length === 0) break;
    for (const res of drop) {
      resources.delete(res.id);
      excluded.push({ resource: res.id, slot: res.slot ?? '', reason: 'optional-unmet' });
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
        code: 'pin-conflict',
        severity: 'error',
        message: `${locator} 在不同资源里锁到不同版本：${entries
          .map((e) => `${e.id}@${e.pin ?? '<无>'}`)
          .join(', ')}；把它们钉到同一个版本再打包`,
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

  // 顺序只由 dependsOn 决定；没有依赖关系的资源按清单顺序
  const order = topoSort(resources, issues);
  return { graph: { providers, order, resources, excluded }, issues };
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
