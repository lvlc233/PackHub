import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  installPack,
  loadPack,
  loadPackResolved,
  loadLock,
  planFor,
  readSignatures,
  verifyPack,
  verifySignatures,
  withLockPins,
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
  /** 允许执行清单里的 install.exec（默认不执行） */
  allowExec?: boolean;
  /** 解析远程 extends 用的 registry 索引；默认取 PACKHUB_INDEX */
  index?: string;
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

    const ctx = withLockPins(
      await loadPackResolved(work, {
        ...(opts.index ? { index: opts.index } : {}),
      }),
      loadLock(work),
    );
    const errors = ctx.issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      for (const e of errors) log(`error ${e.message}`);
      throw new Error(`清单未通过校验：${errors.map((e) => e.message).join('; ')}`);
    }
    if (!ctx.manifest.metadata.targets.includes('dir')) {
      throw new Error('发布门禁只验证 dir target，但清单没有声明 dir');
    }

    const { plan, issues } = planFor(ctx);
    if (!plan) throw new Error(`生成不了计划：${issues.map((i) => i.message).join('; ')}`);

    const result = await installPack(ctx, plan, { allowExec: opts.allowExec === true });
    for (const o of result.outcomes) {
      const mark =
        o.status === 'failed' ? 'x' : o.status === 'needs-approval' ? '!' : o.status === 'skipped' ? '-' : '✓';
      log(`${mark} ${o.actionId.padEnd(16)} ${o.status.padEnd(8)} ${o.message ?? o.target ?? ''}`);
    }

    const checks = await verifyPack(ctx.dir, plan);
    for (const c of checks) {
      log(`${c.status === 'pass' ? '✓' : c.status === 'fail' ? 'x' : '-'} [${c.index}] ${c.type} ${c.detail}`);
    }

    // 只有每一步都 done/noop、每项检查都 pass，才算这份报告通过。
    // needs-approval / skipped 意味着安装并未真正完成，不能标 verified。
    const incomplete = result.outcomes.filter((o) => o.status !== 'done' && o.status !== 'noop').length;
    const checksOk = checks.every((c) => c.status === 'pass');
    const ok = incomplete === 0 && checksOk;
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
    return { report, installed: incomplete === 0 };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
