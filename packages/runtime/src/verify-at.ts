import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  loadPack,
  planFor,
  MANIFEST_FILE,
  type HarnessId,
  type Issue,
  type Plan,
} from '@packhub/kernel';
import { checksWithDerived } from './derived-checks.ts';
import { hasInstalledPacks, verifyInstalled, type InstalledVerifyReport } from './installed.ts';
import { runChecks, serverSpecs, type CheckResult } from './verify.ts';

/** verify 走哪条路：项目模式（state 里的已装包）还是 Pack 模式（目录里的清单）。 */
export type VerifyMode = 'installed' | 'pack';

export interface VerifyAtOptions {
  /** 只验某个已装包（name@version）；只在项目模式生效 */
  pack?: string;
  /** Pack 模式的宿主；项目模式不看它（计划来自 state 快照）。不写 = 平铺目录 */
  harness?: HarnessId;
  /** 再对计划里的每个 MCP server 真发一次 initialize；会起进程 / 联网，默认关 */
  probeMcp?: boolean;
}

/**
 * `packhub verify` 的一次结果。命令层只拿它打印与映射退出码，
 * 不再自己判「有没有清单 / 有没有装过包」。
 *
 * 两种模式的输出形状本来就不同（项目模式按包分组、Pack 模式是单份计划），
 * 这里把「验哪些、怎么算失败」收成一份数据：
 * - `ready=false`：清单或计划有问题（或算不出计划），命令层打印 `issues` 后按退出码 2 退出；
 * - `failed`：项目模式里 `ok=false` 的包也算一条，与搬到 runtime 前 verify 的退出码判据一致。
 */
export interface VerifyAtResult {
  mode: VerifyMode;
  /** 清单/计划的问题；warning 也要打印，不以有没有 error 决定 */
  issues: Issue[];
  ready: boolean;
  /** 项目模式按包分组的报告；Pack 模式为空 */
  installed: InstalledVerifyReport[];
  /** 摊平后的检查结果，两种模式都是它，命令层逐行打印 */
  results: CheckResult[];
  /** 计划哈希；项目模式没有单一计划，为空串 */
  planHash: string;
  failed: number;
  skipped: number;
}

/**
 * 在某个目录上验：先判模式，再各自跑。
 *
 * 模式判定只在这里：`install` 装进来的包没有 `packhub.yaml`，计划和安装根都在 state 里。
 * 两者都成立（目录里既有清单、又装过包）时按 Pack 模式走——目录里的清单是更明确的
 * 意图，这一优先级与挪动之前逐字一致。
 */
export async function verifyAt(root: string, opts: VerifyAtOptions = {}): Promise<VerifyAtResult> {
  const dir = resolve(root);

  if (!existsSync(join(dir, MANIFEST_FILE)) && hasInstalledPacks(dir)) {
    const reports = await verifyInstalled(dir, {
      ...(opts.pack ? { pack: opts.pack } : {}),
      ...(opts.probeMcp ? { probeMcp: true } : {}),
    });
    let failed = 0;
    let skipped = 0;
    for (const report of reports) {
      failed += report.results.filter((r) => r.status === 'fail').length;
      skipped += report.results.filter((r) => r.status === 'skipped').length;
      if (!report.ok) failed++;
    }
    return {
      mode: 'installed',
      issues: [],
      ready: true,
      installed: reports,
      results: reports.flatMap((r) => r.results),
      planHash: '',
      failed,
      skipped,
    };
  }

  const ctx = loadPack(dir);
  const issues = [...ctx.issues];
  let plan: Plan | undefined;
  // 清单有 error 时 planFor 只会把 error 再抛一遍，所以先短路；warning 照旧累积下来
  if (!issues.some((i) => i.severity === 'error')) {
    const planned = planFor(ctx, opts.harness ? { harness: opts.harness } : {});
    issues.push(...planned.issues);
    plan = planned.plan;
  }
  if (!plan) {
    return {
      mode: 'pack',
      issues,
      ready: false,
      installed: [],
      results: [],
      planHash: '',
      failed: 0,
      skipped: 0,
    };
  }

  // 作者写的检查 + 从计划派生出来的（带 integrity 的 write → knowledge-integrity）；
  // --probe-mcp 时再追加 MCP 探活
  const checks = checksWithDerived(plan, plan.verify, opts.probeMcp ? { probeMcp: true } : {});
  const results = await runChecks(checks, { root: ctx.dir, servers: serverSpecs(plan) });
  return {
    mode: 'pack',
    issues,
    ready: true,
    installed: [],
    results,
    planHash: plan.planHash,
    failed: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };
}
