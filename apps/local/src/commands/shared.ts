// cli.ts 的共享小件：命令文件共用，不带任何命令定义。
import { join, resolve } from 'node:path';
import { EXIT, issueError, issueWarn, problemRaw, say, stop } from '../emit.ts';
import {
  loadPack,
  loadManifest,
  readLocalOverrides,
  mergeLocalOverrides,
  validateGraph,
  MANIFEST_FILE,
  type Composition,
  type Graph,
  type Issue,
  type Manifest,
  type PackContext,
  type Plan,
} from '@packhub/kernel';

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
 * 解析 `--pick`：`组=资源[,组=资源]`，只影响本次运行，不写回清单。
 *
 * 这里只判两件事：格式不对、组名不在清单的 `alternatives` 里——两种都按用法错退出（2），
 * 并把清单里可用的备选组打出来。资源不存在、资源不在组内仍交给 kernel 的 `validateGraph`
 * （pick-unknown-resource / pick-not-in-alternatives），错误码与文案只留一处。
 */
export function parsePick(raw: string, manifest: Manifest): Record<string, string> {
  const groups = Object.keys(manifest.alternatives ?? {});
  const hint = groups.length > 0 ? groups.join(', ') : '（清单里没有声明任何备选组）';
  const fail = (message: string): never => {
    problemRaw(`--pick ${message}`);
    problemRaw(`  可用备选：${hint}`);
    stop(EXIT.USAGE);
  };

  const pick: Record<string, string> = {};
  for (const item of raw.split(',')) {
    const part = item.trim();
    if (part === '') fail(`格式错：${JSON.stringify(raw)}（写成 组=资源[,组=资源]）`);
    const eq = part.indexOf('=');
    const alternative = eq > 0 ? part.slice(0, eq).trim() : '';
    const resource = eq > 0 ? part.slice(eq + 1).trim() : '';
    if (alternative === '' || resource === '' || resource.includes('=')) {
      fail(`格式错：${part}（写成 组=资源[,组=资源]）`);
    }
    if (manifest.alternatives?.[alternative] === undefined) fail(`备选组不存在：${alternative}`);
    pick[alternative] = resource;
  }
  return pick;
}

/**
 * 把 `--pick` 合并进 ctx 并重新校验（不写回清单）。
 *
 * 合并走 kernel 的 `mergeLocalOverrides`，校验走 `validateGraph`：返回值里的 `issues`
 * 只含这次合并新产生的问题，调用方自己决定是报错停下还是带进计划。
 */
export function applyPick(ctx: PackContext, raw: string): { ctx: PackContext; issues: Issue[] } {
  const pick = parsePick(raw, ctx.manifest);
  const merged = mergeLocalOverrides(ctx.manifest, { pick });
  const validated = validateGraph(merged.manifest);
  const issues = [...merged.issues, ...validated.issues];
  return {
    ctx: {
      ...ctx,
      manifest: merged.manifest,
      graph: validated.graph,
      issues: [...ctx.issues, ...issues],
    },
    issues,
  };
}

/**
 * 读 Pack 并应用 `--pick` 后重新校验；没有 `--pick` 时就是 `loadPack`。
 *
 * 有 `--pick` 时从清单重读再合并：`loadPack` 已经按未覆盖的清单校验过一遍，
 * 那份结果里可能带着「备选组有多个成员但没选中」之类的错误，不能拿来做本次运行的判据。
 * 项目根的 `.packhub/local.yaml` 仍先合并，`--pick` 后合并（优先级更高）。
 */
export function loadPackWithPick(dir: string, raw: string | undefined): PackContext {
  if (raw === undefined) return loadPack(dir);

  const abs = resolve(dir);
  const loaded = loadManifest(join(abs, MANIFEST_FILE));
  if (!loaded.manifest) {
    return {
      dir: abs,
      manifest: undefined as unknown as Manifest,
      graph: undefined as unknown as Graph,
      issues: loaded.issues,
    };
  }
  let manifest = loaded.manifest;
  const issues: Issue[] = [...loaded.issues];

  const local = readLocalOverrides(abs);
  issues.push(...local.issues);
  if (local.file) {
    const merged = mergeLocalOverrides(manifest, local.file);
    manifest = merged.manifest;
    issues.push(...merged.issues);
  }

  // 先给一个空 issues 的 ctx：合并只读 manifest，新问题由返回值单独带走
  const picked = applyPick({ dir: abs, manifest, graph: undefined as unknown as Graph, issues: [] }, raw);
  return { dir: abs, manifest: picked.ctx.manifest, graph: picked.ctx.graph, issues: [...issues, ...picked.issues] };
}

/**
 * 接线段：能力令牌 → provider、needs 派生的安装边、备选组的有效实现 /
 * 成员 / 被排除的成员与原因。
 *
 * `plan.excluded` 是 `graph.excluded` 的超集（plan 期还多出 host-managed），
 * 所以「为什么没装」以 plan 为准；graph 侧的原因只在这一项计划里没有时兜底。
 * 备选组之外的排除（不属于任何组、被整条计划裁掉）另起一段，不能因为按组打印就丢掉。
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

  say('  备选：');
  if (wiring.alternatives.length === 0) say('    （无）');
  // 被接线段解释过的资源：备选组里落选的成员 + 被计划裁掉的有效实现。其余排除另起一段。
  const covered = new Set<string>();
  for (const alternative of wiring.alternatives) {
    const from =
      alternative.picked !== undefined
        ? 'pick'
        : alternative.effective !== undefined
          ? '唯一候选'
          : '未指定';
    say(`    ${alternative.name}：effective ${alternative.effective ?? '（无）'}（${from}）`);
    // 有效实现也可能被 plan 期规则裁掉（例如 pick 指向只给某个 target 的资源）：原因要露出来
    const effectiveReason =
      alternative.effective !== undefined ? planReason.get(alternative.effective) : undefined;
    if (alternative.effective !== undefined && effectiveReason !== undefined) {
      say(`      ! ${alternative.effective}：${effectiveReason}（这次不会装）`);
      covered.add(alternative.effective);
    }
    say(`      成员：${alternative.members.length > 0 ? alternative.members.join(', ') : '（无）'}`);
    for (const member of alternative.excluded) {
      const reason = planReason.get(member.resource) ?? member.reason;
      say(`      - ${member.resource}：${reason}`);
      covered.add(member.resource);
    }
  }

  // 不属于任何备选组、或者被 plan 期规则整条裁掉的资源也要露出原因（target 裁剪、宿主托管、可选级联）
  const unplaced = planExcluded.filter((e) => !covered.has(e.resource));
  if (unplaced.length > 0) {
    say('  未装（计划期排除）：');
    for (const e of unplaced) {
      say(`    - ${e.resource}${e.alternative ? `（备选组 ${e.alternative}）` : ''}：${e.reason}`);
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
