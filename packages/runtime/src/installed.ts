import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan, VerifyCheck } from '@packhub/kernel';
import { loadState } from './install.ts';
import { runChecks, serverSpecs, type CheckResult } from './verify.ts';

export interface InstalledVerifyReport {
  pack: string;
  planHash: string;
  installedAt: string;
  /** state 里存的计划快照；旧版安装没有时为 undefined */
  plan?: Plan;
  results: CheckResult[];
  ok: boolean;
}

export interface InstalledVerifyOptions {
  /** 只验这个包（name@version） */
  pack?: string;
  /** 只跑这些检查类型；安装后自动复核默认只跑只读的三类 */
  types?: VerifyCheck['type'][];
}

/**
 * 验一个「已经装进项目」的包：计划来自 state 里的快照，检查根就是项目根。
 * 这条路径不要求项目里有 packhub.yaml —— add 装进来的包，清单在 .packhub/packs/ 下。
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
            status: 'skipped',
            detail: 'state 里没有计划快照（旧版安装），重装一次再验',
          },
        ],
        ok: false,
      });
      continue;
    }

    const checks = opts.types
      ? plan.verify.filter((c) => opts.types!.includes(c.type))
      : plan.verify;
    const results = await runChecks(checks, { root, servers: serverSpecs(plan) });
    out.push({
      pack: key,
      planHash: record.planHash,
      installedAt: record.installedAt,
      plan,
      results,
      ok: results.every((r) => r.status !== 'fail'),
    });
  }
  return out;
}

/** 目录里是否有安装记录（用于决定 verify 走「项目」还是「Pack」模式）。 */
export function hasInstalledPacks(root: string): boolean {
  const statePath = join(root, '.packhub/state.json');
  if (!existsSync(statePath)) return false;
  try {
    return Object.keys(loadState(root).packs).length > 0;
  } catch {
    return false;
  }
}
