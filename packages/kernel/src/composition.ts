// 接线描述：把 validateGraph 的结果整理成「能力 → 谁提供、谁需要、备选组选了谁」的一份快照。
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

export interface CompositionAlternative {
  name: string;
  /** 组里的全部成员（资源 id，按清单顺序） */
  members: string[];
  /** pick[组]（资源 id）：显式选用 */
  picked?: string;
  /** 这次真正装的那个实现 = picked ?? 唯一成员 */
  effective?: string;
  /** 没被选中的成员与原因；effective 之外的成员都在这里 */
  excluded: { resource: string; reason: string }[];
}

export interface Composition {
  /** 能力令牌 → provider id 列表；键按令牌排序 */
  capabilities: Record<string, string[]>;
  /** needs 派生的安装边：provider 必须先于 consumer */
  edges: GraphEdge[];
  alternatives: CompositionAlternative[];
}

/**
 * 把 `ctx`（清单 + validateGraph 的结果）整理成接线快照。
 *
 * - `capabilities`：只含会被安装的资源；令牌升序。
 * - `edges`：只含当前集合里真的能供上的 needs；provider → consumer。
 * - `alternatives`：成员、pick、有效实现、排除原因。
 */
export function describeComposition(ctx: CompositionContext): Composition {
  const { manifest, graph } = ctx;

  const capabilities: Record<string, string[]> = {};
  for (const token of [...graph.providers.keys()].sort()) {
    capabilities[token] = [...(graph.providers.get(token) ?? [])];
  }

  const pick = manifest.pick ?? {};
  const alternatives: CompositionAlternative[] = Object.entries(manifest.alternatives ?? {}).map(
    ([name, members]) => {
      const picked = pick[name];
      const effective = picked ?? (members.length === 1 ? members[0] : undefined);
      const excluded = members
        .filter((id) => id !== effective)
        .map((id) => ({
          resource: id,
          // 没被选中就是这一组没选它；被可选裁剪掉的资源在 graph.excluded 里另有原因
          reason: graph.excluded.find((e) => e.resource === id)?.reason ?? 'not-selected',
        }));
      return {
        name,
        members: [...members],
        ...(picked !== undefined ? { picked } : {}),
        ...(effective !== undefined ? { effective } : {}),
        excluded,
      };
    },
  );

  return { capabilities, edges: graph.edges.map((edge) => ({ ...edge })), alternatives };
}
