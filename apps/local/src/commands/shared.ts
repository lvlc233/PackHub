// cli.ts 的共享小件：命令文件共用，不带任何命令定义。
import { EXIT, issueError, issueWarn, problemRaw, say, stop } from '../emit.ts';
import {
  harnessIds,
  isHarnessId,
  type Composition,
  type HarnessId,
  type Issue,
  type Plan,
} from '@packhub/kernel';

export function reportIssues(issues: Issue[], ctx = 'packhub'): boolean {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  for (const w of warnings) issueWarn(w.code, w.message);
  for (const e of errors) issueError(e.code, e.message);
  if (errors.length) {
    problemRaw(`\n${ctx}: ${errors.length} 个错误，未继续。`);
    return true;
  }
  return false;
}

/**
 * 解析 `--harness`：只有宿主名，不写 = 平铺目录。
 *
 * 预览/检查参数：只有宿主名，不写 = 平铺目录。
 *
 * 它只决定「按哪个宿主的落点算计划」，不写清单、不安装；拼错/传 dir 都按用法错退出（2）。
 */
export function parseHarness(raw: string | undefined): HarnessId | undefined {
  if (raw === undefined) return undefined;
  if (!isHarnessId(raw)) {
    problemRaw(`未知宿主：${raw}（可选 ${harnessIds().join(' / ')}；不写 = 平铺目录）`);
    stop(EXIT.USAGE);
  }
  return raw;
}

/** 计划头/对比行里的人类可读宿主名：不选宿主时就是平铺目录。 */
export function describeHarness(harness: HarnessId | undefined): string {
  return harness === undefined ? '平铺目录' : `harness=${harness}`;
}

/**
 * 接线段：能力令牌 → provider、needs 派生的安装边、被计划排除的资源与原因。
 *
 * `plan.excluded` 是 `graph.excluded` 的超集（plan 期还多出 host-managed），
 * 所以「为什么没装」以 plan 为准。
 */
function printWiring(wiring: Composition, planExcluded: Plan['excluded']): void {
  say('接线：');
  say('  能力（令牌 → provider）：');
  const capabilities = Object.entries(wiring.capabilities);
  if (capabilities.length === 0) say('    （无）');
  for (const [token, providers] of capabilities) say(`    ${token} → ${providers.join(', ')}`);

  say('  依赖（needs 边，provider 先装）：');
  if (wiring.edges.length === 0) say('    （无）');
  for (const edge of wiring.edges) {
    say(`    ${edge.provider} → ${edge.consumer}（${edge.capability}）`);
  }

  // 被 plan 期规则整条裁掉的资源也要露出原因（落点裁剪、宿主托管、可选级联）
  if (planExcluded.length > 0) {
    say('  未装（计划期排除）：');
    for (const e of planExcluded) {
      say(`    - ${e.resource}：${e.reason}`);
    }
  }
}

/**
 * 打印一份计划。给了 `wiring`（kernel 的 `describeComposition`）就在头部之后
 * 多打一段接线；动作列表与 verify 摘要保持原样。
 */
export function printPlan(plan: Plan, wiring?: Composition): void {
  say(`${plan.pack.name}@${plan.pack.version} → ${describeHarness(plan.harness)}`);
  say(`planHash ${plan.planHash}\n`);
  if (wiring) {
    printWiring(wiring, plan.excluded);
    say('');
  }
  for (const a of plan.actions) {
    const dest = 'to' in a ? a.to : 'dest' in a ? a.dest : 'path' in a ? a.path : a.resource ?? '';
    say(`  ${a.actionId.padEnd(16)} ${a.op.padEnd(14)} ${dest}`);
  }
  say(`\nverify: ${plan.verify.length} 项`);
}
