import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import * as tar from 'tar';
import type {
  HarnessId,
  OwnedPath,
  PathBase,
  Plan,
  PlanAction,
  PlanShape,
  PlanSnapshot,
} from '@packhub/kernel';
import {
  actionFromBase,
  actionIsShared,
  actionOutputs,
  actionRetainWarning,
  actionToBase,
  actionUndo,
  actionUndoPayload,
  actionWrittenOwned,
  canonicalize,
  CODEX_SKILL_YAML,
  deepMerge,
  diffActions,
  isPlainObject,
  ownedKey,
  planOutputsOf,
  planPathsOf,
  sha256,
  STATE_DIR,
  STATE_FILE,
} from '@packhub/kernel';
import { download, resolvePypiSdist } from './download.ts';
import { isSafeArchiveEntry } from './pack.ts';
import { generateOpenaiYaml, readSkillFrontmatter } from './skill-meta.ts';
import { resolveToken } from './credentials.ts';
import { assertApiVersion } from './apiVersion.ts';
import { removeClaudeMcp } from './host-mcp.ts';
import { resolveWithin } from './pathSafety.ts';

export interface ApplyOptions {
  /** 目标目录：写到哪里、state 放哪里 */
  root: string;
  /**
   * 宿主 home 段（绝对路径）：`base: 'absolute' | 'home'` 的落点按它解析。
   * managed 是 `<root>/home/<宿主>`，attached 就是 root 本身；项目 / 平铺没有 home。
   * 没给却遇到 home 基准的动作时明确报错，不猜一个目录。
   */
  home?: string;
  /** Pack 来源目录：`from`（Pack 基准）读哪里；默认与 root 相同 */
  packRoot?: string;
  /** 允许执行安装期命令（默认拒绝） */
  allowExec?: boolean;
  /** 只计算不落盘 */
  dryRun?: boolean;
  /** 允许覆盖别的包已经写过的普通文件（默认拒绝） */
  overwrite?: boolean;
  /**
   * 执行期平台（`platform-arch`），默认宿主机。平台裁剪只看这里，
   * 测试可以注入别的平台来验证「保留动作、执行期 skipped」。
   */
  platform?: string;
}

export type ActionStatus = 'done' | 'noop' | 'failed' | 'skipped' | 'needs-approval';

export interface ActionOutcome {
  actionId: string;
  op: PlanAction['op'];
  status: ActionStatus;
  message?: string;
  target?: string;
  /** instruction 动作用的块标识，卸载时据此只摘自己的块 */
  blockId?: string;
  /** register.mcp 用了哪个资源 id，卸载时据此摘掉对应 server 条目 */
  resource?: string;
}

export interface ApplyResult {
  outcomes: ActionOutcome[];
  statePath: string;
  /** 有动作失败并已按快照回滚：磁盘回到装之前，没有写入 state */
  rolledBack?: boolean;
}

interface State {
  apiVersion: typeof STATE_API_VERSION;
  /** 每次安装一个 generation，用于退回 */
  generations?: Generation[];
  packs: Record<
    string,
    {
      pack: string;
      version: string;
      planHash: string;
      installedAt: string;
      actions: ActionOutcome[];
      /**
       * 这个包拥有的路径及基准。旧 state 里是 `string[]`（按 root 解释），
       * `loadState` 读的时候归一成新形状，但不会为了读而重写文件。
       */
      written: OwnedPath[];
      /** 安装时的宿主 home 段（绝对路径）：install / 卸载 / 漂移检查解析 home 基准用 */
      home?: string;
      /** 持久状态目录：记下来供卸载与漂移检查使用；不放进 written，卸载默认不删 */
      stateDirs?: { id: string; path: string; retain: 'keep' | 'remove' }[];
      /** 由宿主 CLI 管理的全局 MCP（目前是 Claude Code user scope）；卸载时按名字摘掉 */
      hostMcp?: string[];
      /** 上一份计划快照，update 靠它算差异；旧 state 里存的是完整 Plan，是它的超集 */
      plan?: PlanSnapshot;
    }
  >;
}

/**
 * state.json 的格式版本：写方（applyPlan / saveState）与读方（loadState、`pal scan`）
 * 共用这一个常量，不再各写字面量。
 */
export const STATE_API_VERSION = 'packhub.dev/state/v0';

/** active.json 的格式版本：写方（setActive）与读方（readActive）共用这一个常量。 */
const ACTIVE_API_VERSION = 'packhub.dev/active/v0';

/**
 * 版本记录 record.json 的格式版本：写方（stageVersion）与读方（readVersionRecord）共用这一个常量。
 */
const VERSION_API_VERSION = 'packhub.dev/version/v0';

/**
 * 一个已装版本的落盘记录：文件内容镜像 + 可重放的共享改动。
 *
 * 每次成功安装都会写一份，按 Pack 保留最近几份；切版本靠重新 install 那个版本，
 * 读端只剩 readVersionRecord（记录本身仍是「这次装了什么」的完整快照）。
 */
export interface VersionRecord {
  apiVersion: typeof VERSION_API_VERSION;
  pack: string;
  version: string;
  /**
   * 装到哪个宿主；平铺目录时为 undefined。
   *
   * v0 没有兼容承诺：更早的 record.json 里这个位置是 `target`（含 `dir`）。读端不认它，
   * 一律当平铺目录；装过宿主的旧版本想保留投影只能重装。
   */
  harness?: HarnessId;
  planHash: string;
  installedAt: string;
  /** 计划里的 merge/config 片段已经内联，换版本时不再依赖 Pack 目录 */
  plan: Plan;
  actions: ActionOutcome[];
  /** 这个版本拥有的路径（含共享配置与指令文件） */
  written: string[];
  /** 镜像在 files/ 下的路径（write / unpack / link.skill 的产物） */
  files: string[];
}

interface ActiveFile {
  apiVersion: typeof ACTIVE_API_VERSION;
  /** 与 VersionRecord.harness 同义；旧 active.json 里的 `target` 读端同样当平铺 */
  packs: Record<string, { version: string; harness?: HarnessId; planHash: string; at: string }>;
}

const INSTALL_LOCK = `${STATE_DIR}/installing.lock`;
const VERSIONS_DIR = `${STATE_DIR}/versions`;
const ACTIVE_FILE = `${STATE_DIR}/active.json`;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 说明进程在、只是无权发信号；只有 ESRCH 才能确认它没了
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 同一目录同时只允许一个安装：O_EXCL 创建锁文件，天然原子。 */
function acquireLock(root: string): () => void {
  const file = join(root, INSTALL_LOCK);
  mkdirSync(dirname(file), { recursive: true });
  const take = (): (() => void) => {
    const fd = openSync(file, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return () => {
      try {
        unlinkSync(file);
      } catch {
        /* 已释放 */
      }
    };
  };
  try {
    return take();
  } catch {
    let holder = '未知';
    try {
      holder = readFileSync(file, 'utf8').trim();
    } catch {
      /* 读不到就用未知 */
    }
    const pid = Number(holder);
    // 崩溃留下的锁：pid 已经不在了就自动收回，不再让人手工删文件
    if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) {
      try {
        unlinkSync(file);
        return take();
      } catch {
        /* 竞争失败，走下面的报错 */
      }
    }
    throw new Error(
      `另一个安装正在进行（${INSTALL_LOCK}，pid=${holder}）；确认没有进程在跑后删掉该文件重试`,
    );
  }
}

/** 一次安装 = 一个 generation；退回就是拿它的快照覆盖回去。 */
interface Generation {
  id: string;
  at: string;
  pack: string;
  planHash: string;
  /** 装之前就存在、被改写的文件（回了要把原内容放回去）；相对安装根 */
  existed: string[];
  /** 装之前不存在、这次新建的（回了要删掉）；相对安装根 */
  created: string[];
  /**
   * 安装根之外的绝对路径（base: absolute，或 home 段在根外）：旧 generation 没有这两个字段。
   * 这些路径同样先快照再写，rollback 原样放回 / 删掉。
   */
  existedExternal?: string[];
  createdExternal?: string[];
}

function generationId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  // 毫秒 + 4 位随机后缀：同一秒内装两个包不会再撞进同一个快照目录
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${ms}-${rand}`;
}

/** 本机平台标识；执行器只从这里取默认值，注入优先。 */
function hostPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

function platformOf(opts: ApplyOptions): string {
  return opts.platform ?? hostPlatform();
}

/**
 * 一份计划会写到安装根的路径（相对路径，含目录）。
 *
 * 这是「计划产物」的旧口径：只给路径字符串，按 root 解释。带 `home` / `absolute` 基准的
 * 产物用 `planOutputs`（快照、所有权、卸载都按它），不要把两者混用。
 */
export function planPaths(plan: PlanShape): string[] {
  return planPathsOf(plan);
}

/** 一份计划的产物（路径 + 基准）：快照、版本镜像、所有权、升级清理共用。 */
export function planOutputs(plan: PlanShape): OwnedPath[] {
  return planOutputsOf(plan);
}

/**
 * 按基准把一条受管路径解析成绝对路径。
 * - root → 安装根内（越界报错，沿用 `resolveWithin` 的限制）；
 * - home → 宿主 home 段内（没有 home 直接报错，不猜）；
 * - absolute → 原样解析，但仍要求是绝对路径。
 */
export function resolveOwnedPath(root: string, home: string | undefined, item: OwnedPath): string {
  if (item.base === 'root') return resolveWithin(root, item.path);
  if (item.base === 'home') {
    if (!home) {
      throw new Error(`路径 ${item.path} 以 home 为基准，但这次操作没有宿主 home 段（state 里也没有记录）`);
    }
    return resolveWithin(home, item.path);
  }
  if (!isAbsolute(item.path)) {
    throw new Error(`绝对基准的路径不是绝对路径：${item.path}`);
  }
  return resolve(item.path);
}

/**
 * 绝对路径 → 给人看的标签：在安装根内就给相对 root 的路径（旧行为），否则给绝对路径。
 * 统一用 `/`，保证计划 / state / 输出里看不到平台分隔符。
 */
export function ownedLabel(root: string, abs: string): string {
  const base = resolve(root);
  const rel = relative(base, abs);
  if (rel === '') return '.';
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel.replaceAll('\\', '/');
  return abs.replaceAll('\\', '/');
}

/** 一条受管路径的展示标签（解析后按 `ownedLabel` 折叠回安装根内）。 */
export function ownedPathLabel(root: string, home: string | undefined, item: OwnedPath): string {
  return ownedLabel(root, resolveOwnedPath(root, home, item));
}

/** 旧 state 的 `written` 是 `string[]`（按 root 解释）：读的时候归一成带基准的形状。 */
function normalizeWritten(value: unknown): OwnedPath[] {
  if (!Array.isArray(value)) return [];
  const out: OwnedPath[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      out.push({ path: entry, base: 'root' });
      continue;
    }
    if (isPlainObject(entry) && typeof (entry as { path?: unknown }).path === 'string') {
      const raw = entry as { path: string; base?: unknown };
      const base: PathBase = raw.base === 'home' || raw.base === 'absolute' ? raw.base : 'root';
      out.push({ path: raw.path, base });
    }
  }
  return out;
}

/** 同一物理落点只留一条：base 不同但解析结果相同的路径不重复记。 */
function dedupeOwned(root: string, home: string | undefined, items: readonly OwnedPath[]): OwnedPath[] {
  const seen = new Set<string>();
  const out: OwnedPath[] = [];
  for (const item of items) {
    const key = resolveOwnedPath(root, home, item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * 计划里语义共享的产物路径：只有 `register.mcp`（按 key 合并）与 `instruction`
 * （托管块各写各的）算共享，其余动作的产物都是本包私有。
 *
 * 版本镜像、所有权冲突、升级清理都按这张集合判，不看文件扩展名或目录层级：
 * `.json` 既可能是别人的配置，也可能是本包自己的数据文件，路径本身说明不了共享性。
 */
function semanticSharedPaths(plan: PlanShape): Set<string> {
  const out = new Set<string>();
  for (const action of plan.actions) {
    if (!actionIsShared(action)) continue;
    for (const item of actionOutputs(action, plan)) out.add(ownedKey(item));
  }
  return out;
}

/**
 * state 里存的是计划快照：harness/planHash/actions/verify/excluded，够 diff、够算路径。
 *
 * 平铺目录时快照里没有 `harness`。更早的快照存的是 `target`：v0 无兼容承诺，读端不认，
 * 一律当平铺目录（旧宿主安装要重装）；这里只按新形状写。
 */
export function planSnapshot(plan: Plan): PlanSnapshot {
  return {
    ...(plan.harness ? { harness: plan.harness } : {}),
    planHash: plan.planHash,
    actions: plan.actions,
    verify: plan.verify,
    excluded: plan.excluded,
  };
}

/** `from` 的解析：按表里声明的基准读 Pack 目录或安装根，不再各 op 各猜。 */
function sourcePath(action: PlanAction, opts: ApplyOptions): string {
  const base = actionFromBase(action);
  if (base === 'none') throw new Error(`动作没有来源：${action.actionId}`);
  const raw = (action as { from?: string }).from;
  if (raw === undefined) throw new Error(`动作缺少 from：${action.actionId}`);
  if (base === 'pack') return resolveWithin(opts.packRoot ?? opts.root, raw);
  return resolveOwnedPath(opts.root, opts.home, { path: raw, base });
}

/** 计划声明的持久状态目录。 */
function stateDirSpecs(plan: Plan): { id: string; path: string; retain: 'keep' | 'remove' }[] {
  return plan.actions
    .filter((a) => a.op === 'state.dir')
    .map((a) => ({
      id: (a.resource ?? '').replace(/^state:/, ''),
      path: a.to,
      retain: a.retain,
    }));
}

/** 安装根之外的快照文件名：绝对路径压成稳定、无分隔符的名字。 */
function externalSnapshotName(abs: string): string {
  return sha256(abs).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) || 'file';
}

function prepareGeneration(root: string, plan: Plan, home: string | undefined): Generation {
  const id = generationId();
  const dir = join(root, STATE_DIR, 'snapshots', id);
  const existed: string[] = [];
  const created: string[] = [];
  const existedExternal: string[] = [];
  const createdExternal: string[] = [];
  for (const item of planOutputs(plan)) {
    const abs = resolveOwnedPath(root, home, item);
    const inside = ownedLabel(root, abs) !== abs.replaceAll('\\', '/');
    const label = inside ? ownedLabel(root, abs) : abs;
    if (existsSync(abs)) {
      const dest = inside
        ? join(dir, 'files', label)
        : join(dir, 'external', externalSnapshotName(abs));
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(abs, dest, { recursive: true, force: true });
      (inside ? existed : existedExternal).push(label);
    } else {
      (inside ? created : createdExternal).push(label);
    }
  }
  mkdirSync(dir, { recursive: true });
  const statePath = join(root, STATE_FILE);
  if (existsSync(statePath)) cpSync(statePath, join(dir, 'state.json'));
  const activePath = join(root, ACTIVE_FILE);
  if (existsSync(activePath)) cpSync(activePath, join(dir, 'active.json'));
  const gen: Generation = {
    id,
    at: new Date().toISOString(),
    pack: `${plan.pack.name}@${plan.pack.version}`,
    planHash: plan.planHash,
    existed,
    created,
    ...(existedExternal.length > 0 ? { existedExternal } : {}),
    ...(createdExternal.length > 0 ? { createdExternal } : {}),
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(gen, null, 2) + '\n', 'utf8');
  return gen;
}

export async function applyPlan(plan: Plan, opts: ApplyOptions): Promise<ApplyResult> {
  const release = opts.dryRun ? () => {} : acquireLock(opts.root);
  try {
  const outcomes: ActionOutcome[] = [];
  const written: OwnedPath[] = [];
  const key = `${plan.pack.name}@${plan.pack.version}`;

  // 项目级所有权：同一路径不许被两个包各写一份；只有两边都是语义共享产物才豁免
  const conflicts = findOwnershipConflicts(plan, key, opts.root, opts.home);
  if (conflicts.length > 0 && !opts.overwrite) {
    throw new Error(
      `这些路径已被别的包占用：${conflicts.join('、')}；确认要覆盖就加 --overwrite`,
    );
  }

  const gen = opts.dryRun ? undefined : prepareGeneration(opts.root, plan, opts.home);

  for (const action of plan.actions) {
    // 动作按计划里的顺序执行，且失败即 break：计划已经把「先 fetch 再 unpack」排进去了，
    // 不再有逐动作的依赖字段（资源级的旧依赖字段也已删除，顺序改由 needs 派生）。
    try {
      const outcome = await applyAction(action, plan, opts);
      outcomes.push(outcome);
      // 真正写了的路径才进 written；具体是哪些由 PLAN_OPS 表按动作与平台派生
      if (outcome.status === 'done') written.push(...actionWrittenOwned(action, plan, platformOf(opts)));
    } catch (err) {
      outcomes.push({
        actionId: action.actionId,
        op: action.op,
        status: 'failed',
        message: (err as Error).message,
      });
      break;
    }
  }

  const statePath = join(opts.root, STATE_FILE);
  // codex 的技能选择器要求 agents/openai.yaml：源里没有就补一份，不执行任何包内代码
  if (!opts.dryRun && plan.harness === 'codex' && !outcomes.some((o) => o.status === 'failed')) {
    try {
      ensureCodexSkillYaml(opts.root, plan, written, opts.home);
    } catch (err) {
      outcomes.push({
        actionId: 'codex-skill#1',
        op: 'write',
        status: 'failed',
        message: `openai.yaml 生成失败：${(err as Error).message}`,
      });
    }
  }
  const failed = outcomes.some((o) => o.status === 'failed');

  // 失败不留半套：按本次快照把文件放回去，不写 state，也不留 generation
  if (!opts.dryRun && failed && gen) {
    restoreGeneration(opts.root, gen);
    const snapDir = join(opts.root, STATE_DIR, 'snapshots');
    rmSync(join(snapDir, gen.id), { recursive: true, force: true });
    // 失败的 generation 不留下空壳目录
    if (existsSync(snapDir) && readdirSync(snapDir).length === 0) {
      rmSync(snapDir, { recursive: true, force: true });
    }
    return { outcomes, statePath, rolledBack: true };
  }

  if (!opts.dryRun && !failed) {
    // 把这次安装的产物镜像进版本目录：record.json 是「这一版装了什么」的完整快照，
    // 读端只有 readVersionRecord；回退仍然走 state 里的 generation 快照。
    try {
      stageVersion(opts.root, plan, outcomes, written, opts.home);
    } catch (err) {
      const dir = versionDirOf(opts.root, plan.pack.name, plan.pack.version);
      rmSync(dir, { recursive: true, force: true });
      if (gen) {
        restoreGeneration(opts.root, gen);
        const activeBackup = join(opts.root, STATE_DIR, 'snapshots', gen.id, 'active.json');
        if (existsSync(activeBackup)) cpSync(activeBackup, join(opts.root, ACTIVE_FILE));
      }
      outcomes.push({
        actionId: 'stage#1',
        op: 'write',
        status: 'failed',
        message: `版本目录写入失败：${(err as Error).message}`,
      });
      return { outcomes, statePath, rolledBack: true };
    }
  }

  if (!opts.dryRun && !failed) {
    const state = loadState(opts.root);
    state.apiVersion = STATE_API_VERSION;
    // 升级到新版本时把同名的旧记录并进来：written 取并集，旧 key 不留
    const oldKeys = Object.keys(state.packs).filter(
      (k) => k !== key && (k.split('@')[0] ?? '') === plan.pack.name,
    );
    // home 段跨版本沿用旧的：新计划没有 home 时不把记录里的 home 弄丢
    const home = opts.home ?? state.packs[key]?.home ?? oldKeys.map((k) => state.packs[k]?.home).find(Boolean);
    const previous = dedupeOwned(
      opts.root,
      home,
      [
        ...(state.packs[key]?.written ?? []),
        ...oldKeys.flatMap((k) => state.packs[k]?.written ?? []),
      ],
    );
    for (const k of oldKeys) delete state.packs[k];
    // 状态目录跨版本保留：新计划没再声明的旧目录也记着，卸载时仍按原 retain 处理
    const stateDirs = new Map<string, { id: string; path: string; retain: 'keep' | 'remove' }>();
    for (const k of [key, ...oldKeys]) {
      for (const spec of state.packs[k]?.stateDirs ?? []) stateDirs.set(spec.path, spec);
    }
    for (const spec of stateDirSpecs(plan)) stateDirs.set(spec.path, spec);
    state.packs[key] = {
      pack: plan.pack.name,
      version: plan.pack.version,
      planHash: plan.planHash,
      installedAt: new Date().toISOString(),
      actions: outcomes,
      // 记录「这个 Pack 拥有哪些文件」而不是「最后一次写了几个」：重复安装时后者会归零
      written: dedupeOwned(opts.root, home, [...previous, ...written]),
      ...(home ? { home } : {}),
      // 计划快照：update 靠它算出「多了什么、少了什么」
      plan: planSnapshot(plan),
      ...(stateDirs.size > 0 ? { stateDirs: [...stateDirs.values()] } : {}),
    };
    if (gen) {
      state.generations = [...(state.generations ?? []), gen].slice(-5);
      pruneSnapshots(opts.root, state.generations);
    }
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  }
  return { outcomes, statePath };
  } finally {
    release();
  }
}

function pruneSnapshots(root: string, keep: Generation[]): void {
  const base = join(root, STATE_DIR, 'snapshots');
  if (!existsSync(base)) return;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!keep.some((g) => g.id === entry.name)) {
      rmSync(join(base, entry.name), { recursive: true, force: true });
    }
  }
}

/* ---------- 版本目录与激活指针 ---------- */

function packSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function versionDirOf(root: string, pack: string, version: string): string {
  return join(root, VERSIONS_DIR, packSlug(pack), packSlug(version));
}

function readActive(root: string): ActiveFile {
  const file = join(root, ACTIVE_FILE);
  if (!existsSync(file)) return { apiVersion: ACTIVE_API_VERSION, packs: {} };
  let parsed: Partial<ActiveFile>;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ActiveFile>;
  } catch {
    return { apiVersion: ACTIVE_API_VERSION, packs: {} };
  }
  assertApiVersion(file, parsed, ACTIVE_API_VERSION);
  return { apiVersion: ACTIVE_API_VERSION, packs: parsed.packs ?? {} };
}

function writeActive(root: string, next: ActiveFile): void {
  const file = join(root, ACTIVE_FILE);
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(next, null, 2) + '\n');
}

function setActive(
  root: string,
  pack: string,
  version: string,
  planHash: string,
  harness: HarnessId | undefined,
): void {
  const active = readActive(root);
  active.packs[pack] = {
    version,
    ...(harness ? { harness } : {}),
    planHash,
    at: new Date().toISOString(),
  };
  writeActive(root, active);
}

function unsetActive(root: string, pack: string): void {
  const active = readActive(root);
  if (!(pack in active.packs)) return;
  delete active.packs[pack];
  if (Object.keys(active.packs).length === 0) {
    rmSync(join(root, ACTIVE_FILE), { force: true });
    return;
  }
  writeActive(root, active);
}

/** 安装成功后把产物镜像进版本目录，并切激活指针。 */
function stageVersion(
  root: string,
  plan: Plan,
  outcomes: ActionOutcome[],
  written: OwnedPath[],
  home: string | undefined,
): VersionRecord {
  const dir = versionDirOf(root, plan.pack.name, plan.pack.version);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'files'), { recursive: true });
  const files: string[] = [];
  const shared = semanticSharedPaths(plan);
  for (const item of planOutputs(plan)) {
    // 共享产物不镜像：配置与托管块属于多个包共用的一份文件，镜像一份会盖掉别的包
    if (shared.has(ownedKey(item))) continue;
    const abs = resolveOwnedPath(root, home, item);
    if (!existsSync(abs)) continue;
    const label = ownedLabel(root, abs);
    // 版本镜像只覆盖安装根内的产物；absolute 落点在根外，由 generation 快照负责回滚
    if (label === abs.replaceAll('\\', '/')) continue;
    // 版本镜像优先用硬链接共享字节；跨盘/不支持的文件系统退回复制
    linkTree(abs, join(dir, 'files', label));
    files.push(label);
  }
  const record: VersionRecord = {
    apiVersion: VERSION_API_VERSION,
    pack: plan.pack.name,
    version: plan.pack.version,
    ...(plan.harness ? { harness: plan.harness } : {}),
    planHash: plan.planHash,
    installedAt: new Date().toISOString(),
    plan,
    actions: outcomes,
    written: written.map((item) => ownedPathLabel(root, home, item)),
    files,
  };
  writeFileSync(join(dir, 'record.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
  setActive(root, plan.pack.name, plan.pack.version, plan.planHash, plan.harness);
  pruneVersions(root, plan.pack.name);
  return record;
}

/** 每个包只保留最近 5 个版本目录；当前激活的那个永远保留。 */
function pruneVersions(root: string, pack: string): void {
  const dir = join(root, VERSIONS_DIR, packSlug(pack));
  if (!existsSync(dir)) return;
  const active = readActive(root).packs[pack]?.version;
  const records = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const recordFile = join(dir, e.name, 'record.json');
      try {
        return JSON.parse(readFileSync(recordFile, 'utf8')) as VersionRecord;
      } catch {
        return undefined;
      }
    })
    .filter((r): r is VersionRecord => Boolean(r))
    .sort((a, b) => (a.installedAt < b.installedAt ? 1 : -1));
  let keep = 5;
  for (const record of records) {
    if (record.version === active) continue;
    if (keep > 0) {
      keep--;
      continue;
    }
    rmSync(join(dir, versionSlug(record.version)), { recursive: true, force: true });
  }
}

function versionSlug(version: string): string {
  return version.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export function readVersionRecord(root: string, pack: string, version: string): VersionRecord {
  const file = join(versionDirOf(root, pack, version), 'record.json');
  if (!existsSync(file)) throw new Error(`没有这个版本的记录：${pack}@${version}（${file}）`);
  const record = JSON.parse(readFileSync(file, 'utf8')) as VersionRecord;
  assertApiVersion(file, record, VERSION_API_VERSION);
  return record;
}

export interface RollbackResult {
  generation: string;
  restored: string[];
  removed: string[];
}

/**
 * 退回上一次安装之前：被改写的文件按快照放回去，新建的文件删掉，state 也回到当时。
 * 一次回退一个 generation，连续回退就再调一次。
 */
export function rollbackPack(root: string, generation?: string): RollbackResult {
  const release = acquireLock(root);
  try {
    const state = loadState(root);
    const gens = state.generations ?? [];
    if (gens.length === 0) throw new Error('没有可回退的安装记录');
    const gen = generation ? gens.find((g) => g.id === generation) : gens[gens.length - 1];
    if (!gen) throw new Error(`找不到这个 generation：${generation ?? '(latest)'}`);

    const dir = join(root, STATE_DIR, 'snapshots', gen.id);
    if (!existsSync(dir)) throw new Error(`快照已不在：${gen.id}（可能超过保留数量）`);

    const { restored, removed } = restoreGeneration(root, gen);

    const stateBackup = join(dir, 'state.json');
    const statePath = join(root, STATE_FILE);
    if (existsSync(stateBackup)) cpSync(stateBackup, statePath);
    else rmSync(statePath, { force: true });

    const after = loadState(root);
    after.generations = (after.generations ?? []).filter((g) => g.id !== gen.id);
    if (after.generations.length > 0) {
      writeFileSync(statePath, JSON.stringify(after, null, 2) + '\n', 'utf8');
    }
    // 激活指针也要跟着退回：否则 active.json 会指向一个已经不在盘上的版本
    const activeBackup = join(dir, 'active.json');
    const activePath = join(root, ACTIVE_FILE);
    if (existsSync(activeBackup)) cpSync(activeBackup, activePath);
    else if (Object.keys(after.packs).length === 0) rmSync(activePath, { force: true });
    rmSync(dir, { recursive: true, force: true });

    return { generation: gen.id, restored, removed };
  } finally {
    release();
  }
}

/** 按 generation 快照恢复文件系统；回退与失败回滚共用。 */
function restoreGeneration(
  root: string,
  gen: Generation,
): { restored: string[]; removed: string[] } {
  const dir = join(root, STATE_DIR, 'snapshots', gen.id);
  const restored: string[] = [];
  for (const rel of gen.existed ?? []) {
    const src = join(dir, 'files', rel);
    if (!existsSync(src)) continue;
    const abs = resolveWithin(root, rel);
    if (lstatSync(src).isDirectory()) replaceTree(src, abs);
    else copyFileAtomic(src, abs);
    restored.push(rel);
  }
  for (const abs of gen.existedExternal ?? []) {
    const src = join(dir, 'external', externalSnapshotName(abs));
    if (!existsSync(src)) continue;
    if (lstatSync(src).isDirectory()) replaceTree(src, abs);
    else copyFileAtomic(src, abs);
    restored.push(ownedLabel(root, abs));
  }

  const removed: string[] = [];
  for (const rel of [...(gen.created ?? [])].sort((a, b) => b.length - a.length)) {
    const abs = resolveWithin(root, rel);
    if (!existsSync(abs)) continue;
    rmSync(abs, { recursive: true, force: true });
    removed.push(rel);
  }
  for (const abs of gen.createdExternal ?? []) {
    if (!existsSync(abs)) continue;
    rmSync(abs, { recursive: true, force: true });
    removed.push(ownedLabel(root, abs));
  }
  return { restored, removed };
}

export interface RemoveResult {
  packs: string[];
  removed: string[];
  kept: string[];
}

/**
 * 按 state 反向删除这个包写过的文件。
 * `config.json` 是多包共享的：还有别的包时保留，只有最后一个包被移除时才删。
 */
export function removePack(root: string, packKey?: string): RemoveResult {
  const release = acquireLock(root);
  try {
    const state = loadState(root);
    const keys = packKey ? [packKey] : Object.keys(state.packs);
    const removed: string[] = [];
    const kept: string[] = [];

    for (const key of keys) {
      const record = state.packs[key];
      if (!record) continue;
      const isLast = Object.keys(state.packs).length === 1;
      // 宿主 CLI 管理的 MCP：按名字从 user scope 摘掉
      for (const name of record.hostMcp ?? []) {
        try {
          if (removeClaudeMcp(name)) removed.push(`claude-mcp:${name}`);
        } catch (err) {
          kept.push(`claude-mcp:${name}（${(err as Error).message}）`);
        }
      }
      // 持久状态目录默认保留；只有显式 retain: remove 才跟随卸载删除
      for (const spec of record.stateDirs ?? []) {
        const abs = resolveWithin(root, spec.path);
        if (!existsSync(abs)) continue;
        if (spec.retain === 'remove') {
          rmSync(abs, { recursive: true, force: true });
          removed.push(spec.path);
        } else {
          kept.push(spec.path);
        }
      }
      const home = record.home;
      const absOf = (item: OwnedPath): string => resolveOwnedPath(root, home, item);
      const files = [...record.written].sort((a, b) => absOf(b).length - absOf(a).length);
      // 共享改动的撤销信息由 PLAN_OPS 表给出；老 state 没有计划快照时退回动作结果
      const sharedServers = record.plan
        ? record.plan.actions.flatMap((a) => {
            const payload = actionUndoPayload(a);
            return payload?.undo === 'restore-shared'
              ? [
                  {
                    path: payload.path,
                    base: payload.base ?? 'root',
                    resource: payload.key,
                    configPath: payload.configPath,
                    format: payload.format,
                  },
                ]
              : [];
          })
        : record.actions.flatMap((o) =>
            o.op === 'register.mcp' && o.target
              ? [
                  {
                    path: o.target,
                    base: 'root' as PathBase,
                    resource: o.resource ?? 'mcp',
                    configPath: undefined,
                    format: undefined,
                  },
                ]
              : [],
          );
      const blockRefs = record.plan
        ? record.plan.actions.flatMap((a) => {
            const payload = actionUndoPayload(a);
            return payload?.undo === 'strip-block'
              ? [{ file: payload.file, base: payload.base ?? 'root', blockId: payload.blockId }]
              : [];
          })
        : record.actions.flatMap((o) =>
            o.op === 'instruction' && o.target && o.blockId
              ? [{ file: o.target, base: 'root' as PathBase, blockId: o.blockId }]
              : [],
          );
      for (const item of files) {
        if (item.base === 'root' && item.path === `${STATE_DIR}/config.json` && !isLast) {
          kept.push(ownedPathLabel(root, home, item));
          continue;
        }
        const abs = absOf(item);
        const label = ownedLabel(root, abs);
        if (!existsSync(abs)) continue;

        // 配置文件是共享的：先按 merge 的 undo 还原键，再摘掉自己登记的 server 条目，不整文件删
        const regs = sharedServers.filter(
          (s) => absOf({ path: s.path, base: s.base }) === abs,
        );
        if (regs.length > 0 && /\.toml$/i.test(abs)) {
          let text = readFileSync(abs, 'utf8');
          for (const a of regs) text = stripMcpToml(text, a.resource);
          if (text.trim() === '') rmSync(abs, { force: true });
          else writeFileSync(abs, text, 'utf8');
          removed.push(label);
          continue;
        }
        if (regs.length > 0) {
          // 非 TOML：按方言的格式与对象路径摘条目（缺省 JSON mcpServers）
          const dialect = {
            configPath: regs[0]!.configPath ?? ['mcpServers'],
            format: (regs[0]!.format === 'yaml' ? 'yaml' : 'json') as McpConfigFormat,
          };
          rewriteMcpConfig(abs, dialect.format, (data) => {
            for (const a of regs) removeConfigEntry(data, dialect.configPath, a.resource);
          });
          removed.push(label);
          continue;
        }

        // 指令文件是用户也会写的：只摘掉自己的托管块，不整文件删
        const blockIds = blockRefs
          .filter((b) => absOf({ path: b.file, base: b.base }) === abs)
          .map((b) => b.blockId);
        if (blockIds.length > 0) {
          let text = readFileSync(abs, 'utf8');
          for (const id of blockIds) text = stripBlock(text, id);
          if (text.trim() === '') rmSync(abs, { force: true });
          else writeFileSync(abs, text, 'utf8');
          removed.push(label);
          continue;
        }

        rmSync(abs, { recursive: true, force: true });
        removed.push(label);
      }
      // 从 registry 装进来的包会留一份清单副本；卸载时一起清掉
      const packName = key.split('@')[0] ?? '';
      if (packName) {
        const copy = resolveWithin(root, join(STATE_DIR, 'packs', packName));
        if (existsSync(copy)) rmSync(copy, { recursive: true, force: true });
      }
      delete state.packs[key];
      // 没有任何版本记录留下时，把整个版本目录与激活项一并摘掉
      if (packName && !Object.keys(state.packs).some((k) => (k.split('@')[0] ?? '') === packName)) {
        const versions = resolveWithin(root, join(VERSIONS_DIR, packSlug(packName)));
        if (existsSync(versions)) rmSync(versions, { recursive: true, force: true });
        // 空壳目录不留在项目里
        const versionsRoot = join(root, VERSIONS_DIR);
        if (existsSync(versionsRoot) && readdirSync(versionsRoot).length === 0) {
          rmSync(versionsRoot, { recursive: true, force: true });
        }
        unsetActive(root, packName);
      }
    }

    const statePath = join(root, STATE_FILE);
    if (Object.keys(state.packs).length === 0) {
      rmSync(statePath, { force: true });
    } else {
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    }
    return { packs: keys, removed, kept };
  } finally {
    release();
  }
}

/** register.mcp 的宿主角落：条目挂在哪个对象路径下、文件什么格式（旧计划缺省 mcpServers + JSON）。 */
type McpConfigFormat = 'json' | 'yaml';
function mcpDialectOf(action: PlanAction): { configPath: string[]; format: McpConfigFormat } {
  if (action.op !== 'register.mcp') return { configPath: ['mcpServers'], format: 'json' };
  return {
    configPath: action.configPath ?? ['mcpServers'],
    format: action.format === 'yaml' ? 'yaml' : 'json',
  };
}

function readMcpConfig(file: string, format: McpConfigFormat): Record<string, unknown> {
  const text = readFileSync(file, 'utf8');
  const data = format === 'yaml' ? (parseYaml(text) ?? {}) : JSON.parse(text);
  return isPlainObject(data) ? data : {};
}

function serializeMcpConfig(data: Record<string, unknown>, format: McpConfigFormat): string {
  return format === 'yaml' ? stringifyYaml(data).trimEnd() + '\n' : JSON.stringify(data, null, 2) + '\n';
}

/** 沿对象路径拿到容器（缺就建），把条目写进去；已有条目做浅合并（保持旧行为）。 */
function upsertConfigEntry(
  data: Record<string, unknown>,
  configPath: readonly string[],
  key: string,
  spec: unknown,
): Record<string, unknown> {
  let cur: Record<string, unknown> = data;
  for (const part of configPath) {
    const next = cur[part];
    if (isPlainObject(next)) {
      cur = next;
    } else {
      const created: Record<string, unknown> = {};
      cur[part] = created;
      cur = created;
    }
  }
  const existing = cur[key];
  cur[key] = { ...(isPlainObject(existing) ? existing : {}), ...(isPlainObject(spec) ? spec : {}) };
  return data;
}

/** 沿对象路径摘掉条目（调用方再 pruneEmpty 收尾）。 */
function removeConfigEntry(
  data: Record<string, unknown>,
  configPath: readonly string[],
  key: string,
): void {
  let cur: Record<string, unknown> | undefined = data;
  for (const part of configPath) {
    const next: unknown = cur[part];
    if (!isPlainObject(next)) return;
    cur = next;
  }
  delete cur[key];
}

/** 摘掉条目后重写（或清空到只剩空壳就删文件）。返回是否删了文件。 */
function rewriteMcpConfig(
  file: string,
  format: McpConfigFormat,
  mutate: (data: Record<string, unknown>) => void,
): boolean {
  const data = readMcpConfig(file, format);
  mutate(data);
  const pruned = pruneEmpty(data);
  if (Object.keys(pruned).length === 0) {
    rmSync(file, { force: true });
    return true;
  }
  writeFileSync(file, serializeMcpConfig(pruned, format), 'utf8');
  return false;
}

async function applyAction(
  action: PlanAction,
  plan: Plan,
  opts: ApplyOptions,
): Promise<ActionOutcome> {
  switch (action.op) {
    case 'fetch': {
      const dest = resolveOwnedPath(opts.root, opts.home, {
        path: action.dest,
        base: action.destBase ?? 'root',
      });
      if (opts.dryRun) {
        return { actionId: action.actionId, op: action.op, status: 'done', target: action.dest };
      }
      const headers: Record<string, string> = {};
      const auth = 'auth' in action ? action.auth : undefined;
      if (auth) {
        const token = resolveToken(auth.env);
        if (!token) {
          throw new Error(
            `需要 ${auth.env} 才能下载 ${hostOf(action.uri)}（用 packhub auth set ${auth.env} <token> 存起来，或设同名环境变量）`,
          );
        }
        const scheme = auth.scheme ?? 'bearer';
        headers.Authorization =
          scheme === 'basic' ? `Basic ${token}` : scheme === 'token' ? `token ${token}` : `Bearer ${token}`;
      }
      // pypi 的地址要查元数据才知道（文件名带哈希），在下载前解析
      const uri = action.uri.startsWith('pypi:')
        ? (await resolvePypiSdist(action.uri)).url
        : action.uri;
      const res = await download(uri, dest, action.integrity, {
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(auth ? { authHint: auth.env } : {}),
      });
      return {
        actionId: action.actionId,
        op: action.op,
        status: 'done',
        target: action.dest,
        message: `${Math.max(1, Math.round(res.bytes / 1024))} KB · ${res.integrity.slice(0, 14)}…`,
      };
    }

    case 'unpack': {
      // from 是 fetch 实际写盘的位置，基准由表里声明（root / home / absolute）
      const from = sourcePath(action, opts);
      const to = resolveOwnedPath(opts.root, opts.home, {
        path: action.to,
        base: action.toBase ?? 'root',
      });
      if (!existsSync(from)) throw new Error(`待解包文件不存在：${action.from}`);
      if (!opts.dryRun) {
        // 解包产物可能与版本镜像是硬链接：先清空目的地，避免 tar 原地覆盖把镜像改掉
        rmSync(to, { recursive: true, force: true });
        mkdirSync(to, { recursive: true });
        await tar.x({
          file: from,
          cwd: to,
          strip: action.strip ?? 0,
          // 归档内部路径不得逃出 to；符号链接/硬链接也一律不落地
          filter: (path, entry) => isSafeArchiveEntry(path, entry),
        });
      }
      return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
    }

    case 'exec': {
      if (!opts.allowExec) {
        return {
          actionId: action.actionId,
          op: action.op,
          status: 'needs-approval',
          message: `需要 --allow-exec 才会执行：${action.command} ${action.args.join(' ')}`,
        };
      }
      const cwd = action.cwd ? resolveWithin(opts.root, action.cwd) : resolveWithin(opts.root, '.');
      if (!existsSync(cwd)) throw new Error(`exec 的工作目录不存在：${action.cwd ?? '.'}`);
      if (opts.dryRun) {
        return { actionId: action.actionId, op: action.op, status: 'done', target: action.command };
      }
      const result = runCommand(action.command, action.args, cwd, {
        ...process.env,
        ...(action.env ?? {}),
      }, action.timeout ?? 120_000);
      if (result.status !== 0) {
        const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-1)[0] ?? '';
        throw new Error(
          `exec 退出码 ${String(result.status)}${tail ? `：${tail}` : ''}（${action.command} ${action.args.join(' ')}）`,
        );
      }
      return {
        actionId: action.actionId,
        op: action.op,
        status: 'done',
        target: action.command,
        message: action.args.join(' '),
      };
    }
    case 'link.skill': {
      const from = sourcePath(action, opts);
      const to = resolveOwnedPath(opts.root, opts.home, {
        path: action.to,
        base: action.toBase ?? 'root',
      });
      if (!existsSync(from)) {
        throw new Error(`skill 源目录不存在：${action.from}`);
      }
      if (opts.dryRun) return { actionId: action.actionId, op: action.op, status: 'done' };
      mkdirSync(dirname(to), { recursive: true });
      // 覆盖安装时先移除旧的 skill 目录：文件可能是版本镜像的硬链接
      rmSync(to, { recursive: true, force: true });
      cpSync(from, to, { recursive: true, force: true });
      return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
    }

    case 'copy': {
      const from = sourcePath(action, opts);
      const to = resolveOwnedPath(opts.root, opts.home, {
        path: action.to,
        base: action.toBase ?? 'root',
      });
      if (!existsSync(from)) throw new Error(`copy 的来源不存在：${action.from}`);
      if (!opts.dryRun) {
        mkdirSync(dirname(to), { recursive: true });
        rmSync(to, { recursive: true, force: true });
        cpSync(from, to, { recursive: true, force: true });
      }
      return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
    }

    case 'link.exec': {
      const platform = platformOf(opts);
      // 平台裁剪在执行期：计划保留全部动作，不匹配的命令记 skipped 并说明原因
      if (action.platforms && action.platforms.length > 0 && !action.platforms.includes(platform)) {
        return {
          actionId: action.actionId,
          op: action.op,
          status: 'skipped',
          message: `平台 ${platform} 不在 platforms（${action.platforms.join(', ')}）里，跳过 ${action.to}`,
          target: action.to,
        };
      }
      if (action.runtime === 'shell' && platform.startsWith('win32')) {
        throw new Error(
          `runtime: shell 要 sh，Windows 上没有：${action.to}；换 node / python，或用 platforms 限定平台`,
        );
      }
      const entry = resolveOwnedPath(opts.root, opts.home, {
        path: action.entry,
        base: action.entryBase ?? 'root',
      });
      const modulePath = action.module
        ? resolveOwnedPath(opts.root, opts.home, {
            path: action.module,
            base: action.moduleBase ?? 'root',
          })
        : undefined;
      if (!existsSync(entry)) throw new Error(`工具入口不存在：${action.entry}`);
      if (modulePath && !existsSync(modulePath)) throw new Error(`工具模块不存在：${action.module}`);
      const to = resolveOwnedPath(opts.root, opts.home, {
        path: action.to,
        base: action.toBase ?? 'root',
      });
      if (opts.dryRun) {
        return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
      }
      const bin = action.runtime === 'binary' ? '' : action.runtime === 'shell' ? 'sh' : action.runtime;
      const extra = (action.args ?? []).join(' ');
      const line = [bin, `"${entry}"`, modulePath ? `"${modulePath}"` : '', extra].filter(Boolean).join(' ');
      // 环境变量写进入口，而不是执行时临时 export：调用方不需要知道它们
      const envPairs = Object.entries(action.env ?? {});
      const posixEnv = envPairs
        .map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}' `)
        .join('');
      const winEnv = envPairs.map(([k, v]) => `set "${k}=${v}"\r\n`).join('');
      mkdirSync(dirname(to), { recursive: true });
      // posix 入口始终生成（verify 与别的宿主都按无后缀路径找）；
      // .cmd 只在 Windows 生成——那边不认 shebang，全靠它
      writeFileAtomic(to, `#!/bin/sh\n# generated by packhub\nexec ${posixEnv}${line} "$@"\n`);
      try {
        chmodSync(to, 0o755);
      } catch {
        /* Windows 上不需要执行位 */
      }
      if (platform.startsWith('win32')) {
        writeFileAtomic(`${to}.cmd`, `@echo off\r\nrem generated by packhub\r\n${winEnv}${line} %*\r\n`);
      }
      return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
    }

    case 'delete': {
      const to = resolveOwnedPath(opts.root, opts.home, {
        path: action.to,
        base: action.toBase ?? 'root',
      });
      // 目标已经不在：补丁要删的东西本来就没有，不当作失败（快照里也没有它）
      if (!existsSync(to)) {
        return { actionId: action.actionId, op: action.op, status: 'noop', target: action.to };
      }
      if (!opts.dryRun) {
        rmSync(to, { force: true });
      }
      return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
    }

    case 'write': {
      const to = resolveOwnedPath(opts.root, opts.home, {
        path: action.to,
        base: action.toBase ?? 'root',
      });
      // 覆盖层可能带二进制文件（图片、字体、脚本），不能一律按 UTF-8 读
      if (action.content === undefined && action.from) {
        const raw = readFileSync(sourcePath(action, opts));
        const binary = raw.subarray(0, 8192).includes(0);
        if (binary) {
          if (existsSync(to) && readFileSync(to).equals(raw)) {
            return { actionId: action.actionId, op: action.op, status: 'noop', target: action.to };
          }
          if (!opts.dryRun) {
            mkdirSync(dirname(to), { recursive: true });
            copyFileAtomic(sourcePath(action, opts), to);
          }
          return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
        }
      }
      const content =
        action.content !== undefined
          ? action.content
          : readFileSync(sourcePath(action, opts), 'utf8');
      if (existsSync(to) && readFileSync(to, 'utf8') === content) {
        return { actionId: action.actionId, op: action.op, status: 'noop', target: action.to };
      }
      if (!opts.dryRun) {
        mkdirSync(dirname(to), { recursive: true });
        writeFileAtomic(to, content);
      }
      return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
    }

    case 'register.mcp': {
      const path = action.path ?? `${STATE_DIR}/config.json`;
      const base = action.toBase ?? 'root';
      const to = resolveOwnedPath(opts.root, opts.home, { path, base });
      const label = ownedLabel(opts.root, to);
      // codex 的全局 MCP 配置是 TOML：用带标记的托管块，卸载时按 id 摘掉
      if (/\.toml$/i.test(path)) {
        const before = existsSync(to) ? readFileSync(to, 'utf8') : '';
        const next = upsertMcpToml(before, action.resource ?? 'mcp', action.spec);
        if (before === next) {
          return {
            actionId: action.actionId,
            op: action.op,
            status: 'noop',
            target: path,
            resource: action.resource ?? 'mcp',
          };
        }
        if (!opts.dryRun) {
          mkdirSync(dirname(to), { recursive: true });
          if (before) backup(opts.root, label, before);
          writeFileAtomic(to, next);
        }
        return {
          actionId: action.actionId,
          op: action.op,
          status: 'done',
          target: path,
          resource: action.resource ?? 'mcp',
        };
      }
      const key = action.resource ?? 'mcp';
      // 非 TOML：按宿主的 MCP 方言写（缺省 JSON mcpServers）
      const { configPath, format } = mcpDialectOf(action);
      const current: Record<string, unknown> = existsSync(to) ? readMcpConfig(to, format) : {};
      upsertConfigEntry(current, configPath, key, action.spec);
      const nextText = serializeMcpConfig(current, format);
      const before = existsSync(to) ? readFileSync(to, 'utf8') : '';
      if (before === nextText) {
        return {
          actionId: action.actionId,
          op: action.op,
          status: 'noop',
          target: path,
          resource: key,
        };
      }
      if (!opts.dryRun) {
        mkdirSync(dirname(to), { recursive: true });
        if (before) backup(opts.root, label, before);
        writeFileAtomic(to, nextText);
      }
      return {
        actionId: action.actionId,
        op: action.op,
        status: 'done',
        target: path,
        resource: key,
      };
    }

    case 'instruction': {
      const to = resolveOwnedPath(opts.root, opts.home, {
        path: action.file,
        base: action.toBase ?? 'root',
      });
      const before = existsSync(to) ? readFileSync(to, 'utf8') : '';
      const next = upsertBlock(before, action.blockId, action.content);
      if (before === next) {
        return { actionId: action.actionId, op: action.op, status: 'noop', target: action.file };
      }
      if (!opts.dryRun) {
        mkdirSync(dirname(to), { recursive: true });
        if (before) backup(opts.root, ownedLabel(opts.root, to), before);
        writeFileAtomic(to, next);
      }
      return {
        actionId: action.actionId,
        op: action.op,
        status: 'done',
        target: action.file,
        blockId: action.blockId,
      };
    }

    case 'state.dir': {
      const to = resolveOwnedPath(opts.root, opts.home, {
        path: action.to,
        base: action.toBase ?? 'root',
      });
      if (!opts.dryRun) mkdirSync(to, { recursive: true });
      return {
        actionId: action.actionId,
        op: action.op,
        status: 'done',
        target: action.to,
        message: action.retain === 'remove' ? '卸载时删除' : '卸载时保留',
      };
    }

    default: {
      // 类型穷举：PlanOp 联合里加 op 时这里编译失败，逼着同时补表和执行器
      const unhandled: never = action;
      throw new Error(
        `认不出的动作：${(unhandled as unknown as { op: string }).op}；很可能是旧版本留下的 state 或锁，重新安装这个包`,
      );
    }
  }
}

/**
 * 执行安装期命令。Windows 上 npx/npm 是 .cmd 垫片，只能过 shell；
 * 命令来自清单作者，默认不执行，要 --allow-exec 才走到这里。
 */
function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): { status: number | null; stdout: string; stderr: string } {
  const options = { cwd, env, timeout, encoding: 'utf8' as const, windowsHide: true };
  if (process.platform === 'win32') {
    const quote = (s: string): string =>
      /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    const line = [command, ...args].map(quote).join(' ');
    const res = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], options);
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }
  const res = spawnSync(command, args, options);
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** 报错只留 host + path，不把可能带凭证的查询串打出来。 */
function hostOf(uri: string): string {  try {
    const u = new URL(uri);
    return `${u.host}${u.pathname}`;
  } catch {
    return uri.split('?')[0] ?? uri;
  }
}

function readStructured(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  return /\.json$/i.test(file) ? JSON.parse(text) : (parseYaml(text) ?? {});
}


function backup(root: string, label: string, content: string): void {
  // 安装根之外的绝对路径不能直接拿来拼目录（Windows 的盘符非法）：用哈希当文件名
  const safe = isAbsolute(label) || label.includes('..')
    ? sha256(label).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) + '.bak'
    : label;
  const dest = resolveWithin(
    root,
    join(STATE_DIR, 'backups', sha256(content).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12), safe),
  );
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content, 'utf8');
}

export function loadState(root: string): State {
  const file = join(root, STATE_FILE);
  if (!existsSync(file)) return { apiVersion: STATE_API_VERSION, packs: {} };
  let parsed: Partial<State>;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<State>;
  } catch (err) {
    throw new Error(`state 损坏：${file}（${(err as Error).message}）；先备份再删除或修复后重试`);
  }
  // 早期 state 没有 apiVersion：补上而不是拒绝——它是本机缓存，不是发布契约
  // 但写了别的主版本就是另一份格式：拒绝，按契约不猜字段
  assertApiVersion(file, parsed, STATE_API_VERSION);
  // 早期 state 的 written 是 `string[]`：按 root 读，不改写文件（下次真正写 state 时才用新形状）
  const rawPacks = (parsed.packs ?? {}) as Record<string, Record<string, unknown>>;
  const packs: State['packs'] = {};
  for (const [key, raw] of Object.entries(rawPacks)) {
    const record = raw as unknown as State['packs'][string];
    packs[key] = {
      ...record,
      written: normalizeWritten(raw.written),
      ...(typeof raw.home === 'string' ? { home: raw.home } : {}),
    };
  }
  return {
    apiVersion: STATE_API_VERSION,
    ...(parsed.generations ? { generations: parsed.generations } : {}),
    packs,
  };
}

/** 写回 state（MCP adapter 之类的非文件改动用它，避免外部复制 loadState 的结构）。 */
export function saveState(root: string, state: State): void {
  const file = join(root, STATE_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n');
}

function viaTemp(file: string): string {
  return `${file}.packhub-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 写目标文件用「临时文件 + rename」。
 * 项目文件与版本镜像是硬链接：原地改写会把镜像一起改掉；rename 换的是目录项，不碰旧 inode。
 */
function writeFileAtomic(file: string, data: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = viaTemp(file);
  let mode: number | undefined;
  try {
    mode = statSync(file).mode;
  } catch {
    /* 新文件用默认权限 */
  }
  writeFileSync(tmp, data);
  if (mode !== undefined) {
    try {
      chmodSync(tmp, mode);
    } catch {
      /* Windows 上权限位有限 */
    }
  }
  renameSync(tmp, file);
}

function copyFileAtomic(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  const tmp = viaTemp(to);
  copyFileSync(from, tmp);
  try {
    chmodSync(tmp, statSync(from).mode);
  } catch {
    /* Windows 上权限位有限 */
  }
  renameSync(tmp, to);
}

/** 目录或文件整体替换：先复制到旁边，再换目录项；避免写进旧硬链接的 inode。 */
function replaceTree(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  const tmp = viaTemp(to);
  cpSync(from, tmp, { recursive: true, force: true });
  rmSync(to, { recursive: true, force: true });
  renameSync(tmp, to);
}

/** 把目录树镜像成硬链接；文件系统不支持（跨盘、FAT）时退回复制。 */
function linkTree(from: string, to: string): void {
  const st = lstatSync(from);
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      linkTree(join(from, entry.name), join(to, entry.name));
    }
    return;
  }
  mkdirSync(dirname(to), { recursive: true });
  rmSync(to, { force: true });
  try {
    linkSync(from, to);
  } catch {
    cpSync(from, to, { force: true });
  }
}

/** 单个文件用硬链接落到目标位置，再原子换掉旧目标。 */
function linkFileAtomic(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  const tmp = viaTemp(to);
  try {
    linkSync(from, tmp);
  } catch {
    cpSync(from, tmp, { force: true });
  }
  rmSync(to, { recursive: true, force: true });
  renameSync(tmp, to);
}

/** 原子替换，供后续 adapter 复用。 */
export function atomicWrite(file: string, content: string): void {
  writeFileAtomic(file, content);
}

/* ---------- 托管块（AGENTS.md / CLAUDE.md） ---------- */

function blockMarkers(blockId: string): { begin: string; end: string } {
  return { begin: `<!-- packhub:begin ${blockId} -->`, end: `<!-- packhub:end ${blockId} -->` };
}

/** 只改标记之间的内容，块外一律不动；没有块就追加。 */
function upsertBlock(text: string, blockId: string, content: string): string {
  const { begin, end } = blockMarkers(blockId);
  const block = `${begin}\n${content.trimEnd()}\n${end}`;
  const re = new RegExp(
    `${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}`,
    'm',
  );
  if (re.test(text)) return text.replace(re, block);
  const trimmed = text.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

/** 卸载时只摘掉自己的块，保留用户写在块外的内容。 */
function stripBlock(text: string, blockId: string): string {
  const { begin, end } = blockMarkers(blockId);
  const re = new RegExp(`\\n*${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n*`, 'm');
  return text.replace(re, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ---------- TOML 托管块（codex 的 config.toml） ---------- */

function tomlValue(value: unknown): string | undefined {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const items = value.map((v) => tomlValue(v)).filter((v): v is string => v !== undefined);
    return `[${items.join(', ')}]`;
  }
  if (isPlainObject(value)) {
    const pairs = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => {
        const encoded = tomlValue(v);
        return encoded === undefined ? undefined : `${k} = ${encoded}`;
      })
      .filter((v): v is string => Boolean(v));
    return `{ ${pairs.join(', ')} }`;
  }
  return undefined;
}

function mcpTomlBlock(id: string, spec: Record<string, unknown>): string {
  const lines = [`# packhub:begin mcp ${id}`, `[mcp_servers.${id}]`];
  for (const [key, value] of Object.entries(spec)) {
    const encoded = tomlValue(value);
    if (encoded !== undefined) lines.push(`${key} = ${encoded}`);
  }
  lines.push(`# packhub:end mcp ${id}`);
  return lines.join('\n');
}

function upsertMcpToml(text: string, id: string, spec: Record<string, unknown>): string {
  const begin = `# packhub:begin mcp ${id}`;
  const end = `# packhub:end mcp ${id}`;
  const block = mcpTomlBlock(id, spec);
  const re = new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}`, 'm');
  if (re.test(text)) return text.replace(re, block);
  const trimmed = text.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

function stripMcpToml(text: string, id: string): string {
  const begin = `# packhub:begin mcp ${id}`;
  const end = `# packhub:end mcp ${id}`;
  const re = new RegExp(`\\n*${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n*`, 'm');
  return text.replace(re, '\n').replace(/\n{3,}/g, '\n\n').trimEnd() + (text.trim() ? '\n' : '');
}





/** 去掉空对象（撤销后留下的壳），保留数组与假值。 */
export function pruneEmpty(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isPlainObject(v)) {
      const pruned = pruneEmpty(v);
      if (Object.keys(pruned).length > 0) out[k] = pruned;
    } else {
      out[k] = v;
    }
  }
  return out;
}



export interface PruneResult {
  /** 真正从磁盘删掉/撤销的路径 */
  removed: string[];
  /** 新版本仍然需要，保留 */
  kept: string[];
  /** 无法安全撤销、留给人工确认的项 */
  warnings: string[];
}

/**
 * 升级时清掉「旧计划有、新计划没有」的产物。
 * 只删这个包自己的输出；共享配置文件按上次安装记的 undo 还原，指令文件只摘自己的块。
 */
export function pruneRemoved(
  root: string,
  previous: PlanShape,
  next: Plan,
  previousActions: ActionOutcome[] = [],
): PruneResult {
  const { removed: gone } = diffActions(previous.actions, next.actions);
  const state = loadState(root);
  const record = state.packs[`${next.pack.name}@${next.pack.version}`];
  const home = record?.home;
  const produced = new Set(planOutputs(next).map((item) => resolveOwnedPath(root, home, item)));
  const newMcp = new Set(
    next.actions.flatMap((a) => {
      const payload = actionUndoPayload(a);
      return payload?.undo === 'restore-shared' ? [payload.key] : [];
    }),
  );
  const newBlocks = new Set(
    next.actions.flatMap((a) => {
      const payload = actionUndoPayload(a);
      if (payload?.undo !== 'strip-block') return [];
      const abs = resolveOwnedPath(root, home, { path: payload.file, base: payload.base ?? 'root' });
      return [`${abs}::${payload.blockId}`];
    }),
  );
  const outcomes = new Map(previousActions.map((o) => [o.actionId, o]));
  const removed: string[] = [];
  const removedAbs = new Set<string>();
  const kept: string[] = [];
  const warnings: string[] = [];

  /** 新计划还要产出这个路径（或它的子路径）时不能删。 */
  const stillProduced = (abs: string): boolean =>
    [...produced].some(
      (p) => p === abs || abs.startsWith(`${p}${sep}`) || p.startsWith(`${abs}${sep}`),
    );

  // 撤销方式与撤销负载都来自 PLAN_OPS 表；这里只按四类各做一次，不再按 op 猜路径/键
  for (const action of gone) {
    const payload = actionUndoPayload(action);
    switch (actionUndo(action)) {
      case 'delete': {
        for (const item of actionOutputs(action, previous)) {
          const abs = resolveOwnedPath(root, home, item);
          const label = ownedLabel(root, abs);
          if (actionIsShared(action) || stillProduced(abs)) {
            kept.push(label);
            continue;
          }
          if (!existsSync(abs)) continue;
          rmSync(abs, { recursive: true, force: true });
          removed.push(label);
          removedAbs.add(abs);
        }
        break;
      }
      case 'restore-shared': {
        if (payload?.undo !== 'restore-shared') break;
        const outcome = outcomes.get(action.actionId);
        const server = outcome?.resource ?? payload.key;
        const path = payload.path;
        const abs = resolveOwnedPath(root, home, { path, base: payload.base ?? 'root' });
        const label = ownedLabel(root, abs);
        if (newMcp.has(server)) {
          kept.push(label);
          break;
        }
        if (!existsSync(abs)) break;
        if (/\.toml$/i.test(abs)) {
          const text = stripMcpToml(readFileSync(abs, 'utf8'), server);
          if (text.trim() === '') rmSync(abs, { force: true });
          else writeFileSync(abs, text, 'utf8');
          removed.push(label);
          removedAbs.add(abs);
          break;
        }
        const dialect = {
          configPath: payload.configPath ?? ['mcpServers'],
          format: (payload.format === 'yaml' ? 'yaml' : 'json') as McpConfigFormat,
        };
        rewriteMcpConfig(abs, dialect.format, (data) => {
          removeConfigEntry(data, dialect.configPath, server);
        });
        removed.push(label);
        removedAbs.add(abs);
        break;
      }
      case 'strip-block': {
        if (payload?.undo !== 'strip-block') break;
        const abs = resolveOwnedPath(root, home, { path: payload.file, base: payload.base ?? 'root' });
        const label = ownedLabel(root, abs);
        if (newBlocks.has(`${abs}::${payload.blockId}`)) {
          kept.push(label);
          break;
        }
        if (!existsSync(abs)) break;
        const text = stripBlock(readFileSync(abs, 'utf8'), payload.blockId);
        if (text.trim() === '') rmSync(abs, { force: true });
        else writeFileSync(abs, text, 'utf8');
        removed.push(label);
        removedAbs.add(abs);
        break;
      }
      case 'none': {
        // 数据目录不随升级删除，但要说清为什么留着
        const warning = actionRetainWarning(action);
        const rel = 'to' in action ? action.to : undefined;
        if (warning && rel) {
          kept.push(rel);
          warnings.push(`${warning}：${rel}`);
        }
        break;
      }
    }
  }

  if (removed.length > 0 && record) {
    record.written = record.written.filter(
      (item) => !removedAbs.has(resolveOwnedPath(root, home, item)),
    );
    writeFileSync(join(root, STATE_FILE), JSON.stringify(state, null, 2) + '\n', 'utf8');
  }

  return { removed, kept, warnings };
}

/**
 * 这次安装要写的路径里，哪些已经被别的包占了。
 *
 * 豁免只认「两边都是语义共享产物」：MCP 配置按 key 合并、指令文件按托管块合并，
 * 合并不丢别人的东西，才不算冲突。别人当私有文件写的路径（哪怕后缀是 `.json`），
 * 这次就算用 register.mcp 去改也会覆盖：仍然算冲突。
 */
function findOwnershipConflicts(
  plan: Plan,
  key: string,
  root: string,
  home: string | undefined,
): string[] {
  const state = loadState(root);
  const sharedHere = sharedAbsOf(plan, root, home);
  const owners = new Map<string, string>();
  const ownerShared = new Map<string, Set<string>>();
  const selfName = key.split('@')[0] ?? '';
  for (const [packKey, record] of Object.entries(state.packs)) {
    if (packKey === key) continue;
    // 同一个包的旧版本不算冲突：升级本来就该覆盖自己
    if ((packKey.split('@')[0] ?? '') === selfName) continue;
    // 老 state 未必存了计划快照：没有就当它全私有，宁可报冲突也不静默覆盖
    ownerShared.set(
      packKey,
      record.plan ? sharedAbsOf(record.plan, root, record.home) : new Set(),
    );
    for (const item of record.written) {
      owners.set(resolveOwnedPath(root, record.home, item), packKey);
    }
    for (const spec of record.stateDirs ?? []) owners.set(resolveWithin(root, spec.path), packKey);
  }
  const out: string[] = [];
  const targets = [
    ...planOutputs(plan).map((item) => resolveOwnedPath(root, home, item)),
    ...stateDirSpecs(plan).map((s) => resolveWithin(root, s.path)),
  ];
  for (const abs of targets) {
    // 目录整体归一个包时，另一个包往目录里写文件同样算冲突
    for (const [owned, owner] of owners) {
      if (!(abs === owned || abs.startsWith(`${owned}${sep}`) || owned.startsWith(`${abs}${sep}`))) {
        continue;
      }
      if (sharedHere.has(abs) && ownerShared.get(owner)?.has(owned)) break;
      out.push(`${ownedLabel(root, abs)}（${owner} 拥有 ${ownedLabel(root, owned)}）`);
      break;
    }
  }
  return out;
}

/** 计划里语义共享产物的绝对路径集合（供所有权判定用）。 */
function sharedAbsOf(plan: PlanShape, root: string, home: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const action of plan.actions) {
    if (!actionIsShared(action)) continue;
    for (const item of actionOutputs(action, plan)) out.add(resolveOwnedPath(root, home, item));
  }
  return out;
}

/** 给 codex 目标下的 skill 补 agents/openai.yaml；已有就尊重源内容。 */
function ensureCodexSkillYaml(
  root: string,
  plan: Plan,
  written: OwnedPath[],
  home: string | undefined,
): void {
  for (const action of plan.actions) {
    if (action.op !== 'link.skill') continue;
    const base = action.toBase ?? 'root';
    const dir = resolveOwnedPath(root, home, { path: action.to, base });
    const file = join(dir, ...CODEX_SKILL_YAML.split('/'));
    if (existsSync(file)) continue;
    let front;
    try {
      front = readSkillFrontmatter(dir);
    } catch {
      continue; // 不是标准 skill 的目录（比如用户手放的）不强行生成
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, generateOpenaiYaml(front));
    written.push({ path: `${action.to}/${CODEX_SKILL_YAML}`, base });
  }
}