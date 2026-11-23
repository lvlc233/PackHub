import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { MANIFEST_FILE, planFor, type PackContext, type Plan, type PlanOptions } from '@packhub/kernel';
import { installPack, loadLock, loadPack, loadState, withLockPins, type ActionOutcome } from '@packhub/runtime';
import {
  adapterFor,
  assertAttachedSupported,
  destinationContext,
  requireAdapter,
  type InstanceKind,
} from './layout.ts';
import { baselineFromState, writeBaseline } from './baseline.ts';
import { withInstanceLock } from './lock.ts';
import { API_VERSION, readRecord, recordFile, runtimeFile, type InstanceRecord } from './records.ts';
import { assertIsolationSupported, parseIsolation, type Isolation } from './isolation.ts';
import { readPalConfig } from './config.ts';
import { dropActive, readActiveMap, requireInstance, writeActiveMap } from './catalog.ts';
import { failInstance } from './quarantine.ts';
import { writeInstance, removeLink } from './recordWrite.ts';
import { instancesRoot, newId } from './paths.ts';
import { isPidAlive } from './process.ts';
import { nowIso } from './time.ts';
import { PalError } from './errors.ts';
import {
  assertAbsolutePath,
  assertHarness,
  assertExternalRoot,
  assertNameFree,
  assertProfileName,
  assertProfileTarget,
  homePathInput,
} from './validators.ts';

/**
 * 建实例与接管：出计划、装 Pack、写记录与基线；接管只写指针，不动用户目录。
 * 从 index.ts 搬出来；不 import index.ts（避免循环），依赖只走 kernel/runtime 与包内底层模块。
 * 名字/宿主的校验在 validators.ts，这里只 import 使用，不重新导出。
 */

/**
 * 命名 home 的默认名：`<host>-<packSlug>`。
 * packSlug = `pack.name`（`owner/name`）小写，非字母数字压成 `-`：
 * `lvlc233/doc-review` → `lvlc233-doc-review`。
 */
export function packSlug(packName: string): string {
  const slug = packName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'pack';
}

/** 默认 home 名：宿主 + Pack 的 slug；`--name` 可以覆盖。 */
export function defaultHomeName(host: string, packName: string): string {
  return `${host}-${packSlug(packName)}`;
}

export interface CreateInstanceOptions {
  name: string;
  /** 实例形态：dir 是项目目录实例，其余是宿主名 */
  harness: InstanceKind;
  /** 已经落到本地的 Pack 目录 */
  packDir: string;
  /**
   * 实例根；不写就建在 instances 根下的新目录里。
   * 写了只接受绝对路径，且不能是盘符根/文件系统根、不能落在 instances 根里。
   */
  root?: string;
  /**
   * attached home：装进宿主真实的全局目录（绝对路径）。
   * 给了就用该宿主的 attached 落点、记录 attached=true；root 必须不写。
   */
  attachedHome?: string;
  /**
   * dsh attached home 的 profile（只装这一个）；不写 = all（枚举所有已有 profile）。
   * 只对 dsh 的 attached home 有意义，其它宿主 / 项目 / managed home 传了是用法错。
   */
  profile?: string;
  /** 记录来源（materialize 前的原始引用），供导出模板与排障 */
  packRef?: string;
  /** 建完是否设为该宿主的当前实例；默认 true */
  activate?: boolean;
  /** 已经探测到的宿主版本；不写就留空 */
  harnessVersion?: string;
  /**
   * 从一个已有的宿主 home 里带来模型凭据与用户指令（不覆盖 Pack 装的东西）。
   * 新 home 是空的：不接这一步，实例起来也没有模型可用。
   */
  seedFrom?: string;
  /**
   * 只带凭据：把该宿主 `credentialFiles` 里登记的文件从 `fromHome` 复制到新 home 的对应位置。
   * managed home 想沿用全局凭据时用（attached home 直接就是宿主的全局目录，不需要）。
   */
  fromHome?: string;
  /**
   * 显式指定这份实例的隔离策略（优先于配置文件）。
   * 不写就用 readPalConfig().isolation；写了必须是合法的五层策略。
   */
  isolation?: Isolation;
  /**
   * 非致命问题的一行说明（目前只有 seedHome 里单个文件没带过来）。
   * 建实例不因此失败；CLI 把它写到 stderr，--json 时不打。
   */
  onWarn?: (line: string) => void;
}

/** 从已有 home 带过来时不搬的东西：会话、缓存、附件、运行时、库文件、profile（带绝对路径）。 */
const SEED_SKIP = new Set(['sessions', 'cache', 'attachments', 'dsh-runtimes', 'storages', 'profiles', 'logs']);

/**
 * 单个 fs 操作失败的原因文字：优先 code/syscall（不带路径），
 * 退回错误消息时把绝对路径截成 …，警告行只回显相对路径，不暴露宿主目录结构。
 */
export function fsProblem(err: unknown): string {
  const e = err as NodeJS.ErrnoException | undefined;
  const head = [
    typeof e?.code === 'string' ? e.code : '',
    typeof e?.syscall === 'string' ? e.syscall : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (head) return head;
  const message = typeof e?.message === 'string' && e.message ? e.message : String(err);
  return message.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s'"]+/g, '…') || '未知原因';
}

/**
 * 把已有 home 里的凭据/指令补进实例 home：只补空缺，已存在的路径一律不动。
 * 先装 Pack 再 seed，所以 Pack 写好的 AGENTS.md、skills 不会被全局那份盖掉。
 * 单个文件搬不过来不阻断建实例，但要收集起来经 onProblem 报告：不然用户只看到「凭据没生效」。
 * 返回顶层条目名（沿用原有语义）。
 */
export function seedHome(from: string, to: string, onProblem?: (line: string) => void): string[] {
  const source = resolve(from);
  if (!existsSync(source)) {
    throw new PalError('not-found', '要导入凭据的 home 目录不存在', {
      hint: '检查 --seed-from 指向的目录；不需要导入就删掉这个参数',
      details: { home: source },
    });
  }
  const copied: string[] = [];
  const problems: string[] = [];
  const walk = (src: string, dest: string): void => {
    const stat = statSync(src);
    if (stat.isDirectory()) {
      if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
      for (const entry of readdirSync(src, { withFileTypes: true })) {
        if (SEED_SKIP.has(entry.name)) continue;
        walk(join(src, entry.name), join(dest, entry.name));
      }
      return;
    }
    if (existsSync(dest)) return;
    try {
      cpSync(src, dest, { force: false, errorOnExist: false });
    } catch (err) {
      // 单个文件搬不过来不影响建实例，但要让人看到少了哪个文件、为什么
      // 相对路径统一用 /，和 update 的 removedFiles 写法一致
      problems.push(`没带过来：${relative(to, dest).split(sep).join('/')}（${fsProblem(err)}）`);
    }
  };
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (SEED_SKIP.has(entry.name)) continue;
    const before = existsSync(join(to, entry.name));
    walk(join(source, entry.name), join(to, entry.name));
    if (!before || entry.isDirectory()) copied.push(entry.name);
  }
  if (onProblem) for (const line of problems) onProblem(line);
  return copied;
}

/**
 * `--from-home`：按宿主注册表里的 `credentialFiles`（相对 home）把凭据从已有 home 复制进新 home。
 *
 * 只复制清单里登记的文件，不搬整个目录：managed home 想要的只是「能登录」，不是把全局配置抄一份。
 * 源文件不存在跳过并提示（新 home 照样建好）；目标已存在时保留现有文件（Pack 写的内容优先）。
 * 返回复制 / 跳过 / 存在的相对路径；`empty` 表示宿主没登记凭据文件（复制 0 个）。
 */
export interface CredentialCopyResult {
  copied: string[];
  missing: string[];
  kept: string[];
  empty: boolean;
}

export function copyCredentialsFromHome(
  fromHome: string,
  home: string,
  kind: InstanceKind,
  onNote?: (line: string) => void,
): CredentialCopyResult {
  const source = resolve(fromHome);
  const files = (adapterFor(kind)?.credentialFiles ?? []).map((file) =>
    file.replace(/\\/g, '/').replace(/^\.?\//, ''),
  );
  const result: CredentialCopyResult = { copied: [], missing: [], kept: [], empty: files.length === 0 };
  if (files.length === 0) {
    onNote?.('宿主没有登记凭据文件（credentialFiles 为空），--from-home 没有复制任何东西');
    return result;
  }
  for (const rel of files) {
    const src = join(source, rel);
    const dest = join(home, rel);
    if (!existsSync(src)) {
      result.missing.push(rel);
      onNote?.(`--from-home 跳过 ${rel}（源不存在）`);
      continue;
    }
    if (existsSync(dest)) {
      result.kept.push(rel);
      onNote?.(`--from-home 保留现有文件：${rel}`);
      continue;
    }
    try {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { force: false, errorOnExist: false });
      result.copied.push(rel);
      onNote?.(`--from-home 复制凭据：${rel}`);
    } catch (err) {
      // 单个凭据复制失败不阻断建 home：实例照样可用，只是这个宿主得自己登录
      onNote?.(`--from-home 没复制 ${rel}（${fsProblem(err)}）`);
    }
  }
  return result;
}

/**
 * 一份新实例该用哪套隔离策略：显式给的最优先（照样过一遍 parseIsolation），
 * 没给就用全局配置里的默认。配置坏/策略坏/策略还没实现都在建目录之前抛，不留半份实例。
 */
function isolationFor(explicit: Isolation | undefined): Isolation {
  if (explicit === undefined) {
    const configured = readPalConfig().isolation;
    assertIsolationSupported(configured);
    return configured;
  }
  const parsed = parseIsolation(explicit);
  if (!parsed) {
    throw new PalError('invalid-input', '隔离策略不合法：五层必须齐全，每层只能是 instance / shared', {
      hint: '可选层：assembly / session / credentials / cache / runtime；可选模式：instance / shared',
      details: { isolation: explicit },
    });
  }
  assertIsolationSupported(parsed);
  return parsed;
}

/**
 * 记录里的 Pack 身份只从 state 派生：state 是安装事实，记录只是它的视图。
 * 恰好一个 Pack 时用它的 name/version（旧 state 没写 version 就借 fallback 或 0.0.0）；
 * 0 个 / 多个 Pack、state 读不出来（损坏或还没写）时返回 fallback —— 记录不替 state 编身份。
 * adopt 用它把「多 Pack 就是 external」的规则收在一处。
 */
export function packIdentityFromState(
  root: string,
  fallback: { name: string; version: string },
): { name: string; version: string } {
  const fb = { name: fallback.name, version: fallback.version || '0.0.0' };
  let entries: ReturnType<typeof loadState>['packs'][string][];
  try {
    entries = Object.values(loadState(root).packs);
  } catch {
    // state 损坏：读不了就当没有身份可用，由调用方决定 fallback 是什么
    return fb;
  }
  if (entries.length !== 1) return fb;
  const only = entries[0]!;
  return { name: only.pack ?? fb.name, version: only.version ?? fb.version };
}

/* ---------- 创建 ---------- */

/**
 * 一份 home 的计划：managed 用实例根里的 home 段，attached 用宿主已验证的全局落点。
 * 落点由宿主模块的 `destination` 回答，PAL 只把范围（scope / root / home）交给 kernel。
 * 传 `attachedHome` 时以那个目录为根（范围是 attached，落点相对它）。
 */
export function planForHome(
  ctx: PackContext,
  kind: InstanceKind,
  opts: { root?: string; attachedHome?: string; profile?: string } = {},
) {
  // dir 是项目目录实例，不是 kernel 的宿主：映射成「不传 harness」（平铺到实例根）。
  // 类型写 Partial<PlanOptions>：键写错（例如旧的 targetVars）会在这里编译报错，而不是被静默忽略。
  const scope = destinationContext(kind, opts);
  const planOptions: Partial<PlanOptions> = {
    ...(kind === 'dir' ? {} : { harness: kind }),
    ...(scope
      ? {
          scope: scope.scope,
          root: scope.root,
          ...(scope.home ? { home: scope.home } : {}),
        }
      : {}),
    ...(opts.profile ? { profile: opts.profile } : {}),
  };
  return planFor(ctx, planOptions);
}

/** 读 Pack 目录并算出 ctx；清单/锁有问题一律用法错，写盘前就失败。 */
function contextOf(packDirRaw: string): { ctx: PackContext; packDir: string } {
  const packDir = resolve(packDirRaw);
  const loaded = loadPack(packDir);
  if (!loaded.manifest) {
    const detail = loaded.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ');
    throw new PalError('invalid-input', `清单有问题${detail ? `：${detail}` : ''}`, {
      hint: `确认 Pack 目录里有 ${MANIFEST_FILE}，且清单能被解析`,
      details: { packDir },
    });
  }
  const read = loadLock(packDir);
  if (read.problem) throw new PalError('invalid-input', read.problem.message);
  const ctx: PackContext = withLockPins(loaded, read.lock);
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new PalError('invalid-input', `清单有问题：${errors.map((i) => i.message).join('; ')}`);
  }
  return { ctx, packDir };
}

/**
 * 只算计划、不落盘：install --dry-run 用。
 * attached 仍要先过「宿主支持 attached」这一关，别让人以为写不出计划就能装。
 */
export function previewHomePlan(opts: {
  packDir: string;
  harness: InstanceKind;
  attachedHome?: string;
  profile?: string;
}): Plan {
  const kind = assertHarness(opts.harness);
  if (opts.attachedHome !== undefined) {
    if (kind === 'dir') {
      throw new PalError('invalid-input', 'dir 不是宿主，不能作为 attached home');
    }
    assertAttachedSupported(kind);
  }
  const profile = opts.profile === undefined ? undefined : assertProfileName(opts.profile);
  if (profile !== undefined) assertProfileTarget(kind, opts.attachedHome !== undefined);
  const { ctx } = contextOf(opts.packDir);
  const { plan, issues } = planForHome(
    ctx,
    kind,
    opts.attachedHome === undefined
      ? {}
      : { attachedHome: opts.attachedHome, ...(profile ? { profile } : {}) },
  );
  if (!plan) {
    throw new PalError('invalid-input', `生成不了计划：${issues.map((i) => i.message).join('; ')}`);
  }
  return plan;
}

/**
 * 从一个 Pack 目录创建 home：managed 建在 PAL 实例根下，attached 装进给定的宿主全局目录。
 * 失败时只清理我们自己造的根：先把现场移到 .failed，绝不 rm 一个已存在的目录。
 */
export async function createInstance(opts: CreateInstanceOptions): Promise<InstanceRecord> {
  const name = opts.name.trim();
  if (!name) throw new PalError('invalid-input', '实例名不能为空');
  const kind = assertHarness(opts.harness);
  // attached home 只对已验证全局布局的宿主开放；dir 不是宿主
  const attachedHome =
    opts.attachedHome === undefined ? undefined : assertAbsolutePath(opts.attachedHome, 'attached home', 'home');
  if (attachedHome !== undefined) {
    if (kind === 'dir') {
      throw new PalError('invalid-input', 'dir 不是宿主，不能作为 attached home');
    }
    assertAttachedSupported(kind);
  }
  // --profile 只对 dsh 的 attached home 有意义；名字先过安全边界（它会拼进落点路径）
  const profile = opts.profile === undefined ? undefined : assertProfileName(opts.profile);
  if (profile !== undefined) assertProfileTarget(kind, attachedHome !== undefined);
  // --from-home 只用于 managed：attached 的 home 就是宿主的全局目录，凭据本来就在那儿
  let fromHome: string | undefined;
  if (opts.fromHome !== undefined) {
    if (attachedHome !== undefined) {
      throw new PalError('invalid-input', '--from-home 只能配 managed home', {
        hint: 'attached home 直接就是宿主的全局目录，凭据本来就在那里，不需要 --from-home',
      });
    }
    fromHome = homePathInput(opts.fromHome, '--from-home 的目录');
    if (!existsSync(fromHome)) {
      throw new PalError('invalid-input', '--from-home 指向的目录不存在', {
        hint: '检查路径；不需要沿用凭据就删掉 --from-home',
        details: { fromHome },
      });
    }
  }
  assertNameFree(name);
  // 先定策略：配置读不了就在这里失败，不往下建目录
  const isolation = isolationFor(opts.isolation);

  const id = newId();
  // managed：默认根由系统分配（PAL 数据目录）；attached：根就是宿主的全局目录。
  // 显式给的 managed 根只用于外部目录，先过校验再落盘任何东西。
  const root =
    attachedHome ?? (opts.root === undefined ? join(instancesRoot(), id) : assertExternalRoot(opts.root));
  const existed = existsSync(root);
  if (existsSync(recordFile(root))) {
    throw new PalError('root-occupied', attachedHome !== undefined ? '这个目录已经是一份 home' : '这个目录已经是一份实例', {
      hint: '换个目录，或从列表里操作它',
      details: { root },
    });
  }

  const { ctx, packDir } = contextOf(opts.packDir);
  const { plan, issues } = planForHome(
    ctx,
    kind,
    attachedHome === undefined
      ? { root }
      : { attachedHome, ...(profile ? { profile } : {}) },
  );
  if (!plan) {
    throw new PalError('invalid-input', `生成不了计划：${issues.map((i) => i.message).join('; ')}`);
  }

  const adapter = requireAdapter(kind);
  // attached 的 home 就是那个目录本身（宿主本来就把它当全局位置读）；managed 落在实例根的 home 段。
  const home = attachedHome ?? (adapter.homeDir ? join(root, adapter.homeDir) : undefined);
  mkdirSync(root, { recursive: true });
  if (home && home !== root) mkdirSync(home, { recursive: true });

  const attached = attachedHome !== undefined;
  const draft: InstanceRecord = {
    apiVersion: API_VERSION,
    id,
    name,
    harness: kind,
    ...(opts.harnessVersion ? { harnessVersion: opts.harnessVersion } : {}),
    root,
    ...(home ? { home } : {}),
    ...(attached ? { attached: true } : {}),
    // 只有显式选了 profile 才写；缺省不写 = all（每次安装枚举当时已有的所有 profile）
    ...(profile ? { profile } : {}),
    isolation,
    pack: {
      name: ctx.manifest.metadata.name,
      version: ctx.manifest.metadata.version,
      ...(opts.packRef ? { ref: opts.packRef } : {}),
    },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'installing',
    // attached 的根是宿主的目录，不归 PAL 整根删；managed 才是 PAL 建的
    managed: !attached,
    origin: { kind: 'pack', ...(opts.packRef ? { ref: opts.packRef } : {}), dir: packDir },
    ports: [],
    restart: 'never',
    maxRestarts: 3,
  };
  // 先落 installing：中途崩溃时列表里能看到它，能删能查，不是凭空消失
  writeInstance(draft);

  try {
    await withInstanceLock(root, 'create', async () => {
      const result = await installPack(ctx, plan, {
        root,
        packRoot: packDir,
        ...(home ? { home } : {}),
      });
      const failed = result.outcomes.filter((o) => o.status === 'failed');
      if (failed.length > 0) {
        throw new PalError(
          'install-failed',
          `安装未完成：${failed
            .map((o) => `${o.actionId}=${o.status}${o.message ? `（${o.message}）` : ''}`)
            .join(', ')}`,
          { details: { outcomes: failed } },
        );
      }
      // 身份只认 state：安装完恰好一个 Pack 时它就是这份实例的 Pack；
      // 读不出来（0/多个/state 损坏）才用清单里的名字版本兜底，ref 仍记原始引用。
      draft.pack = {
        ...packIdentityFromState(root, {
          name: ctx.manifest.metadata.name,
          version: ctx.manifest.metadata.version,
        }),
        ...(opts.packRef ? { ref: opts.packRef } : {}),
      };
      writeBaseline(root, {
        pack: draft.pack.name,
        version: draft.pack.version,
        harness: kind,
        planHash: plan.planHash,
        files: baselineFromState(root),
      });
      if (fromHome !== undefined) {
        // 先装 Pack 再带凭据：凭据不覆盖 Pack 写好的文件
        if (home === undefined) {
          opts.onWarn?.('这个形态没有 home 段，--from-home 没有复制任何东西');
        } else {
          copyCredentialsFromHome(fromHome, home, kind, opts.onWarn);
        }
      }
      if (opts.seedFrom && home) {
        // 先装 Pack，再补凭据：Pack 写好的文件不被覆盖
        seedHome(opts.seedFrom, home, opts.onWarn);
        draft.origin = { ...(draft.origin ?? { kind: 'pack' }), seededFrom: resolve(opts.seedFrom) };
      }
      writeInstance({ ...draft, status: 'installed' });
    });
  } catch (err) {
    const reason =
      err instanceof PalError
        ? { code: err.code, message: err.message }
        : { code: 'install-failed', message: (err as Error).message };
    const record = readRecord(root);
    if (record) writeInstance({ ...record, status: 'failed', lastError: { ...reason, at: nowIso() } });
    if (existed) {
      // 复用已有目录：只把 PAL 的记录（配置 + 运行态）摘掉，目录本身和里面的东西一概不动
      try {
        rmSync(recordFile(root), { force: true });
        rmSync(runtimeFile(root), { force: true });
      } catch {
        /* 摘不掉就留着 failed 记录，至少能查能删 */
      }
    } else {
      failInstance(root, reason);
    }
    // 外部根（attached）的 .links 指针也要摘掉：记录都没了，指针只会变成坏记录
    removeLink(id);
    dropActive(id);
    throw err;
  }

  const record = readRecord(root)!;
  if (opts.activate !== false) {
    const map = readActiveMap();
    map[kind] = record.id;
    writeActiveMap(map);
  }
  return record;
}

/* ---------- 装进已有实例（安装 target = 实例） ---------- */

export interface InstallIntoInstanceOptions {
  /** 已经落到本地的 Pack 目录 */
  packDir: string;
  /** 原始 Pack 引用（写进记录，供 update 复用） */
  packRef?: string;
  /** dsh attached home 的 profile；不写 = all（与 install 的缺省一致，不沿用旧记录） */
  profile?: string;
  overwrite?: boolean;
  allowExec?: boolean;
  dryRun?: boolean;
}

export interface InstallIntoInstanceResult {
  record: InstanceRecord;
  plan: Plan;
  outcomes: ActionOutcome[];
  dryRun: boolean;
}

/**
 * 往一个「空实例」里装 Pack：实例必须已停、state 里还没有包（有包走 update）。
 * 落点由实例记录的 harness（含 dir）决定，与 create 装配同一套范围。
 */
export async function installIntoInstance(
  idOrName: string,
  opts: InstallIntoInstanceOptions,
): Promise<InstallIntoInstanceResult> {
  const record = requireInstance(idOrName);
  if (record.pid && isPidAlive(record.pid)) {
    throw new PalError('invalid-input', `实例还在运行，先停掉再装：pid ${record.pid}`, {
      hint: `pal stop ${record.id}`,
    });
  }
  const state = loadState(record.root);
  const installed = Object.keys(state.packs);
  if (installed.length > 0) {
    throw new PalError('invalid-input', `实例里已经有包：${installed.join(', ')}`, {
      hint: `换版本用 pal update --home ${record.name}；要重装先 pal uninstall --home ${record.name}。`,
    });
  }

  const { ctx, packDir } = contextOf(opts.packDir);
  const kind = record.harness;
  const profile = opts.profile === undefined ? undefined : assertProfileName(opts.profile);
  if (profile !== undefined) assertProfileTarget(kind, record.attached === true);
  // attached 记录装回它自己的全局目录；managed 用实例根里的 home 段
  const { plan, issues } = planForHome(
    ctx,
    kind,
    record.attached === true
      ? { attachedHome: record.root, ...(profile ? { profile } : {}) }
      : { root: record.root },
  );
  if (!plan) {
    throw new PalError('invalid-input', `生成不了计划：${issues.map((i) => i.message).join('; ')}`);
  }

  const dryRun = opts.dryRun === true;
  const adapter = requireAdapter(kind);
  // attached 的 home 就是记录根；managed 是根里的 home 段。base: home / absolute 的落点按它解析。
  const home =
    record.home ??
    (record.attached === true
      ? record.root
      : adapter.homeDir
        ? join(record.root, adapter.homeDir)
        : undefined);
  let outcomes: ActionOutcome[] = [];
  await withInstanceLock(record.root, 'install', async () => {
    const result = await installPack(ctx, plan, {
      root: record.root,
      packRoot: packDir,
      ...(home ? { home } : {}),
      dryRun,
      ...(opts.overwrite ? { overwrite: true } : {}),
      ...(opts.allowExec ? { allowExec: true } : {}),
    });
    outcomes = result.outcomes;
    const failed = outcomes.filter((o) => o.status === 'failed');
    if (failed.length > 0) {
      throw new PalError(
        'install-failed',
        `安装未完成：${failed
          .map((o) => `${o.actionId}=${o.status}${o.message ? `（${o.message}）` : ''}`)
          .join(', ')}`,
        { details: { outcomes: failed } },
      );
    }
  });

  if (dryRun) return { record, plan, outcomes, dryRun: true };

  const pack = {
    ...packIdentityFromState(record.root, {
      name: ctx.manifest.metadata.name,
      version: ctx.manifest.metadata.version,
    }),
    ...(opts.packRef ? { ref: opts.packRef } : {}),
  };
  writeBaseline(record.root, {
    pack: pack.name,
    version: pack.version,
    harness: kind,
    planHash: plan.planHash,
    files: baselineFromState(record.root),
  });
  const next: InstanceRecord = {
    ...record,
    pack,
    // 接管来的空目录可能没记 home；装完补上，start 才知道该指哪个 home。
    // attached 的 home 就是记录根；managed 是根里的 home 段。
    ...(record.home === undefined && home ? { home } : {}),
    status: 'installed',
    updatedAt: nowIso(),
    origin: {
      ...(record.origin ?? {}),
      kind: 'pack',
      ...(opts.packRef ? { ref: opts.packRef } : {}),
      dir: packDir,
    },
  };
  delete next.lastError;
  // 显式给了 --profile 就记下来；没给 = all，旧记录的 profile 不沿用（install 的缺省语义是 all）
  if (profile) next.profile = profile;
  else delete next.profile;
  writeInstance(next);
  return { record: next, plan, outcomes, dryRun: false };
}

/* ---------- 接管 ---------- */
export interface AdoptOptions {
  dir: string;
  name: string;
  /** 实例形态：dir 是内部项目目录形态，其余是宿主名 */
  harness: InstanceKind;
  /** 接管后是否设为当前实例 */
  activate?: boolean;
}

/**
 * 把已有目录登记成 attached home：只写记录，不装包、不动目录里的文件。
 * attached=true 且 managed=false：目录归宿主，PAL 不挪、不删、不整根备份；卸包走 uninstall --home。
 * 宿主名必须是支持 attached 布局的那几个（dir 形态只在包内 API 里用）。
 */
export function adoptInstance(opts: AdoptOptions): InstanceRecord {
  const dir = resolve(opts.dir);
  if (!existsSync(dir)) {
    throw new PalError('not-found', '这个目录不存在', {
      hint: '确认目录还在；接管不会替你创建它',
      details: { dir },
    });
  }
  const kind = assertHarness(opts.harness);
  if (kind !== 'dir') assertAttachedSupported(kind);
  const name = opts.name.trim();
  if (!name) throw new PalError('invalid-input', '接管的 home 要一个名字');
  assertNameFree(name);
  // 接管来的目录不动，但记录里的默认策略跟新建实例一样看全局配置；
  // 配置里写了还没实现的语义（凭据 shared）同样在写记录之前拒绝。
  const isolation = readPalConfig().isolation;
  assertIsolationSupported(isolation);
  if (existsSync(recordFile(dir))) {
    throw new PalError('root-occupied', '这个目录已经是一份 home', {
      hint: '换个目录，或先删掉它的旧记录',
      details: { dir },
    });
  }
  // 接管来的目录就是宿主的全局 home，记录里的 home 也是它自己（dir 没有 home 段）。
  const home = kind === 'dir' ? undefined : dir;
  // 身份同样从 state 派生；没有 state / state 里不止一个 Pack 时记 external：
  // 多个 Pack 里「第一个」只是对象顺序，拿来当身份会让记录撒谎，updateInstance 也会把别的 Pack 当成同一个。
  const pack = packIdentityFromState(dir, { name: 'external', version: '0.0.0' });
  const record: InstanceRecord = {
    apiVersion: API_VERSION,
    id: newId(),
    name,
    harness: kind,
    root: dir,
    ...(home ? { home } : {}),
    attached: true,
    isolation,
    pack,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'installed',
    managed: false,
    origin: { kind: 'adopted', dir },
    ports: [],
    restart: 'never',
    maxRestarts: 3,
  };
  writeInstance(record);
  if (opts.activate !== false) {
    const map = readActiveMap();
    map[kind] = record.id;
    writeActiveMap(map);
  }
  return record;
}
