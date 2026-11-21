// cli.ts 的共享小件：命令文件共用，不带任何命令定义。
import { issueError, issueWarn, problemRaw, say } from '../emit.ts';
import { type Composition, type Issue, type Plan } from '@packhub/kernel';

/** 安装后自动复核只跑只读检查；command / mcp-ready 会执行包里的命令，必须显式 --deep-verify。 */
export const SAFE_CHECKS = ['file-exists', 'config-key', 'knowledge-integrity'] as const;

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
 * 接线段：能力令牌 → provider、needs 派生的安装边、槽位的 contract / 有效实现 /
 * 候选 / 被排除的候选与原因。
 *
 * `plan.excluded` 是 `graph.excluded` 的超集（plan 期还多出 target-mismatch / host-managed），
 * 所以「为什么没装」以 plan 为准；graph 侧的原因只在这一项计划里没有时兜底。
 * 槽位之外的排除（不占槽位、被整条计划裁掉）另起一段，不能因为按槽位打印就丢掉。
 */
function printWiring(wiring: Composition, planExcluded: Plan['excluded']): void {
  const planReason = new Map(planExcluded.map((e) => [e.resource, e.reason] as const));

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

  say('  槽位：');
  if (wiring.slots.length === 0) say('    （无）');
  // 被接线段解释过的资源：槽位里落选的候选 + 被计划裁掉的有效实现。其余排除另起一段。
  const covered = new Set<string>();
  for (const slot of wiring.slots) {
    const picked =
      slot.bound !== undefined
        ? `bindings${slot.default !== undefined ? `，覆盖 default ${slot.default}` : ''}`
        : slot.default !== undefined
          ? 'default'
          : '未指定';
    const contract = slot.contract.length > 0 ? slot.contract.join(', ') : '（无）';
    say(`    ${slot.name}：contract ${contract} · effective ${slot.effective ?? '（无）'}（${picked}）`);
    // 有效实现也可能被 plan 期规则裁掉（例如 bindings 指向只给某个 target 的资源）：原因要露出来
    const effectiveReason = slot.effective !== undefined ? planReason.get(slot.effective) : undefined;
    if (slot.effective !== undefined && effectiveReason !== undefined) {
      say(`      ! ${slot.effective}：${effectiveReason}（这次不会装）`);
      covered.add(slot.effective);
    }
    say(`      候选：${slot.candidates.length > 0 ? slot.candidates.join(', ') : '（无）'}`);
    for (const candidate of slot.excluded) {
      const reason = planReason.get(candidate.resource) ?? candidate.reason;
      say(`      - ${candidate.resource}：${reason}`);
      covered.add(candidate.resource);
    }
  }

  // 不占槽位、或者被 plan 期规则整条裁掉的资源也要露出原因（target 裁剪、宿主托管、可选级联）
  const unplaced = planExcluded.filter((e) => !covered.has(e.resource));
  if (unplaced.length > 0) {
    say('  未装（计划期排除）：');
    for (const e of unplaced) {
      say(`    - ${e.resource}${e.slot ? `（槽位 ${e.slot}）` : ''}：${e.reason}`);
    }
  }
}

/**
 * 打印一份计划。给了 `wiring`（kernel 的 `describeComposition`）就在头部之后
 * 多打一段接线；动作列表与 verify 摘要保持原样。
 */
export function printPlan(plan: Plan, wiring?: Composition): void {
  say(`${plan.pack.name}@${plan.pack.version} → target=${plan.target}`);
  say(`planHash ${plan.planHash}\n`);
  if (wiring) {
    printWiring(wiring, plan.excluded);
    say('');
  }
  for (const a of plan.actions) {
    const target = 'to' in a ? a.to : 'dest' in a ? a.dest : 'path' in a ? a.path : a.resource ?? '';
    say(`  ${a.actionId.padEnd(16)} ${a.op.padEnd(14)} ${target}`);
  }
  say(`\nverify: ${plan.verify.length} 项`);
}
