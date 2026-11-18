// 由 cli.ts 拆分：add / update / sync
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EXIT,
  command,
  issueError,
  issueWarn,
  json,
  orStop,
  problemRaw,
  say,
  sayUnless,
  stop,
  warn,
} from '../emit.ts';
import { parsePackRef } from '../ref.ts';
import {
  loadPack,
  planFor,
  mergeLocalOverrides,
  readLocalOverrides,
  validateGraph,
  checkLockConsistency,
  PACKHUB_ENV,
  STATE_DIR,
  TARGET_IDS,
} from '@packhub/kernel';
import {
  fetchPack,
  updatePack,
  resolveAddSource,
  installPack,
  verifyInstalled,
  loadLock,
  inspectPack,
  withLockPins,
  resolveRegistry,
  syncPack,
  removeSynced,
  signaturePolicy,
  appendAudit,
  resolveSyncTargets,
} from '@packhub/runtime';
import { reportIssues, printPlan, SAFE_CHECKS } from './shared.ts';

export const add = command({
  meta: { name: 'add', description: '装一个包：registry 名称、.phub 归档，或 git+https 仓库' },
  args: {
    source: {
      type: 'positional',
      required: true,
      description: 'scope/name（配合 --index）、./x.phub，或 git+https://github.com/o/r@ref',
    },
    index: { type: 'string', description: `registry 的 index.json（本地路径或 URL；也可用 ${PACKHUB_ENV.index}）` },
    version: { type: 'string', description: 'registry 包的版本，默认 latest' },
    dir: { type: 'string', default: '.', description: '项目目录' },
    target: { type: 'string', default: 'dir', description: `${TARGET_IDS.join(' | ')}` },
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
    const say = sayUnless(args.json);
    const target = String(args.source);
    const targetEnv = String(args.target);
    const registryName = target;
    const registryVersion = args.version ? String(args.version) : undefined;
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
      packDir = join(workBase, STATE_DIR, 'packs', slug);
      say(`→ 取 ${target} …`);
      const resolved = await resolveAddSource(target, packDir);
      packDir = resolved.dir;
      label = resolved.label;
    } else {
      const indexRef = resolveRegistry(args.index ? String(args.index) : undefined);
      if (!indexRef) {
        problemRaw(
          `用 registry 名称安装需要一个索引：加 --index <路径|URL>，或设 ${PACKHUB_ENV.index}，或在 ~/.packhub/config.json 里配 defaultRegistry`,
        );
        stop(EXIT.USAGE);
      }
      packDir = join(workBase, STATE_DIR, 'packs', registryName);
      say(`→ 取 ${registryName}${registryVersion ? `@${registryVersion}` : ''} …`);
      const fetched = await fetchPack({
        name: registryName,
        index: indexRef,
        ...(registryVersion ? { version: registryVersion, allowUnlisted: true } : {}),
        dest: packDir,
      });
      label = `${registryName}@${fetched.version}`;
    }

    const rawCtx = loadPack(packDir);
    if (!rawCtx.manifest) {
      reportIssues(rawCtx.issues);
      stop(EXIT.USAGE);
    }
    const read = loadLock(packDir);
    if (read.problem) {
      reportIssues([read.problem]);
      stop(EXIT.USAGE);
    }
    const lock = read.lock;
    // 清单里写的是 tag/范围也没关系：按锁把它换成本次要装的 commit/版本
    let ctx = withLockPins(rawCtx, lock);
    if (reportIssues(ctx.issues)) stop(EXIT.USAGE);
    // 锁核对（消费端单点）：锁只描述内容（清单 + resolved），判据与文案都来自 kernel 的
    // checkLockConsistency。安装 target 不参与核对；装到哪个 target 由下面按 --target 现算。
    const lockCheck = checkLockConsistency(lock, ctx.manifest);
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
    const inspection = inspectPack(packDir, ctx.manifest, { ...(trusted ? { trusted } : {}) });
    // 锁 ↔ 清单的结论只认 kernel 一处：inspectPack 里的同类比较不再重复采用，
    // 只把它自己的结论按旧行格式（严重级 + [code]）打出来；验证报告/签名等 issue 照旧。
    const lockIssues =
      lockCheck.status === 'mismatch'
        ? [
            { code: 'lock-mismatch', severity: 'error' as const, message: lockCheck.message },
            ...inspection.issues.filter((i) => i.code !== 'lock-mismatch'),
          ]
        : inspection.issues;
    for (const issue of lockIssues) {
      if (issue.severity === 'error') issueError(issue.code, issue.message);
      else issueWarn(issue.code, issue.message);
    }
    const lockErrors = lockIssues.filter((i) => i.severity === 'error');
    if (lockErrors.length > 0 && !args['allow-stale-lock']) {
      problemRaw('\n锁核对未通过，已停止安装（确认来源后加 --allow-stale-lock）。');
      stop(EXIT.USAGE);
    }
    const goodSignatures = inspection.signatures.filter((s) => s.ok).length;
    const trustedSignatures = trusted
      ? inspection.signatures.filter((s) => s.ok && trusted.includes(s.key)).length
      : goodSignatures;
    if (policy.require && trustedSignatures === 0) {
      problemRaw(
        `这个包没有${policy.trusted ? '被信任列表认可' : '有效'}的签名（默认策略/signature 要求）。` +
          `\n  先确认发布者，再用 packhub trust add <公钥 id> 加入信任列表；确实不用签名时加 --allow-unsigned。`,
      );
      stop(EXIT.USAGE);
    }
    if (inspection.signatures.length > 0) {
      say(`签名 ${goodSignatures}/${inspection.signatures.length} 有效${trusted ? `，信任列表内 ${trustedSignatures} 个` : ''}`);
    } else if (!policy.require) {
      say('这个包没有签名（未配置信任列表，按开发者模式继续）');
    }

    // 项目根的 .packhub/local.yaml 只改这次安装：补丁、绑定、变量
    const local = readLocalOverrides(projectDir);
    if (local.file) {
      const merged = mergeLocalOverrides(ctx.manifest, local.file);
      const validated = validateGraph(merged.manifest);
      const localIssues = [...local.issues, ...merged.issues, ...validated.issues];
      if (localIssues.some((i) => i.severity === 'error')) {
        reportIssues(localIssues, 'packhub add（local.yaml）');
        stop(EXIT.USAGE);
      }
      ctx = {
        ...ctx,
        manifest: merged.manifest,
        graph: validated.graph,
        issues: [...ctx.issues, ...localIssues],
      };
      say('已应用 .packhub/local.yaml 补丁');
    }

    const { plan, issues } = planFor(ctx, { target: targetEnv as never });
    if (!plan) {
      reportIssues(issues, 'packhub add');
      stop(EXIT.USAGE);
    }

    if (args['dry-run']) {
      if (args.json) json({ label, dryRun: true, plan });
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
        json({ label, planHash: plan.planHash, outcomes: result.outcomes, rolledBack: result.rolledBack ?? false });
      } else if (result.rolledBack) {
        problemRaw('\n有动作失败，已按快照回滚：磁盘回到安装前，state 未写入。');
      }
      stop(EXIT.RUNTIME);
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
      warn(`审计写入失败：${(err as Error).message}`);
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
          json({ label, planHash: plan.planHash, outcomes: result.outcomes, installed: false, verification: reports });
        } else {
          problemRaw('装上了，但有校验没过；先修清单里的 verify 或确认环境。');
        }
        stop(EXIT.RUNTIME);
      }
    }
    if (args.json) {
      json({
            label,
            pack: `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`,
            planHash: plan.planHash,
            outcomes: result.outcomes,
            installed: true,
            ...(reports ? { verification: reports } : {}),
          });
    }
  },
});

export const update = command({
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
    json: { type: 'boolean', default: false, description: '输出结构化结果（脚本用）' },
  },
  async run({ args }) {
    const indexRef = resolveRegistry(args.index ? String(args.index) : undefined);
    if (!indexRef) {
      problemRaw(`没有索引：加 --index <路径|URL|registry 名>，或设 ${PACKHUB_ENV.index}`);
      stop(EXIT.USAGE);
    }
    const say = sayUnless(args.json);
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
      if (args.json) json(res);
      else say(`${res.name} 已是最新（planHash ${res.planHash.slice(0, 22)}…）`);
      return;
    }
    say(`更新 ${res.from ?? '(未装)'} → ${res.to}`);
    for (const a of res.removed) say(`  - ${a}（计划里移除）`);
    for (const a of res.added) say(`  + ${a}`);
    for (const p of res.pruned) say(`  × ${p}（已从磁盘清掉）`);
    for (const w of res.warnings) warn(w);
    say(`\nplanHash ${res.planHash.slice(0, 22)}…（可用 packhub rollback 退回）`);
    try {
      appendAudit({
        action: 'update',
        pack: res.name,
        version: parsePackRef(res.to)?.version ?? res.to,
        planHash: res.planHash,
        ok: true,
        root: resolve(String(args.dir)),
      });
    } catch (err) {
      warn(`审计写入失败：${(err as Error).message}`);
    }

    let reports: Awaited<ReturnType<typeof verifyInstalled>> | undefined;
    if (res.changed && !args['no-verify']) {
      reports = await verifyInstalled(resolve(String(args.dir)), {
        pack: res.to,
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
        if (args.json) json({ ...res, verify: reports });
        problemRaw('更新完成，但有校验没过；可用 rollback 退回上一版。');
        stop(EXIT.RUNTIME);
      }
    }
    if (args.json) json({ ...res, ...(reports ? { verify: reports } : {}) });
  },
});

export const sync = command({
  meta: { name: 'sync', description: '把本地 skill / mcp 同步到各宿主 home 的全局落点（--to 支持 .）' },
  args: {
    dir: { type: 'positional', required: true, description: 'Pack 目录' },
    to: { type: 'string', required: true, description: '目标，逗号分隔；. 表示包声明的全部（--remove 时为全部已注册）' },
    'dry-run': { type: 'boolean', default: false },
    remove: { type: 'boolean', default: false, description: '从目标 harness 移除这个包' },
    overwrite: { type: 'boolean', default: false, description: '允许覆盖别的包占用的 skill 目录' },
    json: { type: 'boolean', default: false, description: '输出结构化结果（脚本用）' },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    // `.` 按包声明的 targets 展开；移除时不看声明，避免包改了清单就删不掉
    const declared = args.remove ? [] : (loadPack(dir).manifest?.metadata.targets ?? []);
    const targets = orStop(() => resolveSyncTargets(String(args.to), declared));
    if (args.remove) {
      const results = removeSynced(dir, targets);
      if (args.json) {
        json({ removed: results });
        return;
      }
      for (const res of results) {
        say(`${res.target} ${res.root}：移除 ${res.packs.length} 个包，${res.removed.length} 个路径`);
        for (const p of res.removed) say(`  - ${p}`);
      }
      return;
    }
    const { pack, results } = await syncPack(dir, {
      targets,
      dryRun: Boolean(args['dry-run']),
      overwrite: Boolean(args.overwrite),
    });
    if (args.json) {
      json({ pack, dryRun: Boolean(args['dry-run']), results });
      return;
    }
    say(`${pack}（${args['dry-run'] ? 'dry-run' : '同步'}）`);
    for (const res of results) {
      say(`  ${res.target} → ${res.root}`);
      if (res.planHash) say(`    planHash ${res.planHash.slice(0, 22)}…`);
      for (const o of res.outcomes ?? []) {
        const mark = o.status === 'done' || o.status === 'noop' ? '✓' : 'x';
        say(`    ${mark} ${o.actionId.padEnd(16)} ${o.status.padEnd(8)} ${o.target ?? ''}`);
      }
      for (const m of res.mcp ?? []) {
        say(`    ${m.status === 'planned' ? '·' : '✓'} mcp ${m.id.padEnd(14)} ${m.status}`);
      }
    }
  },
});
