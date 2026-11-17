// cli.ts 的共享小件：命令文件共用，不带任何命令定义。
import { issueError, issueWarn, problemRaw, say } from '../emit.ts';
import { type Issue, type Plan } from '@packhub/kernel';

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

export function printPlan(plan: Plan): void {
  say(`${plan.pack.name}@${plan.pack.version} → target=${plan.target}`);
  say(`planHash ${plan.planHash}\n`);
  for (const a of plan.actions) {
    const target = 'to' in a ? a.to : 'dest' in a ? a.dest : 'path' in a ? a.path : a.resource ?? '';
    say(`  ${a.actionId.padEnd(16)} ${a.op.padEnd(14)} ${target}`);
  }
  say(`\nverify: ${plan.verify.length} 项`);
}
