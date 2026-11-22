// 接线描述：把 validateGraph 的结果整理成「能力 → 谁提供、谁需要」的一份快照。
//
// 只读、纯派生：CLI 的 plan 用它打印接线图，--json 原样塞进 wiring 字段。
// 顺序规则与 graph.ts 一致（capabilities 按令牌排序，edges 按清单顺序）。

import type { Graph, GraphEdge } from './graph.ts';
import type { Manifest } from './types.ts';

/** describeComposition 需要的全部输入；PackContext 结构上满足它。 */
export interface CompositionContext {
  manifest: Manifest;
  graph: Graph;
}

export interface Composition {
  /** 能力令牌 → provider id 列表；键按令牌排序，同一令牌的多个提供者全部列出 */
  capabilities: Record<string, string[]>;
  /** needs 派生的安装边：provider 必须先于 consumer */
  edges: GraphEdge[];
}

/**
 * 把 `ctx`（清单 + validateGraph 的结果）整理成接线快照。
 *
 * - `capabilities`：只含会被安装的资源；令牌升序。
 * - `edges`：只含当前集合里真的能供上的 needs；provider → consumer。
 */
export function describeComposition(ctx: CompositionContext): Composition {
  const { graph } = ctx;

  const capabilities: Record<string, string[]> = {};
  for (const token of [...graph.providers.keys()].sort()) {
    capabilities[token] = [...(graph.providers.get(token) ?? [])];
  }

  return { capabilities, edges: graph.edges.map((edge) => ({ ...edge })) };
}
