#!/usr/bin/env node
// 在干净目录里装一遍并校验，把结果写成 verify.json。
// 用法：node --experimental-strip-types scripts/registry/verify-pack.mjs <pack-version-dir>
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  installPack,
  loadPack,
  planFor,
  verifyPack,
  verifySignatures,
  readSignatures,
} from '../../packages/runtime/src/index.ts';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: verify-pack.mjs <pack-version-dir>');
  process.exit(2);
}

const dir = resolve(arg);
const manifestPath = join(dir, 'packhub.yaml');
if (!existsSync(manifestPath)) {
  console.error(`没有 packhub.yaml：${dir}`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'packhub-verify-'));
let exitCode = 0;

try {
  cpSync(dir, work, { recursive: true });
  // 干净环境：不留上一次的安装状态
  rmSync(join(work, '.packhub'), { recursive: true, force: true });

  const ctx = loadPack(work);
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    for (const e of errors) console.error(`error ${e.message}`);
    console.error('清单未通过校验，未安装。');
    process.exit(1);
  }

  const { plan, issues } = planFor(ctx);
  if (!plan) {
    for (const i of issues) console.error(`error ${i.message}`);
    process.exit(1);
  }

  const result = await installPack(ctx, plan);
  for (const o of result.outcomes) {
    const mark = o.status === 'failed' ? 'x' : o.status === 'skipped' ? '-' : '✓';
    console.log(`${mark} ${o.actionId.padEnd(16)} ${o.status.padEnd(8)} ${o.message ?? o.target ?? ''}`);
  }

  const checks = verifyPack(ctx.dir, plan);
  for (const c of checks) {
    console.log(`${c.status === 'pass' ? '✓' : c.status === 'fail' ? 'x' : '-'} [${c.index}] ${c.type} ${c.detail}`);
  }

  const failedActions = result.outcomes.filter((o) => o.status === 'failed').length;
  const ok = failedActions === 0 && checks.every((c) => c.status !== 'fail');

  const allSigs = [...readSignatures(dir), ...(ctx.manifest.signatures ?? [])];
  const signatures = allSigs.map((s) => ({
    key: s.key,
    ...(verifySignatures([s], `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`, plan.planHash)[0] ?? {
      ok: false,
    }),
  }));

  const report = {
    apiVersion: 'packhub.dev/verify/v0',
    planHash: plan.planHash,
    ok,
    signatures,
    checks,
    outcomes: result.outcomes.map((o) => ({ actionId: o.actionId, op: o.op, status: o.status })),
    verifiedAt: new Date().toISOString(),
    env: { node: process.version, platform: process.platform, arch: process.arch },
  };
  writeFileSync(join(dir, 'verify.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\n${ok ? 'verified' : 'not ok'} → verify.json（${checks.length} 项校验）`);
  exitCode = ok ? 0 : 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exit(exitCode);
