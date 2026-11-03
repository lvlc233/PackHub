import type { PlanAction } from './types.ts';
import { canonicalize } from './util.ts';

/** 比较动作时忽略这两个字段：编号会随顺序漂移，依赖是派生的。 */
function actionKey(action: PlanAction): string {
  const { actionId: _id, dependsOn: _deps, ...rest } = action as PlanAction & {
    actionId?: string;
    dependsOn?: string[];
  };
  return canonicalize(rest);
}

export interface ActionDiff {
  added: PlanAction[];
  removed: PlanAction[];
}

/** 按内容（而不是 actionId）比较两份计划。换绑时 id 不变、内容变，用 id 比会得到"无差异"。 */
export function diffActions(before: PlanAction[], after: PlanAction[]): ActionDiff {
  const beforeMap = new Map(before.map((a) => [actionKey(a), a]));
  const afterMap = new Map(after.map((a) => [actionKey(a), a]));

  const added: PlanAction[] = [];
  const removed: PlanAction[] = [];
  for (const [key, action] of afterMap) if (!beforeMap.has(key)) added.push(action);
  for (const [key, action] of beforeMap) if (!afterMap.has(key)) removed.push(action);
  return { added, removed };
}

/** 人读的一行摘要：`op target`。 */
export function describeAction(action: PlanAction): string {
  const a = action as PlanAction & Record<string, unknown>;
  const target = (a.to ?? a.dest ?? a.path ?? a.uri ?? a.resource ?? '') as string;
  return `${a.op} ${target}`.trim();
}
