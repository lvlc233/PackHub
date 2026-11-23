// 安装编排：从「一个来源」一步装进「一个项目」。
//
// 两条流，检查强度不同（与旧 CLI install 一致）：
// - 本地 Pack 目录：作者流。目录里的清单直接算计划，不要求锁与签名；
// - 外部来源（.phub / git+https / registry 名）：消费流。先取包，再核对锁与签名，装完复核。
//
// 与旧 CLI 的差别是产品决定：`--no-verify` 与 `--allow-stale-lock` 不再提供——
// 锁与清单对不上就直接报错要求重锁；装完总是复核（只读的 SAFE_CHECK_TYPES + 计划派生项）。
//
// 失败一律抛 `InstallSourceError`：`failure` 是调用方映射退出码的依据（usage=前置条件错，
// runtime=动作失败/复核没过）。已产生的 issue 与部分结果都挂在错误上，调用方二选一打印。

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  harness,
  harnessIds,
  PACKHUB_ENV,
  STATE_DIR,
  checkLockConsistency,
  isHarnessId,
  loadPack,
  mergeLocalOverrides,
  planFor,
  readLocalOverrides,
  validateGraph,
  type HarnessId,
  type Issue,
  type Plan,
  type VerifyCheck,
} from '@packhub/kernel';
import { appendAudit } from './audit.ts';
import { inspectPack, loadLock, withLockPins } from './consume.ts';
import { verifyInstalled, type InstalledVerifyReport } from './installed.ts';
import { applyPlan, type ActionOutcome } from './install.ts';
import { fetchPack } from './registry.ts';
import { resolveRegistry } from './config.ts';
import { resolveAddSource } from './source.ts';
import { signaturePolicy } from './trust.ts';

/**
 * 安装后自动复核只跑只读检查；command / mcp-ready 会执行包里的命令，必须显式另行调用。
 * 与 CLI 的 SAFE_CHECKS 同一份（CLI 下一步改成从这里取）。
 */
export const SAFE_CHECK_TYPES = ['file-exists', 'config-key', 'knowledge-integrity'] as const;

/** 走的哪条流：本地作者目录 / 外部消费来源。 */
export type InstallSourceFlow = 'local' | 'external';

/** 失败的类别：调用方据此映射退出码（usage → 前置条件错，runtime → 运行失败）。 */
export type InstallSourceFailure = 'usage' | 'runtime';

export interface InstallFromSourceOptions {
  /** 来源：本地 Pack 目录、`.phub`、`git+https://…`，或 registry 名（`name` / `name@version`） */
  source: string;
  /** 项目根：装到这里 */
  projectDir: string;
  /** 按哪个宿主的落点表物化；不写 = 平铺目录 */
  harness?: HarnessId;
  /** registry 索引（本地路径或 URL）；registry 名必填，其它来源忽略 */
  index?: string;
  /** registry 版本；与 `name@version` 等价，两个都给且不同就报错 */
  version?: string;
  /** 允许执行清单里的 install.exec */
  allowExec?: boolean;
  /** 允许覆盖别的包写过的普通文件 */
  overwrite?: boolean;
  /** 只算计划不落盘：外部来源的取包/解包都在临时目录，结束就删 */
  dryRun?: boolean;
  /** 外部来源：没有有效签名就拒绝 */
  requireSignature?: boolean;
  /** 外部来源：即使配了信任列表也接受无签名包（显式降低要求） */
  allowUnsigned?: boolean;
  /**
   * 人类可读进度行（stdout 性质）。不传 = 静默，适合脚本/launcher 自己排版。
   * 结构化结果在返回值里，这里只给「正在做什么」。
   */
  log?: (line: string) => void;
  /** 非致命的提醒（例如审计写入失败）；不传 = 丢弃 */
  warn?: (line: string) => void;
  /**
   * 每遇到一条 issue 调一次（按遇到顺序），方便调用方即时打印。
   * 它与 `result.issues` / `error.issues` 是同一份数据：用了流式就别再打印数组，反之亦然。
   */
  onIssue?: (issue: Issue) => void;
  /** dry-run 时把算好的计划交给调用方打印；不传 = 只放在 `result.plan` 里 */
  onPlan?: (plan: Plan) => void;
}

export interface InstallFromSourceResult {
  /** 走的哪条流 */
  flow: InstallSourceFlow;
  /** 原始来源字符串 */
  source: string;
  /** 装的是谁：`name@version`（外部流用 registry 解析出的版本） */
  label: string;
  plan: Plan;
  planHash: string;
  outcomes: ActionOutcome[];
  /** state.json 的位置；dry-run 没有 */
  statePath?: string;
  dryRun: boolean;
  /** 装完复核的报告（`SAFE_CHECK_TYPES` + 派生项）；dry-run 没有 */
  verification?: InstalledVerifyReport[];
  /** 中途遇到的全部 issue（含 warning）；用了 `onIssue` 的话不要再重复打印 */
  issues: Issue[];
}

/** 安装编排失败：`failure` 决定退出码，`issues` 是已经报过的行，`result` 是失败前已拿到的部分结果。 */
export class InstallSourceError extends Error {
  readonly failure: InstallSourceFailure;
  readonly issues: Issue[];
  readonly result?: Partial<InstallFromSourceResult>;

  constructor(
    failure: InstallSourceFailure,
    message: string,
    opts: { issues?: Issue[]; result?: Partial<InstallFromSourceResult> } = {},
  ) {
    super(message);
    this.name = 'InstallSourceError';
    this.failure = failure;
    this.issues = opts.issues ?? [];
    if (opts.result !== undefined) this.result = opts.result;
  }
}

/* ---------- 来源判定 ---------- */

/**
 * 判断 SOURCE 该走哪条路：
 * - `.phub` / `git+…` 明摆着是外部归档/仓库；
 * - 写成路径的样子（.、..、./x、绝对路径）或磁盘上真的存在 → 本地 Pack 目录；
 * - 其余（owner/name）当 registry 名，配 index / version。
 */
export function sourceKindOf(source: string): 'local' | 'external' | 'registry' {
  if (source.endsWith('.phub') || source.startsWith('git+')) return 'external';
  if (isAbsolute(source) || source === '.' || source === '..' || /^\.\.?[\\/]/.test(source)) {
    return 'local';
  }
  return existsSync(source) ? 'local' : 'registry';
}

/** 解析 `name@version`；取最后一个 `@`（包名可能带 owner，版本里不会再有 @）。 */
function parsePackRef(ref: string): { name: string; version: string } | undefined {
  const at = ref.lastIndexOf('@');
  if (at <= 0 || at === ref.length - 1) return undefined;
  return { name: ref.slice(0, at), version: ref.slice(at + 1) };
}

/** `.phub` / `git+https://…` 在项目里的缓存目录名：来源串压成一个稳定 slug。 */
function sourceSlug(source: string): string {
  return source
    .replace(/^git\+/, '')
    .replace(/\.phub$/, '')
    .replace(/[@/\\:]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-48);
}

/* ---------- 流内共用的状态与中止 ---------- */

interface Flow {
  projectDir: string;
  log: (line: string) => void;
  warn?: (line: string) => void;
  onIssue?: (issue: Issue) => void;
  /** 中途遇到的全部 issue（含 warning） */
  issues: Issue[];
  /** 计划选项：只有 harness 一项（不写 = 平铺） */
  planOpts: { harness?: HarnessId };
}

interface LocalFlow extends Flow {
  dryRun: boolean;
  overwrite: boolean;
  allowExec: boolean;
}

interface ExternalFlow extends Flow {
  opts: InstallFromSourceOptions;
}

/** 记一批 issue，返回其中有没有 error（有 error 就该中止）。 */
function note(flow: Flow, list: readonly Issue[]): boolean {
  for (const issue of list) {
    flow.issues.push(issue);
    flow.onIssue?.(issue);
  }
  return list.some((i) => i.severity === 'error');
}

/** 中止这次安装：`failure` 交给调用方映射退出码，已经遇到的 issue 与部分结果一起带走。 */
function bail(
  failure: InstallSourceFailure,
  message: string,
  flow: Flow,
  result?: Partial<InstallFromSourceResult>,
): never {
  throw new InstallSourceError(failure, message, {
    issues: [...flow.issues],
    ...(result !== undefined ? { result } : {}),
  });
}

/* ---------- 主入口 ---------- */

/** 从来源装进项目；成功 = 动作全部落地 + 复核通过。 */
export async function installFromSource(opts: InstallFromSourceOptions): Promise<InstallFromSourceResult> {
  const projectDir = resolve(opts.projectDir);
  const source = opts.source;
  if (opts.harness !== undefined && !isHarnessId(opts.harness)) {
    throw new InstallSourceError(
      'usage',
      `未知宿主：${String(opts.harness)}（可选 ${harnessIds().join(' / ')}；不写 = 平铺目录）`,
    );
  }
  // 有些宿主只有全局目录（hermes 的 ~/.hermes），没有项目级落点：装进项目没有意义
  if (opts.harness !== undefined) {
    const host = harness(opts.harness);
    if (host && host.project === false) {
      throw new InstallSourceError(
        'usage',
        `宿主 ${host.id} 没有项目级安装落点：用 pal install ${source} --new --kind ${host.id} --name <名字> 建环境`,
      );
    }
  }

  const base: Flow = {
    projectDir,
    log: opts.log ?? ((): void => {}),
    ...(opts.warn ? { warn: opts.warn } : {}),
    ...(opts.onIssue ? { onIssue: opts.onIssue } : {}),
    issues: [],
    planOpts: opts.harness ? { harness: opts.harness } : {},
  };

  return sourceKindOf(source) === 'local'
    ? installLocal(source, {
        ...base,
        dryRun: opts.dryRun === true,
        overwrite: opts.overwrite === true,
        allowExec: opts.allowExec === true,
      })
    : installExternal(source, { ...base, opts });
}

/* ---------- 本地作者流 ---------- */

/** 本地 Pack 目录：清单在目录里，作者流不设锁/签名门；装完只读复核。 */
async function installLocal(sourceDir: string, flow: LocalFlow): Promise<InstallFromSourceResult> {
  const { projectDir, log } = flow;
  // 本地目录这条路不消费 local.yaml，但旧字段（如已删的 pick）要让人看见，不能静默
  const local = readLocalOverrides(projectDir);
  if (local.issues.length > 0) note(flow, local.issues);
  const packRoot = resolve(sourceDir);
  const ctx = loadPack(packRoot);
  if (note(flow, ctx.issues)) bail('usage', '清单有错误，未继续安装。', flow);
  const planned = planFor(ctx, flow.planOpts);
  if (!planned.plan) {
    note(flow, planned.issues);
    bail('usage', '生成不了安装计划，未继续。', flow);
  }
  const plan = planned.plan;
  const label = `${plan.pack.name}@${plan.pack.version}`;

  const applied = await applyPlan(plan, {
    root: projectDir,
    packRoot,
    dryRun: flow.dryRun,
    allowExec: flow.allowExec,
    overwrite: flow.overwrite,
  });
  printOutcomes(log, applied.outcomes);
  if (applied.outcomes.some((o) => o.status === 'failed')) {
    bail('runtime', '有动作失败：磁盘按快照回滚（若已回滚），state 未写入。', flow, {
      label,
      plan,
      planHash: plan.planHash,
      outcomes: applied.outcomes,
      dryRun: flow.dryRun,
    });
  }
  if (flow.dryRun) {
    return {
      flow: 'local',
      source: sourceDir,
      label,
      plan,
      planHash: plan.planHash,
      outcomes: applied.outcomes,
      dryRun: true,
      issues: flow.issues,
    };
  }

  log(`\n装到 ${projectDir}`);
  log(`state: ${applied.statePath}`);
  auditInstall(flow, plan, projectDir);
  const verification = await verifyAfter(flow, plan, label);
  return {
    flow: 'local',
    source: sourceDir,
    label,
    plan,
    planHash: plan.planHash,
    outcomes: applied.outcomes,
    statePath: applied.statePath,
    dryRun: false,
    verification,
    issues: flow.issues,
  };
}

/* ---------- 外部消费流 ---------- */

/** 外部来源：取包 → 锁核对 → 签名 → 装 → 复核。 */
async function installExternal(source: string, flow: ExternalFlow): Promise<InstallFromSourceResult> {
  const { opts, projectDir, log } = flow;
  const dryRun = opts.dryRun === true;
  // dry-run 不往项目里落任何东西：取包与解包都在临时目录完成，结束就删
  const workBase = dryRun ? mkdtempSync(join(tmpdir(), 'packhub-install-')) : projectDir;

  try {
    let packDir: string;
    let label: string;

    if (source.endsWith('.phub') || source.startsWith('git+')) {
      packDir = join(workBase, STATE_DIR, 'packs', sourceSlug(source));
      log(`→ 取 ${source} …`);
      const resolved = await resolveAddSource(source, packDir);
      packDir = resolved.dir;
      label = resolved.label;
    } else {
      const indexRef = resolveRegistry(opts.index);
      if (!indexRef) {
        bail(
          'usage',
          `用 registry 名称安装需要一个索引：传 index（路径或 URL），或设 ${PACKHUB_ENV.index}，或在 ~/.packhub/config.json 里配 defaultRegistry`,
          flow,
        );
      }
      // `name@version` 与 version 是同一件事的两种写法；给了两个不同的就直接问清楚
      const ref = parsePackRef(source);
      const name = ref?.name ?? source;
      let version = ref?.version;
      if (opts.version) {
        if (version && version !== opts.version) {
          bail('usage', `版本给了两个：${source} 里写 ${version}，version 是 ${opts.version}；留一个`, flow);
        }
        version = opts.version;
      }
      packDir = join(workBase, STATE_DIR, 'packs', name);
      log(`→ 取 ${name}${version ? `@${version}` : ''} …`);
      const fetched = await fetchPack({
        name,
        index: indexRef,
        ...(version ? { version, allowUnlisted: true } : {}),
        dest: packDir,
      });
      label = `${name}@${fetched.version}`;
    }

    const rawCtx = loadPack(packDir);
    if (!rawCtx.manifest) {
      note(flow, rawCtx.issues);
      bail('usage', '取回来的目录里没有可用的清单，未继续。', flow);
    }
    const read = loadLock(packDir);
    if (read.problem) {
      note(flow, [read.problem]);
      bail('usage', '锁文件读不出来，未继续。', flow);
    }
    const lock = read.lock;
    // 清单里写的是 tag/范围也没关系：按锁把它换成本次要装的 commit/版本
    let ctx = withLockPins(rawCtx, lock);
    if (note(flow, ctx.issues)) bail('usage', '清单有错误，未继续安装。', flow);

    // 锁核对（消费端单点）：判据与文案都来自 kernel 的 checkLockConsistency。
    // 装到哪个宿主不参与核对；宿主由 plan 期按 harness 现算。
    const lockCheck = checkLockConsistency(lock, ctx.manifest);
    // 信任来源：本机持久信任列表（packhub trust add）；有列表就只认列表内的公钥
    const policy = signaturePolicy({
      require: opts.requireSignature === true,
      allowUnsigned: opts.allowUnsigned === true,
    });
    const trusted = (policy.trusted ?? []).length > 0 ? policy.trusted : undefined;
    const inspection = inspectPack(packDir, ctx.manifest, trusted ? { trusted } : {});
    // 锁 ↔ 清单的结论只认 kernel 一处：inspectPack 里的同类比较不再重复采用，
    // 只把它自己的结论带出来；验证报告/签名等 issue 照旧。
    const lockIssues =
      lockCheck.status === 'mismatch'
        ? [
            { code: 'lock-mismatch', severity: 'error' as const, message: lockCheck.message },
            ...inspection.issues.filter((i) => i.code !== 'lock-mismatch'),
          ]
        : inspection.issues;
    if (note(flow, lockIssues)) {
      // 不再提供「锁不一致也硬装」的口子：先重锁再装
      bail('usage', '锁核对未通过，已停止安装；确认来源后重新生成锁（packhub lock）再加装。', flow);
    }
    const goodSignatures = inspection.signatures.filter((s) => s.ok).length;
    const trustedSignatures = trusted
      ? inspection.signatures.filter((s) => s.ok && trusted.includes(s.key)).length
      : goodSignatures;
    if (policy.require && trustedSignatures === 0) {
      bail(
        'usage',
        `这个包没有${policy.trusted ? '被信任列表认可' : '有效'}的签名（默认策略 / 签名要求）。` +
          `\n  先确认发布者，再用 packhub trust add <公钥 id> 加入信任列表；确实不用签名时显式允许无签名。`,
        flow,
      );
    }
    if (inspection.signatures.length > 0) {
      log(
        `签名 ${goodSignatures}/${inspection.signatures.length} 有效${trusted ? `，信任列表内 ${trustedSignatures} 个` : ''}`,
      );
    } else if (!policy.require) {
      log('这个包没有签名（未配置信任列表，按开发者模式继续）');
    }

    // 项目根的 .packhub/local.yaml 只改这次安装：补丁、变量
    const local = readLocalOverrides(projectDir);
    if (local.file) {
      const merged = mergeLocalOverrides(ctx.manifest, local.file);
      const validated = validateGraph(merged.manifest);
      const localIssues = [...local.issues, ...merged.issues, ...validated.issues];
      if (note(flow, localIssues)) {
        bail('usage', 'local.yaml 里有错误，未继续安装。', flow);
      }
      ctx = {
        ...ctx,
        manifest: merged.manifest,
        graph: validated.graph,
        issues: [...ctx.issues, ...localIssues],
      };
      log('已应用 .packhub/local.yaml 补丁');
    }

    const planned = planFor(ctx, flow.planOpts);
    if (!planned.plan) {
      note(flow, planned.issues);
      bail('usage', '生成不了安装计划，未继续。', flow);
    }
    const plan = planned.plan;

    if (dryRun) {
      opts.onPlan?.(plan);
      return {
        flow: 'external',
        source,
        label,
        plan,
        planHash: plan.planHash,
        outcomes: [],
        dryRun: true,
        issues: flow.issues,
      };
    }

    const applied = await applyPlan(plan, {
      root: projectDir,
      packRoot: packDir,
      overwrite: opts.overwrite === true,
      allowExec: opts.allowExec === true,
    });
    printOutcomes(log, applied.outcomes);
    if (applied.outcomes.some((o) => o.status === 'failed')) {
      bail('runtime', '有动作失败：磁盘按快照回滚（若已回滚），state 未写入。', flow, {
        label,
        plan,
        planHash: plan.planHash,
        outcomes: applied.outcomes,
        dryRun: false,
      });
    }
    log(`\n装上 ${label} → ${projectDir}`);
    auditInstall(flow, plan, projectDir);

    const verification = await verifyAfter(flow, plan, label);
    return {
      flow: 'external',
      source,
      label,
      plan,
      planHash: plan.planHash,
      outcomes: applied.outcomes,
      statePath: applied.statePath,
      dryRun: false,
      verification,
      issues: flow.issues,
    };
  } finally {
    // dry-run 的临时取包目录用完就删；真装的缓存留在项目里，下次可复用
    if (dryRun) rmSync(workBase, { recursive: true, force: true });
  }
}

/* ---------- 装后复核与审计 ---------- */

/** 装完立刻复核：只读的 SAFE_CHECK_TYPES + 计划派生项（知识文件哈希等）。 */
async function verifyAfter(flow: Flow, plan: Plan, label: string): Promise<InstalledVerifyReport[]> {
  // 复核按「清单里的包名@版本」查 state；label 只是来源标签（.phub 时是路径），不能拿来当键
  const key = `${plan.pack.name}@${plan.pack.version}`;
  const checked = await verifyInstalled(flow.projectDir, {
    pack: key,
    types: [...SAFE_CHECK_TYPES] as VerifyCheck['type'][],
  });
  for (const report of checked) {
    flow.log(`\n校验 ${report.pack}：${report.ok ? '通过' : '未通过'}`);
    for (const check of report.results) {
      const mark = check.status === 'pass' ? '✓' : check.status === 'fail' ? 'x' : '-';
      flow.log(
        `  ${mark} [${check.index}] ${check.type.padEnd(18)} ${check.status.padEnd(8)} ${check.detail}`,
      );
    }
  }
  if (!checked.every((r) => r.ok)) {
    bail('runtime', '装上了，但有校验没过；先修清单里的 verify 或确认环境。', flow, {
      label,
      plan,
      planHash: plan.planHash,
      dryRun: false,
      verification: checked,
    });
  }
  return checked;
}

/** 审计只在「真装成功、state 已落盘」之后写：dry-run 与回滚路径不写，写失败只提醒。 */
function auditInstall(flow: Flow, plan: Plan, projectDir: string): void {
  try {
    appendAudit({
      action: 'install',
      pack: plan.pack.name,
      version: plan.pack.version,
      planHash: plan.planHash,
      ok: true,
      root: projectDir,
    });
  } catch (err) {
    flow.warn?.(`审计写入失败：${(err as Error).message}`);
  }
}

function printOutcomes(log: (line: string) => void, outcomes: readonly ActionOutcome[]): void {
  for (const o of outcomes) {
    const mark = o.status === 'failed' ? 'x' : o.status === 'skipped' ? '-' : '✓';
    log(`${mark} ${o.actionId.padEnd(16)} ${o.status.padEnd(14)} ${o.message ?? o.target ?? ''}`);
  }
}
