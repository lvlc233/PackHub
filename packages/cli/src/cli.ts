import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineCommand, type CommandDef } from 'citty';
import {
  addResource,
  addSignature,
  inspectLicenses,
  generateKeyPair,
  signPlan,
  verifySignatures,
  setBinding,
  buildLock,
  diffActions,
  describeAction,
  removePack,
  rollbackPack,
  packArchive,
  fetchPack,
  updatePack,
  resolveAddSource,
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
    target: { type: 'string', default: 'dir', description: 'dir | dsh | claude-code' },
  },
  run({ args }) {
    const ctx = loadPack(String(args.dir));
    if (reportIssues(ctx.issues)) process.exit(2);
    const { plan: p, issues } = planFor(ctx, { target: String(args.target ?? 'dir') as never });
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
    overwrite: { type: 'boolean', default: false, description: '允许覆盖别的包写过的文件' },
    target: { type: 'string', default: 'dir', description: 'dir | dsh | claude-code' },
  },
  async run({ args }) {
    const ctx = loadPack(String(args.dir));
    if (reportIssues(ctx.issues)) process.exit(2);
    const { plan: p, issues } = planFor(ctx, { target: String(args.target ?? 'dir') as never });
    if (!p) {
      reportIssues(issues);
      process.exit(2);
    }
    const result = await installPack(ctx, p, {
      dryRun: Boolean(args['dry-run']),
      allowExec: Boolean(args['allow-exec']),
      overwrite: Boolean(args.overwrite),
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
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    target: { type: 'string', default: 'dir', description: 'dir | dsh | claude-code' },
  },
  run({ args }) {
    const ctx = loadPack(String(args.dir));
    if (reportIssues(ctx.issues)) process.exit(2);
    const { plan: p, issues } = planFor(ctx, { target: String(args.target ?? 'dir') as never });
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
    const { plan: p, issues } = planFor(ctx, { target: String(args.target ?? 'dir') as never });
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
    const template = `# yaml-language-server: $schema=https://raw.githubusercontent.com/lvlc233/PackHub/main/schema/packhub.v0.schema.json
apiVersion: packhub.dev/v0
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
    # provides: [knowledge:your_thing]   # 只有需要被别的资源依赖时才写

verify:
  - type: file-exists
    path: "\${target.knowledgeDir}/example.md"
`;
    writeFileSync(file, template, 'utf8');
    writeFileSync(join(dir, 'resources', 'example.md'), '# 示例知识\n\n替换成真实内容。\n', 'utf8');
    console.log(`created ${file}`);
    console.log('下一步：packhub resource add <type> <source> 追加资源，然后 packhub plan 看动作');
  },
});

const RESOURCE_TYPES = ['mcp', 'skill', 'prompt', 'knowledge', 'config', 'tool'] as const;

const resourceAdd = defineCommand({
  meta: { name: 'add', description: '往 packhub.yaml 追加一个资源（结构化编辑，保留注释）' },
  args: {
    type: {
      type: 'positional',
      required: true,
      description: `资源类型：${RESOURCE_TYPES.join(' / ')}`,
    },
    source: {
      type: 'positional',
      required: true,
      description: 'npm: pypi: github: https:// 或 ./相对路径',
    },
    dir: { type: 'string', default: '.', description: 'Pack 目录' },
    id: { type: 'string', description: '自定义资源 id（默认从 source 推断）' },
  },
  run({ args }) {
    const type = String(args.type) as (typeof RESOURCE_TYPES)[number];
    if (!RESOURCE_TYPES.includes(type)) {
      console.error(`未知类型：${type}（可选：${RESOURCE_TYPES.join(' / ')}）`);
      process.exit(2);
    }
    const dir = resolve(String(args.dir));
    const file = join(dir, 'packhub.yaml');
    if (!existsSync(file)) {
      console.error(`没有 packhub.yaml：${file}（先跑 packhub init）`);
      process.exit(2);
    }

    const { id } = addResource(file, {
      type,
      source: String(args.source),
      ...(args.id ? { id: String(args.id) } : {}),
    });
    console.log(`✓ 已追加资源 ${id}（${type}）→ ${file}`);

    // 加完立刻重算：格式对不对、能力图缺不缺，当场能看到
    const ctx = loadPack(dir);
    const errors = ctx.issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      for (const e of errors) console.error(`error [${e.code}] ${e.message}`);
      console.error('\n资源已写入，但清单还有错误，先修完再安装。');
      process.exit(1);
    }
    const { plan } = planFor(ctx, { target: String(args.target ?? 'dir') as never });
    console.log(`计划：${plan?.actions.length ?? 0} 个动作 · planHash ${plan?.planHash.slice(0, 22)}…`);
    console.log('下一步：packhub install . --dry-run 看会发生什么');
  },
});

const resource = defineCommand({
  meta: { name: 'resource', description: '资源编辑' },
  subCommands: { add: resourceAdd },
});

const slotSwap = defineCommand({
  meta: { name: 'swap', description: '换某个槽位的实现（只改 bindings 一行）' },
  args: {
    slot: { type: 'positional', required: true },
    resource: { type: 'positional', required: true, description: '占该槽位的资源 id' },
    dir: { type: 'string', default: '.' },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const file = join(dir, 'packhub.yaml');
    if (!existsSync(file)) {
      console.error(`没有 packhub.yaml：${file}`);
      process.exit(2);
    }
    const before = planFor(loadPack(dir)).plan;

    setBinding(file, String(args.slot), String(args.resource));
    console.log(`✓ bindings.${String(args.slot)} → ${String(args.resource)}`);

    const ctx = loadPack(dir);
    const errors = ctx.issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      for (const e of errors) console.error(`error [${e.code}] ${e.message}`);
      process.exit(1);
    }
    const { plan, issues } = planFor(ctx, { target: String(args.target ?? 'dir') as never });
    if (!plan) {
      reportIssues(issues, 'packhub slot swap');
      process.exit(1);
    }
    const after = plan;
    // 换绑时 actionId（fetch#1）不变，必须按内容比，否则看不出换了什么
    const fp = (a: { op: string } & Record<string, unknown>): string =>
      JSON.stringify({ ...a, actionId: undefined, dependsOn: undefined });
    const beforeSet = new Set((before?.actions ?? []).map((a) => fp(a as never)));
    const afterSet = new Set((after?.actions ?? []).map((a) => fp(a as never)));
    const describe = (a: { op: string } & Record<string, unknown>): string => {
      const target = (a.to ?? a.dest ?? a.path ?? a.uri ?? a.resource ?? '') as string;
      return `${a.op} ${target}`.trim();
    };
    const removed = (before?.actions ?? []).filter((a) => !afterSet.has(fp(a as never)));
    const added = (after?.actions ?? []).filter((a) => !beforeSet.has(fp(a as never)));
    console.log(`计划：${after?.actions.length ?? 0} 个动作（+${added.length} / -${removed.length}）`);
    for (const a of removed) console.log(`  - ${describe(a as never)}`);
    for (const a of added) console.log(`  + ${describe(a as never)}`);
    for (const e of after?.excluded ?? []) console.log(`  · 跳过 ${e.resource}（槽位 ${e.slot} 未绑定）`);
    console.log(`planHash ${after?.planHash.slice(0, 22) ?? '—'}…`);
  },
});

const slot = defineCommand({
  meta: { name: 'slot', description: '槽位操作（可替换的实现）' },
  subCommands: { swap: slotSwap },
});

const add = defineCommand({
  meta: { name: 'add', description: '装一个包：registry 名称、.phub 归档，或 git+https 仓库' },
  args: {
    source: {
      type: 'positional',
      required: true,
      description: 'scope/name（配合 --index）、./x.phub，或 git+https://github.com/o/r@ref',
    },
    index: { type: 'string', description: 'registry 的 index.json（本地路径或 URL）' },
    version: { type: 'string', description: 'registry 包的版本，默认 latest' },
    dir: { type: 'string', default: '.', description: '项目目录' },
    target: { type: 'string', default: 'dir', description: 'dir | dsh | claude-code' },
    'dry-run': { type: 'boolean', default: false },
    overwrite: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const projectDir = resolve(String(args.dir));
    const target = String(args.source);
    const targetEnv = String(args.target);

    let packDir: string;
    let label: string;

    if (target.endsWith('.phub') || target.startsWith('git+')) {
      const slug = target
        .replace(/^git\+/, '')
        .replace(/\.phub$/, '')
        .replace(/[@/\\:]/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(-48);
      packDir = join(projectDir, '.packhub/packs', slug);
      console.log(`→ 取 ${target} …`);
      const resolved = await resolveAddSource(target, packDir);
      packDir = resolved.dir;
      label = resolved.label;
    } else {
      if (!args.index) {
        console.error('用 registry 名称安装需要 --index（也可以用 .phub 或 git+https://…）');
        process.exit(2);
      }
      packDir = join(projectDir, '.packhub/packs', target);
      console.log(`→ 取 ${target}${args.version ? `@${args.version}` : ''} …`);
      const fetched = await fetchPack({
        name: target,
        index: String(args.index),
        ...(args.version ? { version: String(args.version), allowUnlisted: true } : {}),
        dest: packDir,
      });
      label = `${target}@${fetched.version}`;
    }

    const ctx = loadPack(packDir);
    if (reportIssues(ctx.issues)) process.exit(2);
    const { plan, issues } = planFor(ctx, { target: targetEnv as never });
    if (!plan) {
      reportIssues(issues, 'packhub add');
      process.exit(2);
    }

    if (args['dry-run']) {
      printPlan(plan);
      return;
    }

    const result = await installPack(ctx, plan, {
      root: projectDir,
      packRoot: packDir,
      overwrite: Boolean(args.overwrite),
    });
    for (const o of result.outcomes) {
      const mark = o.status === 'failed' ? 'x' : o.status === 'skipped' ? '-' : '✓';
      console.log(`${mark} ${o.actionId.padEnd(16)} ${o.status.padEnd(10)} ${o.message ?? o.target ?? ''}`);
    }
    if (result.outcomes.some((o) => o.status === 'failed')) process.exit(1);
    console.log(`\n装上 ${label} → ${projectDir}`);
  },
});

const update = defineCommand({
  meta: { name: 'update', description: '把已装的包升级到 registry 上的新版本' },
  args: {
    name: { type: 'positional', required: true },
    index: { type: 'string', required: true },
    dir: { type: 'string', default: '.' },
    version: { type: 'string' },
    target: { type: 'string', default: 'dir' },
    overwrite: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const res = await updatePack({
      name: String(args.name),
      index: String(args.index),
      projectDir: resolve(String(args.dir)),
      target: String(args.target),
      overwrite: Boolean(args.overwrite),
      ...(args.version ? { version: String(args.version) } : {}),
    });
    if (!res.changed) {
      console.log(`${res.name} 已是最新（planHash ${res.planHash.slice(0, 22)}…）`);
      return;
    }
    console.log(`更新 ${res.from ?? '(未装)'} → ${res.to}`);
    for (const a of res.removed) console.log(`  - ${a}`);
    for (const a of res.added) console.log(`  + ${a}`);
    console.log(`\nplanHash ${res.planHash.slice(0, 22)}…（可用 packhub rollback 退回）`);
  },
});

const rollback = defineCommand({
  meta: { name: 'rollback', description: '退回上一次安装之前的状态' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    generation: { type: 'string', description: '指定 generation（默认最近一次）' },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const res = rollbackPack(dir, args.generation ? String(args.generation) : undefined);
    console.log(`回退 ${res.generation}`);
    for (const r of res.restored) console.log(`  ↩ ${r}`);
    for (const r of res.removed) console.log(`  × ${r}`);
    console.log(`\n恢复 ${res.restored.length} 个文件，删除 ${res.removed.length} 个新建文件`);
  },
});

const licenses = defineCommand({
  meta: { name: 'licenses', description: '列出每个资源的许可证情况（只查 vendored 的本地内容）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    strict: { type: 'boolean', default: false, description: '缺许可证就以非零码退出' },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const ctx = loadPack(dir);
    if (reportIssues(ctx.issues)) process.exit(2);
    const findings = inspectLicenses(dir, ctx.manifest);
    let missing = 0;
    for (const f of findings) {
      if (!f.vendored) {
        console.log(`- ${f.resource.padEnd(20)} 远程（许可在上游仓库）`);
        continue;
      }
      if (f.file) {
        console.log(`✓ ${f.resource.padEnd(20)} ${f.spdx ?? '未知'} · ${f.file}`);
      } else {
        missing++;
        console.log(`x ${f.resource.padEnd(20)} 没有 LICENSE/COPYING`);
      }
    }
    if (missing > 0) {
      console.log(`\n${missing} 个 vendored 资源缺少许可证文件；不确定能不能再分发时先去上游确认`);
      if (args.strict) process.exit(1);
    }
  },
});

const keygen = defineCommand({
  meta: { name: 'keygen', description: '生成一对 ed25519 签名密钥' },
  args: {
    out: { type: 'string', default: 'packhub.key', description: '私钥输出路径' },
  },
  run({ args }) {
    const { privatePem, publicKey } = generateKeyPair();
    const out = resolve(String(args.out));
    writeFileSync(out, privatePem, { encoding: 'utf8', mode: 0o600 });
    console.log(`✓ 私钥：${out}（别提交进版本库）`);
    console.log(`  公钥 id：${publicKey}`);
    console.log('  把公钥 id 发给要信任你的人；签名用 packhub sign');
  },
});

const sign = defineCommand({
  meta: { name: 'sign', description: '用私钥签这个包的计划哈希' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    key: { type: 'string', required: true, description: '私钥 PEM 路径' },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const ctx = loadPack(dir);
    if (reportIssues(ctx.issues)) process.exit(2);
    const { plan, issues } = planFor(ctx, { target: 'dir' });
    if (!plan) {
      reportIssues(issues, 'packhub sign');
      process.exit(2);
    }
    const pack = `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`;
    const pem = readFileSync(String(args.key), 'utf8');
    const signature = signPlan(pem, pack, plan.planHash);
    addSignature(join(dir, 'packhub.yaml'), signature);
    console.log(`✓ 已签名 ${pack}`);
    console.log(`  公钥 id：${signature.key}`);
    console.log(`  planHash：${plan.planHash.slice(0, 22)}…`);
  },
});

const verifySig = defineCommand({
  meta: { name: 'verify-sig', description: '校验包上的签名' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    trusted: { type: 'string', description: '信任的公钥 id 列表文件（每行一个）' },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const ctx = loadPack(dir);
    if (reportIssues(ctx.issues)) process.exit(2);
    const { plan, issues } = planFor(ctx, { target: 'dir' });
    if (!plan) {
      reportIssues(issues, 'packhub verify-sig');
      process.exit(2);
    }
    const sigs = ctx.manifest.signatures ?? [];
    if (sigs.length === 0) {
      console.error('这个包没有签名');
      process.exit(1);
    }
    const pack = `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`;
    const results = verifySignatures(sigs, pack, plan.planHash);

    const trustedFile = args.trusted ? String(args.trusted) : undefined;
    const trusted = trustedFile
      ? readFileSync(trustedFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : undefined;

    let good = 0;
    for (const r of results) {
      const isTrusted = !trusted || trusted.includes(r.key);
      const ok = r.ok && isTrusted;
      if (ok) good++;
      console.log(
        `${ok ? '✓' : 'x'} ${r.key.slice(0, 16)}… ${r.ok ? '签名有效' : '签名不符'}${
          trusted && !isTrusted ? '（不在信任列表）' : ''
        }`,
      );
    }
    if (good === 0) process.exit(1);
    console.log(`\n${good}/${results.length} 个签名通过`);
  },
});

const pack = defineCommand({
  meta: { name: 'pack', description: '打成 .phub 归档（tar.gz）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    out: { type: 'string', description: '输出路径，默认 <dir>/pack.phub' },
    vendored: { type: 'boolean', default: false, description: '把本地资源一起打进去（离线可装）' },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    const res = await packArchive(dir, {
      vendored: Boolean(args.vendored),
      ...(args.out ? { out: resolve(String(args.out)) } : {}),
    });
    console.log(`✓ ${res.file}（${Math.max(1, Math.round(res.bytes / 1024))} KB）`);
    console.log(`包含：${res.entries.join('、')}${args.vendored ? '' : '（reference 模式，装的时候要联网取资源）'}`);
  },
});

const uninstall = defineCommand({
  meta: { name: 'uninstall', description: '按 state 反向删除已装的文件' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    pack: { type: 'string', description: '只卸载这个包（name@version）' },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const key = args.pack ? String(args.pack) : undefined;
    const res = removePack(dir, key);
    if (res.removed.length === 0 && res.kept.length === 0) {
      console.log('没有可卸载的记录（state 里没有这个包）');
      return;
    }
    for (const r of res.removed) console.log(`  - ${r}`);
    for (const r of res.kept) console.log(`  = 保留 ${r}（还有别的包在用）`);
    console.log(`\n移除 ${res.removed.length} 个路径，涉及 ${res.packs.length} 个包`);
  },
});

const diff = defineCommand({
  meta: { name: 'diff', description: '对比锁里的计划快照与当前计划' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    check: { type: 'boolean', default: false, description: '有差异就以非零码退出（CI 用）' },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const lockPath = join(dir, 'packhub.lock.json');
    if (!existsSync(lockPath)) {
      console.error('没有 packhub.lock.json：先跑 packhub lock');
      process.exit(2);
    }
    const ctx = loadPack(dir);
    if (reportIssues(ctx.issues)) process.exit(2);
    const { plan, issues } = planFor(ctx, { target: String(args.target ?? 'dir') as never });
    if (!plan) {
      reportIssues(issues, 'packhub diff');
      process.exit(2);
    }
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      planHash: string;
      plan?: { actions: typeof plan.actions };
    };
    if (!lock.plan) {
      console.error('锁里没有计划快照（旧版锁），重跑 packhub lock');
      process.exit(2);
    }

    const { added, removed } = diffActions(lock.plan.actions, plan.actions);
    const unchanged = added.length === 0 && removed.length === 0 && lock.planHash === plan.planHash;
    if (unchanged) {
      console.log('计划无变化');
      return;
    }

    console.log(`planHash ${lock.planHash.slice(0, 22)}… → ${plan.planHash.slice(0, 22)}…`);
    for (const a of removed) console.log(`  - ${describeAction(a)}`);
    for (const a of added) console.log(`  + ${describeAction(a)}`);
    console.log(`\n${added.length} 条新增 / ${removed.length} 条移除；确认后重跑 packhub lock`);
    if (args.check) process.exit(1);
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
  subCommands: {
    plan,
    install,
    uninstall,
    rollback,
    update,
    verify,
    lock,
    init,
    serve,
    search,
    add,
    resource,
    slot,
    diff,
    pack,
    licenses,
    keygen,
    sign,
    'verify-sig': verifySig,
  },
});
