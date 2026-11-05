/**
 * 计划层基准：生成 N 个资源的包，量 loadPack + planFor 的耗时。
 * 用法：pnpm bench [资源数] [--check]
 * --check 时超过预算（默认 1500ms/次）返回 1，给 CI 用。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor } from '../packages/kernel/src/index.ts';

const args = process.argv.slice(2);
const check = args.includes('--check');
const withInstall = args.includes('--install');
const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 200);
const budgetMs = Number(process.env.PACKHUB_BENCH_BUDGET_MS ?? 1500);
const rounds = 10;

const dir = mkdtempSync(join(tmpdir(), 'packhub-bench-'));
const lines: string[] = [];
for (let i = 0; i < count; i++) {
  writeFileSync(join(dir, `r${i}.md`), `# resource ${i}\n`, 'utf8');
  lines.push(`  - id: r${i}\n    type: knowledge\n    source: ./r${i}.md`);
}
writeFileSync(
  join(dir, 'packhub.yaml'),
  `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/bench, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
${lines.join('\n')}
`,
  'utf8',
);

const samples: number[] = [];
let actionCount = 0;
let lastPlan: ReturnType<typeof planFor>['plan'];
let lastCtx: ReturnType<typeof loadPack> | undefined;
for (let i = 0; i < rounds; i++) {
  const start = performance.now();
  const ctx = loadPack(dir);
  const result = planFor(ctx);
  actionCount = result.plan?.actions.length ?? 0;
  samples.push(performance.now() - start);
  lastPlan = result.plan;
  lastCtx = ctx;
}
samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)]!;
const p95 = samples[Math.floor(samples.length * 0.95)]!;
console.log(
  `${count} 个资源 · ${actionCount} 个动作 · 中位 ${median.toFixed(1)}ms · p95 ${p95.toFixed(1)}ms · 预算 ${budgetMs}ms`,
);
if (check && median > budgetMs) {
  console.error(`计划耗时超过预算：${median.toFixed(1)}ms > ${budgetMs}ms`);
  process.exit(1);
}

if (withInstall && lastPlan && lastCtx) {
  const { installPack } = await import('../packages/runtime/src/index.ts');
  const project = mkdtempSync(join(tmpdir(), 'packhub-bench-proj-'));
  const start = performance.now();
  const result = await installPack(lastCtx, lastPlan, { root: project, packRoot: dir });
  const ms = performance.now() - start;
  const bad = result.outcomes.filter((o) => o.status !== 'done' && o.status !== 'noop').length;
  console.log(`安装 ${count} 个资源：${ms.toFixed(0)}ms · 失败 ${bad}`);
  rmSync(project, { recursive: true, force: true });
}