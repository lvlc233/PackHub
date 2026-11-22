// 由 cli.ts 拆分：install（吸收原 add）——一个动词：把来源装进一个目录。
//
// 来源分两种「面」，检查强度不同：
// - 本地 Pack 目录（含默认 '.'）：作者流。目录里的清单直接算计划，不要求锁与签名；
// - 外部来源（.phub / git+https / registry 名）：消费流。先取包，再核对锁与签名，
//   装完按 SAFE_CHECKS 复核。
//
// 装到哪由 --dir 决定（项目根，默认当前目录）；要跑起来用 pal create，不在这一层。
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EXIT,
  command,
  issueError,
  issueWarn,
  json,
  problemRaw,
  sayUnless,
  stop,
  warn,
} from '../emit.ts';
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
  installPack,
  verifyInstalled,
  loadLock,
  inspectPack,
  withLockPins,
  resolveRegistry,
  resolveAddSource,
  signaturePolicy,
  appendAudit,
  type ActionOutcome,
} from '@packhub/runtime';
import { parsePackRef } from '../ref.ts';
import { reportIssues, printPlan, SAFE_CHECKS } from './shared.ts';

type Say = (line: string) => void;

/**
 * 判断 SOURCE 该走哪条路：
 * - `.phub` / `git+…` 明摆着是外部归档/仓库；
 * - 写成路径的样子（.、..、./x、绝对路径）或磁盘上真的存在 → 本地 Pack 目录；
 * - 其余（owner/name）当 registry 名，配 --index / --version。
 */
function sourceKind(source: string): 'local' | 'external' | 'registry' {
  if (source.endsWith('.phub') || source.startsWith('git+')) return 'external';
  if (isAbsolute(source) || source === '.' || source === '..' || /^\.\.?[\\/]/.test(source)) {
    return 'local';
  }
  return existsSync(source) ? 'local' : 'registry';
}

function printOutcomes(sayLine: Say, outcomes: ActionOutcome[]): void {
  for (const o of outcomes) {
    const mark = o.status === 'failed' ? 'x' : o.status === 'skipped' ? '-' : '✓';
    sayLine(`${mark} ${o.actionId.padEnd(16)} ${o.status.padEnd(14)} ${o.message ?? o.target ?? ''}`);
  }
}

interface CommonInstall {
  projectDir: string;
  target: string;
  dryRun: boolean;
  overwrite: boolean;
  allowExec: boolean;
  jsonOut: boolean;
  sayLine: Say;
}

/** 本地 Pack 目录：清单在目录里，作者流不设锁/签名门。 */
async function installLocal(sourceDir: string, opts: CommonInstall): Promise<void> {
  // 本地目录这条路不消费 local.yaml，但旧字段（如已删的 pick）要让人看见，不能静默
  const local = readLocalOverrides(opts.projectDir);
  if (local.issues.length > 0) reportIssues(local.issues, 'packhub install（local.yaml）');
  const packRoot = resolve(sourceDir);
  const ctx = loadPack(packRoot);
  if (reportIssues(ctx.issues)) stop(EXIT.USAGE);
  const { plan: p, issues } = planFor(ctx, { target: opts.target as never });
  if (!p) {
    reportIssues(issues);
    stop(EXIT.USAGE);
  }
  const result = await installPack(ctx, p, {
    root: opts.projectDir,
    packRoot,
    dryRun: opts.dryRun,
    allowExec: opts.allowExec,
    overwrite: opts.overwrite,
  });
  if (!opts.jsonOut) printOutcomes(opts.sayLine, result.outcomes);
  if (result.outcomes.some((o) => o.status === 'failed')) {
    if (opts.jsonOut) {
      json({ planHash: p.planHash, outcomes: result.outcomes, rolledBack: result.rolledBack ?? false });
    } else if (result.rolledBack) {
      problemRaw('\n有动作失败，已按快照回滚：磁盘回到安装前，state 未写入。');
    }
    stop(EXIT.RUNTIME);
  }
  if (opts.dryRun) {
    // dry-run 也按同一形状给结构化结果，脚本不用为「真装」和「看计划」写两条分支
    if (opts.jsonOut) json({ planHash: p.planHash, outcomes: result.outcomes, dryRun: true });
    return;
  }
  if (opts.jsonOut) {
    json({ planHash: p.planHash, outcomes: result.outcomes, statePath: result.statePath });
  } else {
    opts.sayLine(`\n装到 ${opts.projectDir}`);
    opts.sayLine(`state: ${result.statePath}`);
  }
  // 审计写入留在命令层，不搬进 runtime 的安装入口：
  // 1) installPack 还被 launcher（create / update）调用，搬进 applyPlan / installPack 会让
  //    它们凭空多出审计行，属于副作用扩展；
  // 2) 这里只在「非 dry-run、没有失败、state 已落盘」之后写，dry-run 与回滚路径不写，
  //    写失败只 warn 不阻断（TRU-11）。
  try {
    appendAudit({
      action: 'install',
      pack: p.pack.name,
      version: p.pack.version,
      planHash: p.planHash,
      ok: true,
      root: opts.projectDir,
    });
  } catch (err) {
    warn(`审计写入失败：${(err as Error).message}`);
  }
}

interface ExternalInstall extends CommonInstall {
  source: string;
  index?: string;
  version?: string;
  allowStaleLock: boolean;
  requireSignature: boolean;
  allowUnsigned: boolean;
  noVerify: boolean;
}

/** 外部来源：取包 → 锁核对 → 签名 → 装 → 复核。 */
async function installExternal(opts: ExternalInstall): Promise<void> {
  const sayLine = opts.sayLine;
  const source = opts.source;
  // dry-run 不往项目里落任何东西：取包与解包都在临时目录完成
  const workBase = opts.dryRun ? mkdtempSync(join(tmpdir(), 'packhub-install-')) : opts.projectDir;

  let packDir: string;
  let label: string;

  if (source.endsWith('.phub') || source.startsWith('git+')) {
    const slug = source
      .replace(/^git\+/, '')
      .replace(/\.phub$/, '')
      .replace(/[@/\\:]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(-48);
    packDir = join(workBase, STATE_DIR, 'packs', slug);
    sayLine(`→ 取 ${source} …`);
    const resolved = await resolveAddSource(source, packDir);
    packDir = resolved.dir;
    label = resolved.label;
  } else {
    const indexRef = resolveRegistry(opts.index);
    if (!indexRef) {
      problemRaw(
        `用 registry 名称安装需要一个索引：加 --index <路径|URL>，或设 ${PACKHUB_ENV.index}，或在 ~/.packhub/config.json 里配 defaultRegistry`,
      );
      stop(EXIT.USAGE);
    }
    // `name@version` 与 --version 是同一件事的两种写法；给了两个不同的就直接问清楚
    const ref = parsePackRef(source);
    const name = ref?.name ?? source;
    let version = ref?.version;
    if (opts.version) {
      if (version && version !== opts.version) {
        problemRaw(`版本给了两个：${source} 里写 ${version}，--version 是 ${opts.version}；留一个`);
        stop(EXIT.USAGE);
      }
      version = opts.version;
    }
    packDir = join(workBase, STATE_DIR, 'packs', name);
    sayLine(`→ 取 ${name}${version ? `@${version}` : ''} …`);
    const fetched = await fetchPack({
      name,
      index: indexRef,
      ...(version ? { version, allowUnlisted: true } : {}),
      dest: packDir,
    });
    label = `${name}@${fetched.version}`;
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
  // 信任来源：本机持久信任列表（packhub trust add）；有列表就只认列表内的公钥
  const policy = signaturePolicy({
    require: opts.requireSignature,
    allowUnsigned: opts.allowUnsigned,
  });
  const trusted = (policy.trusted ?? []).length > 0 ? policy.trusted : undefined;
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
  if (lockErrors.length > 0 && !opts.allowStaleLock) {
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
    sayLine(
      `签名 ${goodSignatures}/${inspection.signatures.length} 有效${trusted ? `，信任列表内 ${trustedSignatures} 个` : ''}`,
    );
  } else if (!policy.require) {
    sayLine('这个包没有签名（未配置信任列表，按开发者模式继续）');
  }

  // 项目根的 .packhub/local.yaml 只改这次安装：补丁、变量
  const local = readLocalOverrides(opts.projectDir);
  if (local.file) {
    const merged = mergeLocalOverrides(ctx.manifest, local.file);
    const validated = validateGraph(merged.manifest);
    const localIssues = [...local.issues, ...merged.issues, ...validated.issues];
    if (localIssues.length > 0) reportIssues(localIssues, 'packhub install（local.yaml）');
    if (localIssues.some((i) => i.severity === 'error')) {
      stop(EXIT.USAGE);
    }
    ctx = {
      ...ctx,
      manifest: merged.manifest,
      graph: validated.graph,
      issues: [...ctx.issues, ...localIssues],
    };
    sayLine('已应用 .packhub/local.yaml 补丁');
  }

  const { plan: p, issues } = planFor(ctx, { target: opts.target as never });
  if (!p) {
    reportIssues(issues, 'packhub install');
    stop(EXIT.USAGE);
  }

  if (opts.dryRun) {
    if (opts.jsonOut) json({ label, dryRun: true, plan: p });
    else printPlan(p);
    rmSync(workBase, { recursive: true, force: true });
    return;
  }

  const result = await installPack(ctx, p, {
    root: opts.projectDir,
    packRoot: packDir,
    overwrite: opts.overwrite,
    allowExec: opts.allowExec,
  });
  if (!opts.jsonOut) printOutcomes(sayLine, result.outcomes);
  if (result.outcomes.some((o) => o.status === 'failed')) {
    if (opts.jsonOut) {
      json({ label, planHash: p.planHash, outcomes: result.outcomes, rolledBack: result.rolledBack ?? false });
    } else if (result.rolledBack) {
      problemRaw('\n有动作失败，已按快照回滚：磁盘回到安装前，state 未写入。');
    }
    stop(EXIT.RUNTIME);
  }
  sayLine(`\n装上 ${label} → ${opts.projectDir}`);
  try {
    appendAudit({
      action: 'install',
      pack: ctx.manifest.metadata.name,
      version: ctx.manifest.metadata.version,
      planHash: p.planHash,
      ok: true,
      root: opts.projectDir,
    });
  } catch (err) {
    warn(`审计写入失败：${(err as Error).message}`);
  }

  // 装完立刻复核：否则「装上了」和「能用」之间又断了一层
  let reports: Awaited<ReturnType<typeof verifyInstalled>> | undefined;
  if (!opts.noVerify) {
    const key = `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`;
    reports = await verifyInstalled(opts.projectDir, { pack: key, types: [...SAFE_CHECKS] });
    for (const r of reports) {
      sayLine(`\n校验 ${r.pack}：${r.ok ? '通过' : '未通过'}`);
      for (const c of r.results) {
        const mark = c.status === 'pass' ? '✓' : c.status === 'fail' ? 'x' : '-';
        sayLine(`  ${mark} [${c.index}] ${c.type.padEnd(18)} ${c.status.padEnd(8)} ${c.detail}`);
      }
    }
    if (!reports.every((r) => r.ok)) {
      if (opts.jsonOut) {
        json({ label, planHash: p.planHash, outcomes: result.outcomes, installed: false, verification: reports });
      } else {
        problemRaw('装上了，但有校验没过；先修清单里的 verify 或确认环境。');
      }
      stop(EXIT.RUNTIME);
    }
  }
  if (opts.jsonOut) {
    json({
      label,
      pack: `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`,
      planHash: p.planHash,
      outcomes: result.outcomes,
      installed: true,
      ...(reports ? { verification: reports } : {}),
    });
  }
}

export const install = command({
  meta: {
    name: 'install',
    description: '装进一个目录：Pack 目录 / .phub / registry 名 / git+https；要跑起来用 pal create',
  },
  args: {
    source: {
      type: 'positional',
      required: false,
      default: '.',
      description: 'Pack 目录、./x.phub、registry 名（name 或 name@version，配 --index），或 git+https://host/o/r@ref',
    },
    dir: { type: 'string', default: '.', description: '项目根：装到这里（默认当前目录）' },
    index: { type: 'string', description: `registry 的 index.json（本地路径或 URL；也可用 ${PACKHUB_ENV.index}）` },
    version: { type: 'string', description: 'registry 包的版本，默认 latest；与 name@version 等效' },
    target: { type: 'string', default: 'dir', description: `${TARGET_IDS.join(' | ')}` },
    'dry-run': { type: 'boolean', default: false, description: '只打印计划，不落盘' },
    overwrite: { type: 'boolean', default: false, description: '允许覆盖别的包写过的文件' },
    'allow-stale-lock': {
      type: 'boolean',
      default: false,
      description: '外部来源：锁与清单对不上也继续装（默认拒绝）',
    },
    'require-signature': {
      type: 'boolean',
      default: false,
      description: '外部来源：没有有效签名就拒绝安装',
    },
    'allow-unsigned': {
      type: 'boolean',
      default: false,
      description: '外部来源：即使配置了信任列表也接受无签名包（显式降低要求）',
    },
    'no-verify': { type: 'boolean', default: false, description: '外部来源：装完不跑 verify 检查' },
    'allow-exec': { type: 'boolean', default: false, description: '允许执行清单里的 install.exec' },
    json: { type: 'boolean', default: false, description: '输出结构化结果（脚本用）' },
  },
  async run({ args }) {
    const projectDir = resolve(String(args.dir));
    const source = String(args.source ?? '.');
    const common: CommonInstall = {
      projectDir,
      target: String(args.target ?? 'dir'),
      dryRun: Boolean(args['dry-run']),
      overwrite: Boolean(args.overwrite),
      allowExec: Boolean(args['allow-exec']),
      jsonOut: Boolean(args.json),
      sayLine: sayUnless(Boolean(args.json)),
    };
    const kind = sourceKind(source);
    if (kind === 'local') {
      await installLocal(source, common);
      return;
    }
    await installExternal({
      ...common,
      source,
      ...(args.index ? { index: String(args.index) } : {}),
      ...(args.version ? { version: String(args.version) } : {}),
      allowStaleLock: Boolean(args['allow-stale-lock']),
      requireSignature: Boolean(args['require-signature']),
      allowUnsigned: Boolean(args['allow-unsigned']),
      noVerify: Boolean(args['no-verify']),
    });
  },
});
