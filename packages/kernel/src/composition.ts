// 接线描述：把 validateGraph 的结果整理成「能力 → 谁提供、谁需要、槽位选了谁」的一份快照。
//
// 只读、纯派生：CLI 的 plan 用它打印接线图，--json 原样塞进 wiring 字段。
// 顺序规则与 graph.ts 一致（capabilities 按令牌排序，其余按清单顺序）。

import type { Graph, GraphEdge } from './graph.ts';
import type { Manifest } from './types.ts';

/** describeComposition 需要的全部输入；PackContext 结构上满足它。 */
export interface CompositionContext {
  manifest: Manifest;
  graph: Graph;
}

export interface CompositionSlot {
  name: string;
  /** 占位实现必须提供的令牌 */
  contract: string[];
  /** slots[].default（资源 id） */
  default?: string;
  /** bindings[slot]（资源 id）：显式绑定优先于 default */
  bound?: string;
  /** 这次真正装的那个实现 = bound ?? default */
  effective?: string;
  /** 这个槽位下的全部候选（资源 id，按清单顺序） */
  candidates: string[];
  /** 没被选中的候选与原因；effective 之外的候选都在这里 */
  excluded: { resource: string; reason: string }[];
}

export interface Composition {
  /** 能力令牌 → provider id 列表；键按令牌排序 */
  capabilities: Record<string, string[]>;
  /** needs 派生的安装边：provider 必须先于 consumer */
  edges: GraphEdge[];
  slots: CompositionSlot[];
}

/**
 * 把 `ctx`（清单 + validateGraph 的结果）整理成接线快照。
 *
 * - `capabilities`：只含会被安装的资源；令牌升序。
 * - `edges`：只含当前集合里真的能供上的 needs；provider → consumer。
 * - `slots`：契约、default、bindings、有效实现、候选与排除原因。
 */
export function describeComposition(ctx: CompositionContext): Composition {
  const { manifest, graph } = ctx;

  const capabilities: Record<string, string[]> = {};
  for (const token of [...graph.providers.keys()].sort()) {
    capabilities[token] = [...(graph.providers.get(token) ?? [])];
  }

  const bindings = manifest.bindings ?? {};
  const slots: CompositionSlot[] = Object.entries(manifest.slots ?? {}).map(([name, spec]) => {
    const bound = bindings[name];
    const fallback = spec.default;
    const effective = bound ?? fallback;
    const candidates = manifest.resources.filter((r) => r.slot === name).map((r) => r.id);
    const excluded = candidates
      .filter((id) => id !== effective)
      .map((id) => ({
        resource: id,
        // 没被选中就是槽位没选它；被可选裁剪掉的资源在 graph.excluded 里另有原因
        reason: graph.excluded.find((e) => e.resource === id)?.reason ?? 'unbound-slot',
      }));
    return {
      name,
      contract: [...(spec.contract ?? [])],
      ...(fallback !== undefined ? { default: fallback } : {}),
      ...(bound !== undefined ? { bound } : {}),
      ...(effective !== undefined ? { effective } : {}),
      candidates,
      excluded,
    };
  });

  return { capabilities, edges: graph.edges.map((edge) => ({ ...edge })), slots };
}
