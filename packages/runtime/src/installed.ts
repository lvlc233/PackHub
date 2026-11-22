import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PlanSnapshot, VerifyCheck } from '@packhub/kernel';
import { STATE_FILE } from '@packhub/kernel';
import { checksWithDerived } from './derived-checks.ts';
import { loadState } from './install.ts';
import { runChecks, serverSpecs, type CheckResult } from './verify.ts';

export interface InstalledVerifyReport {
  pack: string;
  planHash: string;
  installedAt: string;
  /** state 里存的计划快照；没有就是记录不完整 */
  plan?: PlanSnapshot;
  results: CheckResult[];
  ok: boolean;
}

export interface InstalledVerifyOptions {
  /** 只验这个包（name@version） */
  pack?: string;
  /** 只跑这些检查类型；安装后自动复核默认只跑只读的三类 */
  types?: VerifyCheck['type'][];
  /** 再对计划里的每个 MCP server 真发一次 initialize；会起进程 / 联网，默认关 */
  probeMcp?: boolean;
}

/**
 * 验一个「已经装进项目」的包：计划来自 state 里的快照，检查根就是项目根。
 * 这条路径不要求项目里有 packhub.yaml —— install 装进来的包，清单在 .packhub/packs/ 下。
 */
export async function verifyInstalled(
  root: string,
  opts: InstalledVerifyOptions = {},
): Promise<InstalledVerifyReport[]> {
  const state = loadState(root);
  const keys = opts.pack ? [opts.pack] : Object.keys(state.packs);
  const out: InstalledVerifyReport[] = [];

  for (const key of keys) {
    const record = state.packs[key];
    if (!record) {
      out.push({
        pack: key,
        planHash: '',
        installedAt: '',
        results: [
          {
            index: 0,
            type: 'file-exists',
            status: 'skipped',
            detail: `state 里没有这个包：${key}`,
          },
        ],
        ok: false,
      });
      continue;
    }

    const plan = record.plan;
    if (!plan) {
      out.push({
        pack: key,
        planHash: record.planHash,
        installedAt: record.installedAt,
        results: [
          {
            index: 0,
            type: 'file-exists',
            status: 'fail',
            detail: 'state 缺少安装计划快照（记录不完整），重装后再验',
          },
        ],
        ok: false,
      });
      continue;
    }

    // 作者写的检查 + 从计划派生的（带 integrity 的 write → knowledge-integrity）。
    // 安装后的自动复核也走这里，于是它自动带上只读的派生项，作者不用手写。
    const all = checksWithDerived(plan, plan.verify, opts.probeMcp ? { probeMcp: true } : {});
    const checks = opts.types ? all.filter((c) => opts.types!.includes(c.type)) : all;
    const results = await runChecks(checks, { root, servers: serverSpecs(plan) });
    out.push({
      pack: key,
      planHash: record.planHash,
      installedAt: record.installedAt,
      plan,
      results,
      // 和 runner 的发布门禁同一判据：只有每项检查都 pass 才算完成。
      // skipped 表示这项没验过（缺规格/类型未知），不能当成通过。
      ok: results.every((r) => r.status === 'pass'),
    });
  }
  return out;
}

/**
 * 目录里是否有安装记录。
 *
 * 只在 `verifyAt` 判「项目模式 / Pack 模式」时用它；命令层不要再自己判一次。
 */
export function hasInstalledPacks(root: string): boolean {
  const statePath = join(root, STATE_FILE);
  if (!existsSync(statePath)) return false;
  try {
    return Object.keys(loadState(root).packs).length > 0;
  } catch {
    return false;
  }
}
