import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  installPack,
  loadPack,
  planFor,
  readSignatures,
  verifyPack,
  verifySignatures,
} from '@packhub/runtime';

export interface VerifyReport {
  apiVersion: 'packhub.dev/verify/v0';
  planHash: string;
  ok: boolean;
  signatures: { key: string; ok: boolean }[];
  checks: { index: number; type: string; status: string; detail: string }[];
  outcomes: { actionId: string; op: string; status: string }[];
  verifiedAt: string;
  env: { node: string; platform: string; arch: string };
}

export interface RunOptions {
  /** 报告写到哪里；默认不写（只返回） */
  out?: string;
  /** 打印每一步（CI 里有用） */
  log?: (line: string) => void;
}

export interface RunResult {
  report: VerifyReport;
  /** 安装结果里有失败动作时为 false */
  installed: boolean;
}

/**
 * 在一个干净的临时目录里完整走一遍：复制包 → 安装 → 跑校验 → 出报告。
 * 这是发布门禁的执行者，也回答"这个包在别人机器上装得起来吗"。
 */
export async function runPack(packDir: string, opts: RunOptions = {}): Promise<RunResult> {
  const dir = resolve(packDir);
  if (!existsSync(join(dir, 'packhub.yaml'))) {
    throw new Error(`没有 packhub.yaml：${dir}`);
  }

  const log = opts.log ?? (() => {});
  const work = mkdtempSync(join(tmpdir(), 'packhub-run-'));
  try {
    cpSync(dir, work, { recursive: true });
    // 干净环境：不带上一次的安装状态
    rmSync(join(work, '.packhub'), { recursive: true, force: true });

    const ctx = loadPack(work);
    const errors = ctx.issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      for (const e of errors) log(`error ${e.message}`);
      throw new Error(`清单未通过校验：${errors.map((e) => e.message).join('; ')}`);
    }

    const { plan, issues } = planFor(ctx);
    if (!plan) throw new Error(`生成不了计划：${issues.map((i) => i.message).join('; ')}`);

    const result = await installPack(ctx, plan);
    for (const o of result.outcomes) {
      const mark = o.status === 'failed' ? 'x' : o.status === 'skipped' ? '-' : '✓';
      log(`${mark} ${o.actionId.padEnd(16)} ${o.status.padEnd(8)} ${o.message ?? o.target ?? ''}`);
    }

    const checks = verifyPack(ctx.dir, plan);
    for (const c of checks) {
      log(`${c.status === 'pass' ? '✓' : c.status === 'fail' ? 'x' : '-'} [${c.index}] ${c.type} ${c.detail}`);
    }

    const failedActions = result.outcomes.filter((o) => o.status === 'failed').length;
    const ok = failedActions === 0 && checks.every((c) => c.status !== 'fail');
    const pack = `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`;

    const allSigs = [...readSignatures(dir), ...(ctx.manifest.signatures ?? [])];
    const signatures = allSigs.map((s) => {
      const check = verifySignatures([s], pack, plan.planHash)[0];
      return { key: s.key, ok: check?.ok ?? false };
    });

    const report: VerifyReport = {
      apiVersion: 'packhub.dev/verify/v0',
      planHash: plan.planHash,
      ok,
      signatures,
      checks,
      outcomes: result.outcomes.map((o) => ({
        actionId: o.actionId,
        op: o.op,
        status: o.status,
      })),
      verifiedAt: new Date().toISOString(),
      env: { node: process.version, platform: process.platform, arch: process.arch },
    };

    if (opts.out) writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n', 'utf8');
    log(`${ok ? 'verified' : 'not ok'}（${checks.length} 项校验）`);
    return { report, installed: failedActions === 0 };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
