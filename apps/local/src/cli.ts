import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { defineCommand, type CommandDef } from 'citty';
import { defaultStaticDir, startHub } from '@packhub/hub';
import {
  startMarket,
  register as marketRegister,
  login as marketLogin,
  publishToMarket,
  searchMarket,
  yankVersion,
  rateVersion,
  readSessions,
  sessionPath as marketSessionPath,
} from '@packhub/market';
import { runPack } from '@packhub/runner';
import { publishPack, writeIndex } from '@packhub/registry';
import { credentialsPath, listTokens, removeToken, setToken } from '@packhub/runtime';
import {
  loadPack,
  planFor,
  diffActions,
  describeAction,
  searchResources,
  mergeLocalOverrides,
  readLocalOverrides,
  validateGraph,
  type Issue,
  type Plan,
} from '@packhub/kernel';
import {
  addResource,
  readSignatures,
  writeSignature,
  inspectLicenses,
  doctorPack,
  probeHarness,
  probeSkill,
  loadPackResolved,
  flattenPack,
  generateKeyPair,
  signPlan,
  verifySignatures,
  setBinding,
  removePack,
  rollbackPack,
  listVersions,
  activatePack,
  packArchive,
  fetchPack,
  readIndex,
  updatePack,
  resolveAddSource,
  installPack,
  verifyPack,
  verifyInstalled,
  hasInstalledPacks,
  loadLock,
  inspectPack,
  withLockPins,
  lockPack,
  resolveRegistry,
  registryIndexes,
  syncPack,
  removeSynced,
  doctorGlobal,
  loadCatalog,
  searchNpm,
  inspectCache,
  cleanCache,
  trustPath,
  readTrust,
  addTrustedKey,
  removeTrustedKey,
  signaturePolicy,
  auditPath,
  appendAudit,
  readAudit,
  type SyncTarget,
} from '@packhub/runtime';

const errorCount = (issues: Issue[]): number => issues.filter((i) => i.severity === 'error').length;

/** 安装后自动复核只跑只读检查；command / mcp-ready 会执行包里的命令，必须显式 --deep-verify。 */
const SAFE_CHECKS = ['file-exists', 'config-key', 'knowledge-integrity'] as const;

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
    target: { type: 'string', default: 'dir', description: 'dir | dsh | claude-code | codex | server' },
  },
  async run({ args }) {
    const ctx = await loadPackResolved(String(args.dir), {
      index: resolveRegistry(args.index ? String(args.index) : undefined),
    });
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
  meta: { name: 'install', description: '执行计划（--target 决定落点：dir / claude-code / dsh）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    'dry-run': { type: 'boolean', default: false },
    'allow-exec': { type: 'boolean', default: false },
    overwrite: { type: 'boolean', default: false, description: '允许覆盖别的包写过的文件' },
    target: { type: 'string', default: 'dir', description: 'dir | dsh | claude-code | codex | server' },
    json: { type: 'boolean', default: false, description: '输出结构化结果（脚本用）' },
    index: { type: 'string', description: '远程 extends 用的 registry 索引' },
  },
  async run({ args }) {
    const ctx = await loadPackResolved(String(args.dir), {
      index: resolveRegistry(args.index ? String(args.index) : undefined),
    });
    if (reportIssues(ctx.issues)) process.exit(2);
    const target = String(args.target ?? 'dir');
    if (!ctx.manifest.metadata.targets.includes(target as never)) {
      console.error(`这个包没有声明 target ${target}；声明了：${ctx.manifest.metadata.targets.join(', ')}`);
      process.exit(2);
    }
    const { plan: p, issues } = planFor(ctx, { target: target as never });
    if (!p) {
      reportIssues(issues);
      process.exit(2);
    }
    const result = await installPack(ctx, p, {
      dryRun: Boolean(args['dry-run']),
      allowExec: Boolean(args['allow-exec']),
      overwrite: Boolean(args.overwrite),
    });
    if (!args.json) {
      for (const o of result.outcomes) {
        const mark = o.status === 'failed' ? 'x' : o.status === 'skipped' ? '-' : '✓';
        console.log(`${mark} ${o.actionId.padEnd(16)} ${o.status.padEnd(14)} ${o.message ?? o.target ?? ''}`);
      }
    }
    if (result.outcomes.some((o) => o.status === 'failed')) {
      if (args.json) {
        console.log(
          JSON.stringify(
            { planHash: p.planHash, outcomes: result.outcomes, rolledBack: result.rolledBack ?? false },
            null,
            2,
          ),
        );
      } else if (result.rolledBack) {
        console.error('\n有动作失败，已按快照回滚：磁盘回到安装前，state 未写入。');
      }
      process.exit(1);
    }
    if (!args['dry-run']) {
      if (args.json) {
        console.log(
          JSON.stringify({ planHash: p.planHash, outcomes: result.outcomes, statePath: result.statePath }, null, 2),
        );
      } else {
        console.log(`\nstate: ${result.statePath}`);
      }
      try {
        appendAudit({
          action: 'install',
          pack: p.pack.name,
          version: p.pack.version,
          planHash: p.planHash,
          ok: true,
          root: resolve(String(args.dir)),
        });
      } catch (err) {
        console.warn(`warn  审计写入失败：${(err as Error).message}`);
      }
    }
  },
});

const verify = defineCommand({
  meta: { name: 'verify', description: '跑 manifest 的检查；在项目根跑时用 state 里的计划快照' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    target: { type: 'string', default: 'dir', description: 'dir | dsh | claude-code | codex | server' },
    pack: { type: 'string', description: '只验某个已装的包（name@version）' },
    json: { type: 'boolean', default: false, description: '输出结构化结果（脚本用）' },
    index: { type: 'string', description: '远程 extends 用的 registry 索引' },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    // 项目模式：add 装进来的包没有 packhub.yaml，计划和安装根都在 state 里
    if (!existsSync(join(dir, 'packhub.yaml')) && hasInstalledPacks(dir)) {
      const reports = await verifyInstalled(dir, {
        ...(args.pack ? { pack: String(args.pack) } : {}),
      });
      let failed = 0;
      let skipped = 0;
      if (!args.json) {
        for (const report of reports) {
          console.log(`\n${report.pack}`);
          console.log(`  planHash ${report.planHash}`);
          for (const r of report.results) {
            const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? 'x' : '-';
            console.log(`  ${mark} [${r.index}] ${r.type.padEnd(18)} ${r.status.padEnd(8)} ${r.detail}`);
          }
          failed += report.results.filter((r) => r.status === 'fail').length;
          skipped += report.results.filter((r) => r.status === 'skipped').length;
          if (!report.ok) failed++;
        }
        console.log(`\n${reports.length} 个包：${failed} 项失败 / ${skipped} 项跳过`);
      } else {
        for (const report of reports) {
          failed += report.results.filter((r) => r.status === 'fail').length;
          skipped += report.results.filter((r) => r.status === 'skipped').length;
          if (!report.ok) failed++;
        }
        console.log(
          JSON.stringify(
            { installed: reports, results: reports.flatMap((r) => r.results), failed, skipped },
            null,
            2,
          ),
        );
      }
      if (failed) process.exit(1);
      return;
    }

    const ctx = await loadPackResolved(dir, {
      index: resolveRegistry(args.index ? String(args.index) : undefined),
    });
    if (reportIssues(ctx.issues)) process.exit(2);
    const { plan: p, issues } = planFor(ctx, { target: String(args.target ?? 'dir') as never });
    if (!p) {
      reportIssues(issues);
      process.exit(2);
    }
    const results = await verifyPack(ctx.dir, p);
    const failed = results.filter((r) => r.status === 'fail').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    if (args.json) {
      console.log(JSON.stringify({ planHash: p.planHash, results, failed, skipped }, null, 2));
    } else {
      for (const r of results) {
        const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? 'x' : '-';
        console.log(`${mark} [${r.index}] ${r.type.padEnd(18)} ${r.status.padEnd(8)} ${r.detail}`);
      }
      console.log(`\n${results.length} 项：${results.length - failed - skipped} 通过 / ${failed} 失败 / ${skipped} 跳过`);
    }
    if (failed) process.exit(1);
  },
});

const lock = defineCommand({
  meta: { name: 'lock', description: '解析引用（npm/github/https/pypi）并生成 packhub.lock.json' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    target: { type: 'string', default: 'dir', description: 'dir | dsh | claude-code | codex | server' },
    offline: { type: 'boolean', default: false, description: '不联网：只锁本地与已 pin 的引用' },
    index: { type: 'string', description: '远程 extends 用的 registry 索引' },
    json: { type: 'boolean', default: false, description: '输出锁与 planHash（脚本用）' },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    const raw = loadPack(dir);
    if (raw.manifest?.extends?.startsWith('packhub://')) {
      console.error('远程 extends 的包不能直接 lock：先 vendored 父包（或改成本地继承）');
      process.exit(2);
    }
    if (raw.manifest?.resources.some((r) => r.source.startsWith('packhub://'))) {
      console.error('资源级 packhub:// 的包不能直接 lock：先把被引用的文件 vendored 进包内（改成 ./ 来源）');
      process.exit(2);
    }
    const ctx = await loadPackResolved(dir, {
      index: resolveRegistry(args.index ? String(args.index) : undefined),
    });
    if (reportIssues(ctx.issues)) process.exit(2);
    try {
      const res = await lockPack(ctx, {
        target: String(args.target ?? 'dir') as never,
        offline: Boolean(args.offline),
      });
      const out = join(ctx.dir, 'packhub.lock.json');
      writeFileSync(out, JSON.stringify(res.lock, null, 2) + '\n', 'utf8');
      if (args.json) {
        console.log(
          JSON.stringify(
            { out, lock: res.lock, planHash: res.plan.planHash, warnings: res.warnings },
            null,
            2,
          ),
        );
      } else {
        for (const w of res.warnings) console.warn(`warn  ${w}`);
        const withHash = res.lock.resolved.filter((r) => r.integrity).length;
        console.log(`written ${out}`);
        console.log(`planHash ${res.plan.planHash}`);
        console.log(`${res.lock.resolved.length} 个引用，${withHash} 个带 integrity`);
      }
    } catch (err) {
      console.error(`x ${(err as Error).message}`);
      process.exit(2);
    }
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
    target: { type: 'string', default: 'dir', description: 'dir | dsh | claude-code | codex | server' },
  },
  async run({ args }) {
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
    target: { type: 'string', default: 'dir' },
  },
  async run({ args }) {
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
    index: { type: 'string', description: 'registry 的 index.json（本地路径或 URL；也可用 PACKHUB_INDEX）' },
    version: { type: 'string', description: 'registry 包的版本，默认 latest' },
    dir: { type: 'string', default: '.', description: '项目目录' },
    target: { type: 'string', default: 'dir', description: 'dir | dsh | claude-code | codex | server' },
    'dry-run': { type: 'boolean', default: false },
    overwrite: { type: 'boolean', default: false },
    'allow-stale-lock': {
      type: 'boolean',
      default: false,
      description: '锁与清单对不上也继续装（默认拒绝）',
    },
    'require-signature': {
      type: 'boolean',
      default: false,
      description: '没有有效签名就拒绝安装',
    },
    'allow-unsigned': {
      type: 'boolean',
      default: false,
      description: '即使配置了信任列表也接受无签名包（显式降低要求）',
    },
    'no-verify': { type: 'boolean', default: false, description: '装完不跑 verify 检查' },
    'deep-verify': { type: 'boolean', default: false, description: '安装后也跑 command / mcp-ready（会执行包里的命令）' },
    trusted: { type: 'string', description: '信任的公钥 id 列表文件（每行一个）' },
    json: { type: 'boolean', default: false, description: '输出结构化结果（脚本用）' },
  },
  async run({ args }) {
    const projectDir = resolve(String(args.dir));
    const say = args.json ? (_line: string): void => {} : (line: string): void => console.log(line);
    const target = String(args.source);
    const targetEnv = String(args.target);
    // packhub://scope/name@version 是 registry 引用的规范写法，与 scope/name + --version 等价
    let registryName = target;
    let registryVersion = args.version ? String(args.version) : undefined;
    if (target.startsWith('packhub://')) {
      const body = target.slice('packhub://'.length);
      const at = body.lastIndexOf('@');
      if (at <= 0) {
        console.error('packhub:// 引用要带版本：packhub://scope/name@1.2.3');
        process.exit(2);
      }
      registryName = body.slice(0, at);
      registryVersion = body.slice(at + 1);
    }
    // dry-run 不往项目里落任何东西：取包与解包都在临时目录完成
    const workBase = args['dry-run'] ? mkdtempSync(join(tmpdir(), 'packhub-add-')) : projectDir;

    let packDir: string;
    let label: string;

    if (target.endsWith('.phub') || target.startsWith('git+')) {
      const slug = target
        .replace(/^git\+/, '')
        .replace(/\.phub$/, '')
        .replace(/[@/\\:]/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(-48);
      packDir = join(workBase, '.packhub/packs', slug);
      say(`→ 取 ${target} …`);
      const resolved = await resolveAddSource(target, packDir);
      packDir = resolved.dir;
      label = resolved.label;
    } else {
      const indexRef = resolveRegistry(args.index ? String(args.index) : undefined);
      if (!indexRef) {
        console.error(
          '用 registry 名称安装需要一个索引：加 --index <路径|URL>，或设 PACKHUB_INDEX，或在 ~/.packhub/config.json 里配 defaultRegistry',
        );
        process.exit(2);
      }
      packDir = join(workBase, '.packhub/packs', registryName);
      say(`→ 取 ${registryName}${registryVersion ? `@${registryVersion}` : ''} …`);
      const fetched = await fetchPack({
        name: registryName,
        index: indexRef,
        ...(registryVersion ? { version: registryVersion, allowUnlisted: true } : {}),
        dest: packDir,
      });
      label = `${registryName}@${fetched.version}`;
    }

    const rawCtx = await loadPackResolved(packDir, {
      index: resolveRegistry(args.index ? String(args.index) : undefined),
    });
    if (!rawCtx.manifest) {
      reportIssues(rawCtx.issues);
      process.exit(2);
    }
    const lock = loadLock(packDir);
    // 清单里写的是 tag/范围也没关系：按锁把它换成本次要装的 commit/版本
    let ctx = withLockPins(rawCtx, lock);
    if (reportIssues(ctx.issues)) process.exit(2);
    if (!ctx.manifest.metadata.targets.includes(targetEnv as never)) {
      console.error(`这个包没有声明 target ${targetEnv}；声明了：${ctx.manifest.metadata.targets.join(', ')}`);
      process.exit(2);
    }
    if (lock?.plan && String(lock.plan.target) !== targetEnv) {
      console.warn(
        `warn  锁的计划快照是 ${lock.plan.target}，本次安装 target 是 ${targetEnv}；目标计划没有被 planHash 校验`,
      );
    }

    // 消费端核对：锁 / 验证报告 / 签名。锁按它自己的 target 重算，避免安装 target 不同被误判。
    const lockTarget = String(lock?.plan?.target ?? 'dir');
    const { plan: lockPlan } = planFor(ctx, { target: lockTarget as never });
    // 信任来源：显式 --trusted 文件 + 本机持久信任列表；有列表就只认列表内的公钥
    const fileKeys = args.trusted
      ? readFileSync(String(args.trusted), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : [];
    const policy = signaturePolicy({
      require: Boolean(args['require-signature']),
      allowUnsigned: Boolean(args['allow-unsigned']),
    });
    const trustedKeys = [...new Set([...(policy.trusted ?? []), ...fileKeys])];
    const trusted = trustedKeys.length > 0 ? trustedKeys : undefined;
    const inspection = inspectPack(packDir, ctx.manifest, lockPlan, { ...(trusted ? { trusted } : {}) });
    for (const issue of inspection.issues) {
      const line = `[${issue.code}] ${issue.message}`;
      if (issue.severity === 'error') console.error(`error ${line}`);
      else console.warn(`warn  ${line}`);
    }
    const lockErrors = inspection.issues.filter((i) => i.severity === 'error');
    if (lockErrors.length > 0 && !args['allow-stale-lock']) {
      console.error('\n锁核对未通过，已停止安装（确认来源后加 --allow-stale-lock）。');
      process.exit(2);
    }
    const goodSignatures = inspection.signatures.filter((s) => s.ok).length;
    const trustedSignatures = trusted
      ? inspection.signatures.filter((s) => s.ok && trusted.includes(s.key)).length
      : goodSignatures;
    if (policy.require && trustedSignatures === 0) {
      console.error(
        `这个包没有${policy.trusted ? '被信任列表认可' : '有效'}的签名（默认策略/signature 要求）。` +
          `\n  先确认发布者，再用 packhub trust add <公钥 id> 加入信任列表；确实不用签名时加 --allow-unsigned。`,
      );
      process.exit(2);
    }
    if (inspection.signatures.length > 0) {
      say(`签名 ${goodSignatures}/${inspection.signatures.length} 有效${trusted ? `，信任列表内 ${trustedSignatures} 个` : ''}`);
    } else if (!policy.require) {
      say('这个包没有签名（未配置信任列表，按开发者模式继续）');
    }

    // 项目根的 .packhub/local.yaml 只改这次安装：覆盖 pin、绑定、路径与环境变量
    const local = readLocalOverrides(projectDir);
    if (local.overrides) {
      const merged = mergeLocalOverrides(ctx.manifest, local.overrides);
      const validated = validateGraph(merged.manifest);
      const localIssues = [...local.issues, ...merged.issues, ...validated.issues];
      if (localIssues.some((i) => i.severity === 'error')) {
        reportIssues(localIssues, 'packhub add（local.yaml）');
        process.exit(2);
      }
      ctx = {
        ...ctx,
        manifest: merged.manifest,
        graph: validated.graph,
        issues: [...ctx.issues, ...localIssues],
      };
      say('已应用 .packhub/local.yaml 覆盖');
    }

    const { plan, issues } = planFor(ctx, { target: targetEnv as never });
    if (!plan) {
      reportIssues(issues, 'packhub add');
      process.exit(2);
    }

    if (args['dry-run']) {
      if (args.json) console.log(JSON.stringify({ label, dryRun: true, plan }, null, 2));
      else printPlan(plan);
      rmSync(workBase, { recursive: true, force: true });
      return;
    }

    const result = await installPack(ctx, plan, {
      root: projectDir,
      packRoot: packDir,
      overwrite: Boolean(args.overwrite),
    });
    for (const o of result.outcomes) {
      const mark = o.status === 'failed' ? 'x' : o.status === 'skipped' ? '-' : '✓';
      say(`${mark} ${o.actionId.padEnd(16)} ${o.status.padEnd(10)} ${o.message ?? o.target ?? ''}`);
    }
    if (result.outcomes.some((o) => o.status === 'failed')) {
      if (args.json) {
        console.log(
          JSON.stringify(
            { label, planHash: plan.planHash, outcomes: result.outcomes, rolledBack: result.rolledBack ?? false },
            null,
            2,
          ),
        );
      } else if (result.rolledBack) {
        console.error('\n有动作失败，已按快照回滚：磁盘回到安装前，state 未写入。');
      }
      process.exit(1);
    }
    say(`\n装上 ${label} → ${projectDir}`);
    try {
      appendAudit({
        action: 'add',
        pack: ctx.manifest.metadata.name,
        version: ctx.manifest.metadata.version,
        planHash: plan.planHash,
        ok: true,
        root: projectDir,
      });
    } catch (err) {
      console.warn(`warn  审计写入失败：${(err as Error).message}`);
    }

    // 装完立刻复核：否则「装上了」和「能用」之间又断了一层
    let reports: Awaited<ReturnType<typeof verifyInstalled>> | undefined;
    if (!args['no-verify']) {
      const key = `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`;
      reports = await verifyInstalled(projectDir, {
        pack: key,
        ...(args['deep-verify'] ? {} : { types: [...SAFE_CHECKS] }),
      });
      for (const r of reports) {
        say(`\n校验 ${r.pack}：${r.ok ? '通过' : '未通过'}`);
        for (const c of r.results) {
          const mark = c.status === 'pass' ? '✓' : c.status === 'fail' ? 'x' : '-';
          say(`  ${mark} [${c.index}] ${c.type.padEnd(18)} ${c.status.padEnd(8)} ${c.detail}`);
        }
      }
      if (!reports.every((r) => r.ok)) {
        if (args.json) {
          console.log(
            JSON.stringify(
              { label, planHash: plan.planHash, outcomes: result.outcomes, installed: false, verification: reports },
              null,
              2,
            ),
          );
        } else {
          console.error('装上了，但有校验没过；先修清单里的 verify 或确认环境。');
        }
        process.exit(1);
      }
    }
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            label,
            pack: `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`,
            planHash: plan.planHash,
            outcomes: result.outcomes,
            installed: true,
            ...(reports ? { verification: reports } : {}),
          },
          null,
          2,
        ),
      );
    }
  },
});

const update = defineCommand({
  meta: { name: 'update', description: '把已装的包升级到 registry 上的新版本' },
  args: {
    name: { type: 'positional', required: true },
    index: { type: 'string', description: '索引路径、URL 或本机配置里的 registry 名（默认取默认 registry）' },
    dir: { type: 'string', default: '.' },
    version: { type: 'string' },
    target: { type: 'string', description: '默认沿用上次安装的 target' },
    overwrite: { type: 'boolean', default: false },
    'allow-stale-lock': { type: 'boolean', default: false },
    'no-verify': { type: 'boolean', default: false, description: '更新后不跑 verify 检查' },
    'deep-verify': { type: 'boolean', default: false, description: '更新后也跑 command / mcp-ready（会执行包里的命令）' },
  },
  async run({ args }) {
    const indexRef = resolveRegistry(args.index ? String(args.index) : undefined);
    if (!indexRef) {
      console.error('没有索引：加 --index <路径|URL|registry 名>，或设 PACKHUB_INDEX');
      process.exit(2);
    }
    const res = await updatePack({
      name: String(args.name),
      index: indexRef,
      projectDir: resolve(String(args.dir)),
      target: String(args.target),
      overwrite: Boolean(args.overwrite),
      allowStaleLock: Boolean(args['allow-stale-lock']),
      ...(args.version ? { version: String(args.version) } : {}),
    });
    if (!res.changed) {
      console.log(`${res.name} 已是最新（planHash ${res.planHash.slice(0, 22)}…）`);
      return;
    }
    console.log(`更新 ${res.from ?? '(未装)'} → ${res.to}`);
    for (const a of res.removed) console.log(`  - ${a}（计划里移除）`);
    for (const a of res.added) console.log(`  + ${a}`);
    for (const p of res.pruned) console.log(`  × ${p}（已从磁盘清掉）`);
    for (const w of res.warnings) console.warn(`warn  ${w}`);
    console.log(`\nplanHash ${res.planHash.slice(0, 22)}…（可用 packhub rollback 退回）`);
    try {
      appendAudit({
        action: 'update',
        pack: res.name,
        version: res.to.split('@').pop(),
        planHash: res.planHash,
        ok: true,
        root: resolve(String(args.dir)),
      });
    } catch (err) {
      console.warn(`warn  审计写入失败：${(err as Error).message}`);
    }

    if (res.changed && !args['no-verify']) {
      const reports = await verifyInstalled(resolve(String(args.dir)), {
        pack: res.to,
        ...(args['deep-verify'] ? {} : { types: [...SAFE_CHECKS] }),
      });
      for (const r of reports) {
        console.log(`\n校验 ${r.pack}：${r.ok ? '通过' : '未通过'}`);
        for (const c of r.results) {
          const mark = c.status === 'pass' ? '✓' : c.status === 'fail' ? 'x' : '-';
          console.log(`  ${mark} [${c.index}] ${c.type.padEnd(18)} ${c.status.padEnd(8)} ${c.detail}`);
        }
      }
      if (!reports.every((r) => r.ok)) {
        console.error('更新完成，但有校验没过；可用 rollback 退回上一版。');
        process.exit(1);
      }
    }
  },
});

const rollback = defineCommand({
  meta: { name: 'rollback', description: '退回上一次安装之前的状态' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    generation: { type: 'string', description: '指定 generation（默认最近一次）' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const res = rollbackPack(dir, args.generation ? String(args.generation) : undefined);
    if (args.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(`回退 ${res.generation}`);
    for (const r of res.restored) console.log(`  ↩ ${r}`);
    for (const r of res.removed) console.log(`  × ${r}`);
    console.log(`\n恢复 ${res.restored.length} 个文件，删除 ${res.removed.length} 个新建文件`);
  },
});

const versions = defineCommand({
  meta: { name: 'versions', description: '列出已装版本目录与当前激活版本' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    pack: { type: 'positional', required: false, description: '只看这个包（name）' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const list = listVersions(resolve(String(args.dir)), args.pack ? String(args.pack) : undefined);
    if (args.json) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    if (list.length === 0) {
      console.log('没有已暂存的版本');
      return;
    }
    for (const v of list) {
      const mark = v.active ? '●' : '○';
      console.log(`${mark} ${`${v.pack}@${v.version}`.padEnd(40)} ${v.target.padEnd(12)} ${v.installedAt.slice(0, 19)}`);
    }
    console.log('\n● 表示当前激活；用 packhub activate <name>@<version> 切换');
  },
});

const activate = defineCommand({
  meta: { name: 'activate', description: '把同一个包已暂存的某个版本挂到项目上' },
  args: {
    ref: { type: 'positional', required: true, description: 'name@version' },
    dir: { type: 'positional', required: false, default: '.' },
  },
  async run({ args }) {
    const ref = String(args.ref);
    const at = ref.lastIndexOf('@');
    if (at <= 0 || at === ref.length - 1) {
      console.error('用法：packhub activate <name>@<version>');
      process.exit(2);
    }
    const pack = ref.slice(0, at);
    const version = ref.slice(at + 1);
    try {
      const res = await activatePack(resolve(String(args.dir)), pack, version);
      console.log(`激活 ${res.to}${res.from ? `（原 ${res.from}）` : ''}`);
      for (const r of res.removed) console.log(`  × ${r}`);
      console.log(`\n铺开 ${res.written.length} 个路径；配置与指令块已按这个版本重放`);
    } catch (err) {
      console.error(`x ${(err as Error).message}`);
      process.exit(1);
    }
  },
});

const run = defineCommand({
  meta: { name: 'run', description: '在干净目录里装一遍并校验（发布门禁的同一个执行者）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    out: { type: 'string', description: '报告写到哪，默认 <dir>/verify.json' },
    json: { type: 'boolean', default: false },
    'allow-exec': { type: 'boolean', default: false, description: '允许执行清单里的 install.exec' },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    try {
      const { report } = await runPack(dir, {
        out: args.out ? resolve(String(args.out)) : join(dir, 'verify.json'),
        allowExec: Boolean(args['allow-exec']),
        log: (line) => console.log(line),
      });
      if (args.json) console.log(JSON.stringify(report, null, 2));
      process.exit(report.ok ? 0 : 1);
    } catch (err) {
      console.error(`x ${(err as Error).message}`);
      process.exit(1);
    }
  },
});

const publish = defineCommand({
  meta: { name: 'publish', description: '发布一个包：先干净安装+校验，再写进 registry' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    registry: { type: 'string', default: 'registry', description: 'registry 根目录' },
    out: { type: 'string', description: '写到别的目录（PR 模式）' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false, description: '允许覆盖已存在的版本目录' },
    offline: { type: 'boolean', default: false, description: '不联网解析引用' },
    'allow-exec': { type: 'boolean', default: false, description: '允许 runner 执行清单里的 install.exec' },
    index: { type: 'string', description: '扁平化远程 extends / packhub:// 用的 registry 索引' },
  },
  async run({ args }) {
    const registry = resolve(String(args.registry));
    let flat: Awaited<ReturnType<typeof flattenPack>> | undefined;
    try {
      // 远程引用先展开成自包含目录，发布的版本目录与归档都不再依赖父包
      flat = await flattenPack(resolve(String(args.dir)), {
        index: resolveRegistry(args.index ? String(args.index) : undefined),
      });
      for (const w of flat.warnings) console.warn(`warn  ${w}`);
      const res = await publishPack(flat.dir, {
        registry,
        ...(args.out ? { out: resolve(String(args.out)) } : {}),
        dryRun: Boolean(args['dry-run']),
        force: Boolean(args.force),
        offline: Boolean(args.offline),
        allowExec: Boolean(args['allow-exec']),
        log: (line) => console.log(line),
      });
      if (args['dry-run']) {
        console.log(`\n[dry-run] 将发布 ${res.name}@${res.version}，未写盘`);
        return;
      }
      if (!args.out) {
        const idx = writeIndex(registry);
        console.log(idx.ok ? `\n索引已更新：${idx.packs} 个包` : '\n索引有错误，未写入（看上面）');
        if (!idx.ok) process.exit(1);
      } else {
        console.log(`\n已写到 ${res.dir}；把${args.out} 下改动提交成 PR 即可`);
      }
      console.log(`发布完成：${res.name}@${res.version}`);
    } catch (err) {
      console.error(`x ${(err as Error).message}`);
      process.exit(1);
    }
  },
});

const sync = defineCommand({
  meta: { name: 'sync', description: '把 skill-only Pack 同步到 harness 的全局 skills/（dsh / codex）' },
  args: {
    dir: { type: 'positional', required: true, description: 'Pack 目录' },
    to: { type: 'string', required: true, description: '目标，逗号分隔：dsh,codex,claude-code' },
    'dry-run': { type: 'boolean', default: false },
    remove: { type: 'boolean', default: false, description: '从目标 harness 移除这个包' },
    overwrite: { type: 'boolean', default: false, description: '允许覆盖别的包占用的 skill 目录' },
  },
  async run({ args }) {
    const targets = String(args.to)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (targets.length === 0 || targets.some((t) => t !== 'dsh' && t !== 'codex' && t !== 'claude-code')) {
      console.error(`--to 只接受 dsh / codex：${targets.join(',')}`);
      process.exit(2);
    }
    try {
      if (args.remove) {
        for (const res of removeSynced(String(args.dir), targets as SyncTarget[])) {
          console.log(`${res.target} ${res.root}：移除 ${res.packs.length} 个包，${res.removed.length} 个路径`);
          for (const p of res.removed) console.log(`  - ${p}`);
        }
        return;
      }
      const { pack, results } = await syncPack(String(args.dir), {
        targets: targets as SyncTarget[],
        dryRun: Boolean(args['dry-run']),
        overwrite: Boolean(args.overwrite),
      });
      console.log(`${pack}（${args['dry-run'] ? 'dry-run' : '同步'}）`);
      for (const res of results) {
        console.log(`  ${res.target} → ${res.root}`);
        if (res.planHash) console.log(`    planHash ${res.planHash.slice(0, 22)}…`);
        for (const o of res.outcomes ?? []) {
          const mark = o.status === 'done' || o.status === 'noop' ? '✓' : 'x';
          console.log(`    ${mark} ${o.actionId.padEnd(16)} ${o.status.padEnd(8)} ${o.target ?? ''}`);
        }
      }
    } catch (err) {
      console.error(`x ${(err as Error).message}`);
      process.exit(1);
    }
  },
});

const marketServe = defineCommand({
  meta: { name: 'serve', description: '起市场写端（账号、上传、下架、统计；包内容仍按版本不可变）' },
  args: {
    dir: { type: 'positional', required: false, default: '.', description: 'registry 根目录' },
    port: { type: 'string', default: '8789' },
    host: { type: 'string', default: '127.0.0.1' },
    'require-review': { type: 'boolean', default: false, description: '上传先进 staging，管理员批准后才进索引' },
    'admin-token': { type: 'string', description: '管理 token（也可用 PACKHUB_MARKET_ADMIN）' },
  },
  async run({ args }) {
    const market = await startMarket({
      root: resolve(String(args.dir)),
      port: Number(args.port),
      host: String(args.host),
      requireReview: Boolean(args['require-review']),
      ...(args['admin-token'] ? { adminToken: String(args['admin-token']) } : {}),
    });
    console.log(`PackHub 市场（写端）→ ${market.url}`);
    console.log('上传走 POST /api/publish；包仍由 Hub 只读分发');
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        console.log(`${signal} → 关闭`);
        void market.close().then(() => process.exit(0));
      });
    }
    await new Promise(() => {});
  },
});

const marketRegisterCmd = defineCommand({
  meta: { name: 'register', description: '在市场注册账号，拿到只能发布自己 scope 的 token' },
  args: {
    url: { type: 'positional', required: true, description: '市场地址，例如 http://127.0.0.1:8789' },
    name: { type: 'positional', required: true, description: '账号名（同时成为 scope）' },
  },
  async run({ args }) {
    try {
      const session = await marketRegister(String(args.url), String(args.name));
      console.log(`✓ 已注册 ${session.name}（scope ${session.scope}）`);
      console.log(`  token 已保存到 ${marketSessionPath()}（0600）`);
      console.log(`  发布：packhub market publish <pack 目录> --url ${session.url}`);
    } catch (err) {
      console.error(`x ${(err as Error).message}`);
      process.exit(1);
    }
  },
});

const marketLoginCmd = defineCommand({
  meta: { name: 'login', description: '用已有 token 登录市场（token 存本机，不进清单）' },
  args: {
    url: { type: 'positional', required: true },
    token: { type: 'positional', required: true },
  },
  async run({ args }) {
    try {
      const session = await marketLogin(String(args.url), String(args.token));
      console.log(`✓ 已登录 ${session.url}（${session.name} / ${session.scope}）`);
    } catch (err) {
      console.error(`x ${(err as Error).message}`);
      process.exit(1);
    }
  },
});

const marketPublishCmd = defineCommand({
  meta: { name: 'publish', description: '把 Pack 打成 .phub 上传到市场（服务端跑干净安装+只读校验）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    url: { type: 'string', description: '市场地址（默认用已保存的登录）' },
    token: { type: 'string', description: '临时 token（默认用已保存的登录）' },
  },
  async run({ args }) {
    try {
      const res = await publishToMarket(resolve(String(args.dir)), {
        ...(args.url ? { url: String(args.url) } : {}),
        ...(args.token ? { token: String(args.token) } : {}),
      });
      console.log(`✓ 已发布 ${res.name}@${res.version}（${res.trust ?? 'community'}）`);
      if (res.planHash) console.log(`  planHash ${res.planHash.slice(0, 22)}…`);
    } catch (err) {
      console.error(`x ${(err as Error).message}`);
      process.exit(1);
    }
  },
});

const marketSearchCmd = defineCommand({
  meta: { name: 'search', description: '在市场里按关键词找包（带下载量）' },
  args: {
    keyword: { type: 'positional', required: false },
    url: { type: 'string', description: '市场地址（默认用已保存的登录）' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    try {
      const sessions = Object.keys(readSessions().sessions);
      const url = args.url ? String(args.url) : sessions.length === 1 ? sessions[0]! : undefined;
      if (!url) {
        console.error('要指定 --url，或先 packhub market login 保存一个地址');
        process.exit(2);
      }
      const packs = await searchMarket(url, String(args.keyword ?? ''));
      if (args.json) {
        console.log(JSON.stringify(packs, null, 2));
        return;
      }
      for (const p of packs) {
        console.log(`${p.name}@${p.latest}  ${p.trust ?? 'community'}  ${p.downloads ?? 0} 次下载`);
        if (p.title) console.log(`  ${p.title}`);
      }
      if (packs.length === 0) console.log('没有匹配的包');
    } catch (err) {
      console.error(`x ${(err as Error).message}`);
      process.exit(1);
    }
  },
});

const marketRateCmd = defineCommand({
  meta: { name: 'rate', description: '给市场里的一个版本评分（1..5，一个账号一票）' },
  args: {
    ref: { type: 'positional', required: true, description: 'name@version' },
    score: { type: 'positional', required: true, description: '1..5 的整数' },
    comment: { type: 'string' },
    url: { type: 'string' },
    token: { type: 'string' },
  },
  async run({ args }) {
    try {
      const res = await rateVersion(String(args.ref), Number(args.score), {
        ...(args.url ? { url: String(args.url) } : {}),
        ...(args.token ? { token: String(args.token) } : {}),
        ...(args.comment ? { comment: String(args.comment) } : {}),
      });
      const avg = res.rating.average === null ? '—' : res.rating.average.toFixed(1);
      console.log(`✓ ${res.name}@${res.version} 已评分：${args.score}/5（均分 ${avg}，${res.rating.count} 人）`);
    } catch (err) {
      console.error(`x ${(err as Error).message}`);
      process.exit(1);
    }
  },
});

const marketYankCmd = defineCommand({
  meta: { name: 'yank', description: '下架自己发布的一个版本（移到 quarantine，索引同步移除）' },
  args: {
    ref: { type: 'positional', required: true, description: 'name@version' },
    url: { type: 'string' },
    token: { type: 'string' },
    reason: { type: 'string' },
  },
  async run({ args }) {
    try {
      const res = await yankVersion(String(args.ref), {
        ...(args.url ? { url: String(args.url) } : {}),
        ...(args.token ? { token: String(args.token) } : {}),
        ...(args.reason ? { reason: String(args.reason) } : {}),
      });
      console.log(`✓ 已下架 ${res.name}@${res.version}`);
    } catch (err) {
      console.error(`x ${(err as Error).message}`);
      process.exit(1);
    }
  },
});

const marketWhoami = defineCommand({
  meta: { name: 'whoami', description: '看本机保存了哪些市场登录' },
  run() {
    const sessions = Object.values(readSessions().sessions);
    if (sessions.length === 0) {
      console.log(`没有登录记录：${marketSessionPath()}`);
      return;
    }
    for (const s of sessions) console.log(`${s.url}  ${s.name} (${s.scope})`);
  },
});

const market = defineCommand({
  meta: { name: 'market', description: '市场写端：账号、发布、下架、统计（Hub 仍然只读）' },
  subCommands: {
    serve: marketServe,
    register: marketRegisterCmd,
    login: marketLoginCmd,
    publish: marketPublishCmd,
    search: marketSearchCmd,
    rate: marketRateCmd,
    yank: marketYankCmd,
    whoami: marketWhoami,
  },
});

const trustAdd = defineCommand({
  meta: { name: 'add', description: '把发布者的公钥 id 加入本机信任列表' },
  args: {
    key: { type: 'positional', required: true, description: '公钥 id（packhub sign 输出里的 key）' },
    label: { type: 'string', description: '给人看的备注，例如发布者名字' },
  },
  run({ args }) {
    const entry = addTrustedKey(String(args.key), args.label ? String(args.label) : undefined);
    console.log(`✓ 已信任 ${entry.key.slice(0, 16)}…${entry.label ? `（${entry.label}）` : ''}`);
    console.log(`  ${trustPath()}`);
    console.log('  之后安装默认要求来自这个列表的有效签名；要装无签名包用 --allow-unsigned');
  },
});

const trustRemove = defineCommand({
  meta: { name: 'remove', description: '从信任列表移除一个公钥' },
  args: { key: { type: 'positional', required: true } },
  run({ args }) {
    const ok = removeTrustedKey(String(args.key));
    console.log(ok ? `✓ 已移除 ${String(args.key).slice(0, 16)}…` : '信任列表里没有这个公钥');
    if (!ok) process.exit(1);
  },
});

const trustList = defineCommand({
  meta: { name: 'list', description: '列出本机信任的公钥' },
  run() {
    const trust = readTrust();
    if (trust.keys.length === 0) {
      console.log(`信任列表是空的：${trustPath()}`);
      console.log('用 packhub trust add <公钥 id> 添加发布者');
      return;
    }
    for (const key of trust.keys) {
      console.log(`${key.key}${key.label ? `  ${key.label}` : ''}  ${key.addedAt.slice(0, 19)}`);
    }
    console.log(`\n共 ${trust.keys.length} 个；requireSignature=${trust.requireSignature === true}`);
  },
});

const trust = defineCommand({
  meta: { name: 'trust', description: '管理持久信任的签名公钥' },
  subCommands: { add: trustAdd, remove: trustRemove, list: trustList },
});

const audit = defineCommand({
  meta: { name: 'audit', description: '看本机的安装审计（add / install / update）' },
  args: {
    tail: { type: 'string', default: '20', description: '只看最近 N 条' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const entries = readAudit(Number(args.tail) || 20);
    if (args.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    if (entries.length === 0) {
      console.log(`还没有审计记录：${auditPath()}`);
      return;
    }
    for (const e of entries) {
      console.log(
        `${e.at.slice(0, 19)}  ${e.action.padEnd(8)} ${`${e.pack ?? ''}@${e.version ?? ''}`.padEnd(34)} ${e.ok === false ? 'x' : '✓'}  ${e.planHash?.slice(0, 14) ?? ''}`,
      );
    }
    console.log(`\n${auditPath()}`);
  },
});

const authSet = defineCommand({
  meta: { name: 'set', description: '把一把 token 存进凭据库（0600，不进清单、不进 registry）' },
  args: {
    name: { type: 'positional', required: true, description: '变量名，例如 GITHUB_TOKEN' },
    value: { type: 'positional', required: true, description: 'token 值' },
  },
  run({ args }) {
    setToken(String(args.name), String(args.value));
    console.log(`✓ 已存入 ${credentialsPath()}（${String(args.name)}）`);
    console.log('  下载时环境变量优先，其次才是这里。');
  },
});

const authList = defineCommand({
  meta: { name: 'list', description: '列出已存的 token（只显示掩码）' },
  run() {
    const tokens = listTokens();
    if (tokens.length === 0) {
      console.log(`凭据库是空的：${credentialsPath()}`);
      console.log('用 packhub auth set <变量名> <token> 添加');
      return;
    }
    for (const t of tokens) {
      console.log(`${t.name.padEnd(24)} ${t.masked}${t.fromEnv ? '  ← 环境变量也在起作用（优先）' : ''}`);
    }
  },
});

const authRemove = defineCommand({
  meta: { name: 'remove', description: '删掉一把 token' },
  args: { name: { type: 'positional', required: true } },
  run({ args }) {
    const ok = removeToken(String(args.name));
    console.log(ok ? `✓ 已删除 ${String(args.name)}` : `没有这个 token：${String(args.name)}`);
    if (!ok) process.exit(1);
  },
});

const authRotate = defineCommand({
  meta: { name: 'rotate', description: '换掉一把 token 的值（等价于 set，但会提示旧值已替换）' },
  args: {
    name: { type: 'positional', required: true },
    value: { type: 'positional', required: true },
  },
  run({ args }) {
    const before = listTokens().find((t) => t.name === String(args.name));
    setToken(String(args.name), String(args.value));
    console.log(`✓ 已轮换 ${String(args.name)}${before ? `（旧值 ${before.masked}）` : ''}`);
  },
});

const auth = defineCommand({
  meta: { name: 'auth', description: '管理私有来源的 token' },
  subCommands: { set: authSet, list: authList, remove: authRemove, rotate: authRotate },
});

const doctor = defineCommand({
  meta: { name: 'doctor', description: '检查已装的包有没有被外部改写（文件被删、托管块被吃）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    json: { type: 'boolean', default: false },
    global: { type: 'boolean', default: false, description: '检查全局 harness（dsh / codex）' },
    targets: { type: 'string', default: 'dsh,codex', description: '全局检查目标，逗号分隔' },
  },
  run({ args }) {
    if (args.global) {
      const targets = String(args.targets)
        .split(',')
        .map((s) => s.trim())
        .filter((t) => t === 'dsh' || t === 'codex' || t === 'claude-code') as SyncTarget[];
      const results = doctorGlobal(targets);
      if (args.json) {
        console.log(JSON.stringify(results, null, 2));
        if (results.some((r) => r.error || !r.report?.ok)) process.exit(1);
        return;
      }
      for (const r of results) {
        console.log(`\n${r.target} ${r.root}`);
        if (r.error) {
          console.log(`  x ${r.error}`);
          continue;
        }
        if (!r.report || r.report.packs.length === 0) {
          console.log('  没有同步过包');
          continue;
        }
        if (r.report.ok) {
          console.log(`  ✓ ${r.report.packs.length} 个包全部在位`);
          continue;
        }
        for (const f of r.report.findings) {
          console.log(`  x ${f.pack}`);
          for (const m of f.filesMissing) console.log(`      文件不见了：${m}`);
          for (const b of f.blocksMissing) console.log(`      托管块不见了：${b}`);
        }
      }
      if (results.some((r) => r.error || !r.report?.ok)) process.exit(1);
      return;
    }
    const report = doctorPack(resolve(String(args.dir)));
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exit(1);
      return;
    }
    if (report.packs.length === 0) {
      console.log('这个目录没有装任何包');
      return;
    }
    console.log(`检查 ${report.packs.length} 个包`);
    for (const f of report.findings) {
      console.log(`x ${f.pack}`);
      for (const b of f.blocksMissing) console.log(`    托管块不见了：${b}（可能被宿主工具重新生成覆盖）`);
      for (const m of f.filesMissing) console.log(`    文件不见了：${m}`);
    }
    if (report.ok) {
      console.log('✓ 全部在位');
    } else {
      console.log('\n重新 install 可以补回缺失的块；如果宿主会自动重写指令文件，把 PackHub 的块当成"会被覆盖"的内容对待。');
      process.exit(1);
    }
  },
});

const probe = defineCommand({
  meta: { name: 'probe', description: '真机探针：跑一次 harness，看它有没有读到包写进去的指令' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    target: { type: 'string', default: 'dsh', description: 'dsh | claude-code | opencode | codex' },
    patch: { type: 'string', description: 'dsh 的 --patch 层（配置 provider / 模型）' },
    skill: { type: 'string', description: '改问技能选择器：断言这个 skill 名出现在可用列表里' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const target = String(args.target) as 'dsh' | 'claude-code' | 'opencode' | 'codex';
    const result = args.skill
      ? probeSkill({ target, projectDir: resolve(String(args.dir)), skill: String(args.skill) })
      : probeHarness({
          target,
          projectDir: resolve(String(args.dir)),
          ...(args.patch ? { patchFile: resolve(String(args.patch)) } : {}),
        });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exit(1);
      return;
    }
    console.log(result.ok ? '✓ harness 读到了托管块' : 'x 没读到');
    console.log(`  命令：${result.command}`);
    if (result.marker) console.log(`  期望标记：${result.marker}`);
    if (result.answer) console.log(`  回答：${result.answer.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (result.reason) console.log(`  原因：${result.reason}`);
    if (!result.ok) process.exit(1);
  },
});

const licenses = defineCommand({
  meta: { name: 'licenses', description: '列出每个资源的许可证情况（只查 vendored 的本地内容）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    strict: { type: 'boolean', default: false, description: '缺许可证就以非零码退出' },
    deny: { type: 'string', description: '拒绝的 SPDX 列表（逗号分隔），命中就失败' },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    const ctx = loadPack(dir);
    if (reportIssues(ctx.issues)) process.exit(2);
    const findings = inspectLicenses(dir, ctx.manifest);
    const denied = new Set(
      String(args.deny ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    );
    let missing = 0;
    let blocked = 0;
    for (const f of findings) {
      if (!f.vendored) {
        console.log(`- ${f.resource.padEnd(20)} 远程（许可在上游仓库）`);
        continue;
      }
      const spdx = (f.spdx ?? '').toUpperCase();
      if (denied.size > 0 && spdx && [...denied].some((d) => spdx.includes(d))) {
        blocked++;
        console.log(`x ${f.resource.padEnd(20)} ${f.spdx} · ${f.file}（命中拒绝列表）`);
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
    }
    if (blocked > 0) {
      console.log(`\n${blocked} 个资源命中拒绝的许可证：${[...denied].join(', ')}`);
      process.exit(1);
    }
    if (missing > 0 && args.strict) process.exit(1);
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
  async run({ args }) {
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
    writeSignature(dir, signature);
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
  async run({ args }) {
    const dir = resolve(String(args.dir));
    const ctx = loadPack(dir);
    if (reportIssues(ctx.issues)) process.exit(2);
    const { plan, issues } = planFor(ctx, { target: 'dir' });
    if (!plan) {
      reportIssues(issues, 'packhub verify-sig');
      process.exit(2);
    }
    const sigs = [...readSignatures(dir), ...(ctx.manifest.signatures ?? [])];
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
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const key = args.pack ? String(args.pack) : undefined;
    const res = removePack(dir, key);
    if (args.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
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
    target: { type: 'string', default: 'dir' },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    const lockPath = join(dir, 'packhub.lock.json');
    if (!existsSync(lockPath)) {
      console.error('没有 packhub.lock.json：先跑 packhub lock');
      process.exit(2);
    }
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      planHash: string;
      plan?: { actions: import('@packhub/kernel').PlanAction[] };
    };
    const ctx = withLockPins(loadPack(dir), loadLock(dir));
    if (reportIssues(ctx.issues)) process.exit(2);
    const { plan, issues } = planFor(ctx, { target: String(args.target ?? 'dir') as never });
    if (!plan) {
      reportIssues(issues, 'packhub diff');
      process.exit(2);
    }
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
  meta: { name: 'search', description: '在 registry 索引里按关键词找包' },
  args: {
    keyword: { type: 'positional', required: false, description: '名称 / 标题 / 描述 / 关键词' },
    index: { type: 'string', description: '索引路径、URL 或本机配置里的 registry 名（默认取 PACKHUB_INDEX / 本机配置）' },
    all: { type: 'boolean', default: false, description: '搜所有配置过的 registry' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const refs = args.all
      ? registryIndexes()
      : [resolveRegistry(args.index ? String(args.index) : undefined)].filter((r): r is string => Boolean(r));
    if (refs.length === 0) {
      console.error('没有索引：加 --index <路径|URL|registry 名>，或设 PACKHUB_INDEX，或在 ~/.packhub/config.json 配 registries');
      process.exit(2);
    }
    const keyword = String(args.keyword ?? '').toLowerCase();
    const hits: (import('@packhub/runtime').IndexEntry & { registry?: string })[] = [];
    for (const ref of refs) {
      const index = await readIndex(ref);
      for (const p of index.packs.filter((x) => {
        const text = [x.name, x.title ?? '', x.description ?? '', (x.keywords ?? []).join(' ')].join(' ').toLowerCase();
        return !keyword || text.includes(keyword);
      })) {
        hits.push(refs.length > 1 ? { ...p, registry: ref } : p);
      }
    }
    if (args.json) {
      console.log(JSON.stringify(hits, null, 2));
      return;
    }
    if (hits.length === 0) {
      console.log('没有匹配的包');
      return;
    }
    for (const p of hits) {
      const trust = p.trust === 'verified' ? '✓ verified' : 'community';
      console.log(`${p.name}@${p.latest}  ${trust}`);
      if (p.title) console.log(`  ${p.title}`);
      if (p.description) console.log(`  ${p.description}`);
      if (p.install) console.log(`  ${p.install}`);
    }
  },
});

const cacheLs = defineCommand({
  meta: { name: 'ls', description: '看缓存里有什么、谁还在用' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const report = inspectCache(resolve(String(args.dir)));
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (report.entries.length === 0) {
      console.log('缓存是空的');
      return;
    }
    for (const entry of report.entries) {
      console.log(
        `${entry.referenced ? '●' : '○'} ${entry.path.padEnd(48)} ${entry.kind.padEnd(8)} ${Math.max(1, Math.round(entry.bytes / 1024))} KB`,
      );
    }
    console.log(`\n共 ${Math.max(1, Math.round(report.totalBytes / 1024))} KB；○ 是没有任何已装版本引用的缓存`);
  },
});

const cacheClean = defineCommand({
  meta: { name: 'clean', description: '删掉没有被已装版本引用的缓存（先 dry-run 看清单）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    'dry-run': { type: 'boolean', default: false },
  },
  run({ args }) {
    const res = cleanCache(resolve(String(args.dir)), { dryRun: Boolean(args['dry-run']) });
    if (res.removed.length === 0) {
      console.log('没有可回收的缓存');
      return;
    }
    for (const p of res.removed) console.log(`  × ${p}`);
    console.log(
      `\n${res.dryRun ? '[dry-run] 将删除' : '已删除'} ${res.removed.length} 项，释放约 ${Math.max(1, Math.round(res.freedBytes / 1024))} KB`,
    );
  },
});

const cache = defineCommand({
  meta: { name: 'cache', description: '查看与回收 .packhub/cache' },
  subCommands: { ls: cacheLs, clean: cacheClean },
});

const discover = defineCommand({
  meta: { name: 'discover', description: '搜 MCP / skill / CLI 候选，并把选中的写进清单' },
  args: {
    keyword: { type: 'positional', required: false, description: '关键词；留空列出全部' },
    catalog: { type: 'string', description: '资源目录（文件或 URL；默认取 index 同目录的 resources.json）' },
    index: { type: 'string', description: '索引路径或 URL，用来找同目录的 resources.json' },
    npm: { type: 'boolean', default: false, description: '同时查 npm registry（联网）' },
    type: { type: 'string', description: '只看某一类：mcp / skill / prompt / knowledge / config / tool' },
    limit: { type: 'string', default: '10' },
    add: { type: 'string', description: '把第几个结果写进清单（从 1 开始）' },
    dir: { type: 'string', default: '.', description: 'Pack 目录（配合 --add）' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const keyword = String(args.keyword ?? '');
    const limit = Math.max(1, Number(args.limit) || 10);
    const local = await loadCatalog({
      ...(args.catalog ? { catalog: String(args.catalog) } : {}),
      ...(args.index ? { index: String(args.index) } : {}),
    });
    const npmRes = args.npm ? await searchNpm(keyword || 'mcp', limit) : { entries: [] as never[] };
    if (local.error) console.warn(`warn  ${local.error}`);
    if ('error' in npmRes && npmRes.error) console.warn(`warn  ${npmRes.error}`);

    const seen = new Set<string>();
    const entries = [...local.entries, ...npmRes.entries].filter((e) => {
      if (seen.has(e.source)) return false;
      seen.add(e.source);
      return true;
    });
    let hits = searchResources(entries, keyword);
    if (args.type) hits = hits.filter((h) => h.entry.type === String(args.type));
    hits = hits.slice(0, limit);

    if (hits.length === 0) {
      console.log('没有匹配的资源候选');
      if (!args.npm) console.log('试试加 --npm（联网查 npm），或用 --catalog 指向一份资源目录');
      return;
    }

    if (args.add !== undefined) {
      const n = Number(args.add);
      if (!Number.isInteger(n) || n < 1 || n > hits.length) {
        console.error(`--add 超出范围：1..${hits.length}`);
        process.exit(2);
      }
      const pick = hits[n - 1]!.entry;
      const file = join(resolve(String(args.dir)), 'packhub.yaml');
      if (!existsSync(file)) {
        console.error(`没有 packhub.yaml：${file}（先跑 packhub init）`);
        process.exit(2);
      }
      const added = addResource(file, { type: pick.type, source: pick.source });
      console.log(`✓ 已追加资源 ${added.id}（${pick.type}）→ ${file}`);
      console.log(`  source: ${pick.source}`);
      console.log('下一步：packhub install . --dry-run 看计划');
      return;
    }

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            catalog: local.source,
            resources: hits.map((h) => ({ ...h.entry, score: h.score, matched: h.matched })),
          },
          null,
          2,
        ),
      );
      return;
    }
    for (const [i, hit] of hits.entries()) {
      const e = hit.entry;
      console.log(`${String(i + 1).padStart(2)}. [${e.type.padEnd(9)}] ${e.title ?? e.id}`);
      console.log(`    ${e.source}`);
      if (e.description) console.log(`    ${e.description}`);
    }
    console.log(`\n目录：${local.source}${args.npm ? ' + npm search' : ''}`);
    console.log('写进清单：packhub discover "<关键词>" ' + (args.index ? `--index ${String(args.index)} ` : '') + `--add <序号> --dir .`);
  },
});

const hub = defineCommand({
  meta: { name: 'hub', description: '启动只读发布端（索引、包页、计划预览；没有执行接口）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    port: { type: 'string', default: '8788' },
    host: { type: 'string', default: '127.0.0.1', description: '非回环地址必须配鉴权' },
    token: { type: 'string', description: '静态 token（也可用 PACKHUB_HUB_TOKEN）' },
    'user-header': { type: 'string', description: '反向代理注入的身份头，例如 X-Forwarded-User' },
    audit: { type: 'string', description: '审计日志文件（每行一个 JSON）' },
    rpm: { type: 'string', default: '240', description: '每 IP 每分钟请求上限，0 不限' },
  },
  async run({ args }) {
    const server = await startHub({
      root: resolve(String(args.dir)),
      port: Number(args.port),
      host: String(args.host),
      staticDir: defaultStaticDir(),
      ...(args.token ? { auth: { token: String(args.token) } } : {}),
      ...(args['user-header'] ? { auth: { userHeader: String(args['user-header']) } } : {}),
      ...(args.audit ? { auditFile: resolve(String(args.audit)) } : {}),
      rpm: Number(args.rpm),
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : Number(args.port);
    console.log(`Hub（只读）→ http://${String(args.host)}:${port}  ${args.token || args['user-header'] ? '（已启用鉴权）' : '（回环，无鉴权）'}`);
    console.log('执行接口一个都没有；安装请用 packhub install / add');

    // 优雅退出：收到信号先停监听，等在途请求写完再走
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        console.log(`${signal} → 停止接收新请求`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
      });
    }
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
    try {
      const server = await startServer({ root, port, staticDir: defaultStaticDir() });
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      console.log(`PackHub 面板：http://127.0.0.1:${actual}  (root=${root})`);
      console.log('port 传 0 由系统分配，适合同时起多个面板；关闭用 Ctrl+C');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        console.error(`端口 ${port} 已被占用：换 --port <n>，或 --port 0 让系统分配`);
      } else {
        console.error(`x ${(err as Error).message}`);
      }
      process.exit(1);
    }
  },
});

const completion = defineCommand({
  meta: { name: 'completion', description: '输出 shell 补全脚本（bash / zsh / pwsh）' },
  args: {
    shell: { type: 'positional', required: true, description: 'bash | zsh | pwsh' },
  },
  run({ args }) {
    const names = Object.keys((main.subCommands ?? {}) as Record<string, unknown>)
      .filter((n) => n !== 'completion')
      .sort();
    const shell = String(args.shell);
    if (shell === 'bash') {
      console.log(`# packhub bash completion\ncomplete -W "${names.join(' ')}" packhub`);
      return;
    }
    if (shell === 'zsh') {
      console.log(
        `# packhub zsh completion\n_packhub() { local -a cmds; cmds=(${names.map((n) => `'${n}'`).join(' ')}); _describe 'command' cmds }\ncompdef _packhub packhub`,
      );
      return;
    }
    if (shell === 'pwsh' || shell === 'powershell') {
      console.log(
        `# packhub PowerShell completion\nRegister-ArgumentCompleter -Native -CommandName packhub -ScriptBlock {\n  param($wordToComplete, $commandAst, $cursorPosition)\n  $cmds = @(${names.map((n) => `'${n}'`).join(', ')})\n  $cmds | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {\n    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)\n  }\n}`,
      );
      return;
    }
    console.error(`不支持的 shell：${shell}（bash / zsh / pwsh）`);
    process.exit(2);
  },
});

export const main: CommandDef = defineCommand({
  meta: { name: 'packhub', version: '0.0.1', description: 'Agent 能力的整合包工具' },
  subCommands: {
    plan,
    install,
    uninstall,
    rollback,
    versions,
    activate,
    update,
    verify,
    lock,
    init,
    serve,
    search,
    discover,
    cache,
    add,
    sync,
    resource,
    slot,
    diff,
    pack,
    hub,
    doctor,
    auth,
    trust,
    audit,
    market,
    run,
    publish,
    probe,
    licenses,
    keygen,
    sign,
    'verify-sig': verifySig,
    completion,
  },
});
