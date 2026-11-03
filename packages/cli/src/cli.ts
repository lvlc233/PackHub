import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineCommand, type CommandDef } from 'citty';
import {
  buildLock,
  installPack,
  loadPack,
  planFor,
  verifyPack,
  type Issue,
  type Plan,
} from '@packhub/core';

const errorCount = (issues: Issue[]): number => issues.filter((i) => i.severity === 'error').length;

function reportIssues(issues: Issue[], ctx = 'packhub'): boolean {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  for (const w of warnings) console.warn(`warn  [${w.code}] ${w.message}`);
  for (const e of errors) console.error(`error [${e.code}] ${e.message}`);
  if (errors.length) {
    console.error(`\n${ctx}: ${errors.length} 个错误，未继续。`);
    return true;
  }
  return false;
}

function printPlan(plan: Plan): void {
  console.log(`${plan.pack.name}@${plan.pack.version} → target=${plan.target}`);
  console.log(`planHash ${plan.planHash}\n`);
  for (const a of plan.actions) {
    const target = 'to' in a ? a.to : 'dest' in a ? a.dest : 'path' in a ? a.path : a.resource ?? '';
    console.log(`  ${a.actionId.padEnd(16)} ${a.op.padEnd(14)} ${target}`);
  }
  console.log(`\nverify: ${plan.verify.length} 项`);
}

const plan = defineCommand({
  meta: { name: 'plan', description: '解析 Pack 并打印安装计划（不落盘）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const ctx = loadPack(String(args.dir));
    if (reportIssues(ctx.issues)) process.exit(2);
    const { plan: p, issues } = planFor(ctx);
    if (!p) {
      reportIssues(issues);
      process.exit(2);
    }
    if (args.json) console.log(JSON.stringify(p, null, 2));
    else printPlan(p);
  },
});

const install = defineCommand({
  meta: { name: 'install', description: '执行计划（dir adapter）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    'dry-run': { type: 'boolean', default: false },
    'allow-exec': { type: 'boolean', default: false },
  },
  async run({ args }) {
    const ctx = loadPack(String(args.dir));
    if (reportIssues(ctx.issues)) process.exit(2);
    const { plan: p, issues } = planFor(ctx);
    if (!p) {
      reportIssues(issues);
      process.exit(2);
    }
    const result = await installPack(ctx, p, {
      dryRun: Boolean(args['dry-run']),
      allowExec: Boolean(args['allow-exec']),
    });
    for (const o of result.outcomes) {
      const mark = o.status === 'failed' ? 'x' : o.status === 'skipped' ? '-' : '✓';
      console.log(`${mark} ${o.actionId.padEnd(16)} ${o.status.padEnd(14)} ${o.message ?? o.target ?? ''}`);
    }
    if (result.outcomes.some((o) => o.status === 'failed')) process.exit(1);
    if (!args['dry-run']) console.log(`\nstate: ${result.statePath}`);
  },
});

const verify = defineCommand({
  meta: { name: 'verify', description: '跑 manifest 的 verify 检查' },
  args: { dir: { type: 'positional', required: false, default: '.' } },
  run({ args }) {
    const ctx = loadPack(String(args.dir));
    if (reportIssues(ctx.issues)) process.exit(2);
    const { plan: p, issues } = planFor(ctx);
    if (!p) {
      reportIssues(issues);
      process.exit(2);
    }
    const results = verifyPack(ctx.dir, p);
    for (const r of results) {
      const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? 'x' : '-';
      console.log(`${mark} [${r.index}] ${r.type.padEnd(18)} ${r.status.padEnd(8)} ${r.detail}`);
    }
    const failed = results.filter((r) => r.status === 'fail').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    console.log(`\n${results.length} 项：${results.length - failed - skipped} 通过 / ${failed} 失败 / ${skipped} 跳过`);
    if (failed) process.exit(1);
  },
});

const lock = defineCommand({
  meta: { name: 'lock', description: '生成 packhub.lock.json' },
  args: { dir: { type: 'positional', required: false, default: '.' } },
  run({ args }) {
    const ctx = loadPack(String(args.dir));
    if (reportIssues(ctx.issues)) process.exit(2);
    const { plan: p, issues } = planFor(ctx);
    if (!p) {
      reportIssues(issues);
      process.exit(2);
    }
    const lockFile = buildLock(ctx.manifest, p);
    const out = join(ctx.dir, 'packhub.lock.json');
    writeFileSync(out, JSON.stringify(lockFile, null, 2) + '\n', 'utf8');
    console.log(`written ${out}\nplanHash ${p.planHash}`);
  },
});

const init = defineCommand({
  meta: { name: 'init', description: '脚手架一个空 Pack' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    name: { type: 'string', required: true },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const file = join(dir, 'packhub.yaml');
    if (existsSync(file)) {
      console.error(`已存在：${file}`);
      process.exit(1);
    }
    mkdirSync(join(dir, 'resources'), { recursive: true });
    const template = `apiVersion: packhub.dev/v0.0.1
kind: Pack

metadata:
  name: ${String(args.name)}
  version: 0.0.1
  title: 未命名整合包
  description: 一句话说清这个 Pack 替使用者完成了哪些整合工作。
  targets: [dir]

requires:
  packhub: ">=0.0.1 <0.1"

resources:
  - id: example-knowledge
    type: knowledge
    source: ./resources/example.md

verify:
  - type: file-exists
    path: "\${target.knowledgeDir}/example-knowledge.md"
`;
    writeFileSync(file, template, 'utf8');
    writeFileSync(join(dir, 'resources', 'example.md'), '# 示例知识\n\n替换成真实内容。\n', 'utf8');
    console.log(`created ${file}`);
  },
});

const search = defineCommand({
  meta: { name: 'search', description: '在静态索引里搜索（v0.0.2：需要 registry index.json）' },
  args: { keyword: { type: 'positional', required: false } },
  run() {
    console.error('search: v0.0.1 还没有 registry index，先把 plan/install/verify 闭环跑通。');
    process.exit(3);
  },
});

const serve = defineCommand({
  meta: { name: 'serve', description: '起本地控制面板（API + 静态产物）' },
  args: {
    dir: { type: 'positional', required: false, default: '.', description: '仓库根目录' },
    port: { type: 'string', default: '5317' },
  },
  async run({ args }) {
    const { startServer, defaultStaticDir } = await import('./server.ts');
    const root = resolve(String(args.dir));
    const port = Number(args.port);
    const server = await startServer({ root, port, staticDir: defaultStaticDir() });
    console.log(`PackHub 面板：http://127.0.0.1:${port}  (root=${root})`);
    void server;
  },
});

export const main: CommandDef = defineCommand({
  meta: { name: 'packhub', version: '0.0.1', description: 'Agent 能力的整合包工具' },
  subCommands: { plan, install, verify, lock, init, serve, search },
});
