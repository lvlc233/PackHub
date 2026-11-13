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
import { dirname, join, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import * as tar from 'tar';
import type { Plan, PlanAction } from '@packhub/kernel';
import { canonicalize, deepMerge, diffActions, isPlainObject, sha256 } from '@packhub/kernel';
import { download, resolvePypiSdist } from './download.ts';
import { isSafeArchiveEntry } from './pack.ts';
import { generateOpenaiYaml, readSkillFrontmatter } from './skill-meta.ts';
import { resolveToken } from './credentials.ts';
import { assertApiVersion } from './apiVersion.ts';
import { removeClaudeMcp } from './host-mcp.ts';

export interface ApplyOptions {
  /** 目标目录：写到哪里、state 放哪里 */
  root: string;
  /** Pack 来源目录：`from` 读哪里；默认与 root 相同 */
  packRoot?: string;
  /** 允许执行安装期命令（默认拒绝） */
  allowExec?: boolean;
  /** 只计算不落盘 */
  dryRun?: boolean;
  /** 允许覆盖别的包已经写过的普通文件（默认拒绝） */
  overwrite?: boolean;
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
  apiVersion: 'packhub.dev/state/v0';
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
      written: string[];
      /** 持久状态目录：记下来供卸载与 doctor 使用；不放进 written，卸载默认不删 */
      stateDirs?: { id: string; path: string; retain: 'keep' | 'remove' }[];
      /** 由宿主 CLI 管理的全局 MCP（目前是 Claude Code user scope）；卸载时按名字摘掉 */
      hostMcp?: string[];
      /** 上一份计划快照，update 靠它算差异 */
      plan?: Plan;
    }
  >;
}

const STATE_API = 'packhub.dev/state/v0';

/** 一个已装版本的落盘记录：文件内容镜像 + 可重放的共享改动。 */
export interface VersionRecord {
  apiVersion: 'packhub.dev/version/v0';
  pack: string;
  version: string;
  target: Plan['target'];
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

export interface VersionInfo {
  pack: string;
  version: string;
  target: Plan['target'];
  planHash: string;
  installedAt: string;
  active: boolean;
  /** 版本目录里镜像了多少个文件 */
  files: number;
  /** 计划动作数；failed 是当时失败的动作数（正常安装应为 0） */
  actions: number;
  failed: number;
}

interface ActiveFile {
  apiVersion: 'packhub.dev/active/v0';
  packs: Record<string, { version: string; target: string; planHash: string; at: string }>;
}

const STATE_DIR = '.packhub';
const STATE_FILE = '.packhub/state.json';
const INSTALL_LOCK = '.packhub/installing.lock';
const VERSIONS_DIR = '.packhub/versions';
const ACTIVE_FILE = '.packhub/active.json';

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
  /** 装之前就存在、被改写的文件（回了要把原内容放回去） */
  existed: string[];
  /** 装之前不存在、这次新建的（回了要删掉） */
  created: string[];
}

function generationId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  // 毫秒 + 4 位随机后缀：同一秒内装两个包不会再撞进同一个快照目录
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${ms}-${rand}`;
}

/** 计划会写到哪些相对路径（含目录）；状态目录不算写入，不参与快照与卸载删除。 */
function touchedPaths(plan: Plan): string[] {
  const out: string[] = [];
  for (const a of plan.actions) {
    if (a.op === 'write' || a.op === 'unpack' || a.op === 'link.skill' || a.op === 'copy' || a.op === 'delete') out.push(a.to);
    else if (a.op === 'link.exec') out.push(a.to, `${a.to}.cmd`);
    else if (a.op === 'register.mcp') out.push(a.path ?? '.packhub/config.json');
    else if (a.op === 'instruction') out.push(a.file);
  }
  return [...new Set(out)];
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

function prepareGeneration(root: string, plan: Plan): Generation {
  const id = generationId();
  const dir = join(root, STATE_DIR, 'snapshots', id);
  const existed: string[] = [];
  const created: string[] = [];
  for (const rel of touchedPaths(plan)) {
    const abs = within(root, rel);
    if (existsSync(abs)) {
      const dest = join(dir, 'files', rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(abs, dest, { recursive: true, force: true });
      existed.push(rel);
    } else {
      created.push(rel);
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
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(gen, null, 2) + '\n', 'utf8');
  return gen;
}

export async function applyPlan(plan: Plan, opts: ApplyOptions): Promise<ApplyResult> {
  const release = opts.dryRun ? () => {} : acquireLock(opts.root);
  try {
  const outcomes: ActionOutcome[] = [];
  const written: string[] = [];
  const key = `${plan.pack.name}@${plan.pack.version}`;

  // 项目级所有权：同一路径不许被两个包各写一份（配置文件是指路的共享物，例外）
  const conflicts = findOwnershipConflicts(plan, key, opts.root);
  if (conflicts.length > 0 && !opts.overwrite) {
    throw new Error(
      `这些路径已被别的包占用：${conflicts.join('、')}；确认要覆盖就加 --overwrite`,
    );
  }

  const gen = opts.dryRun ? undefined : prepareGeneration(opts.root, plan);

  for (const action of plan.actions) {
    const blockedBy = (action.dependsOn ?? []).find((id) => {
      const status = outcomes.find((o) => o.actionId === id)?.status;
      return status !== 'done' && status !== 'noop';
    });
    if (blockedBy) {
      outcomes.push({
        actionId: action.actionId,
        op: action.op,
        status: 'skipped',
        message: `依赖 ${blockedBy} 未成功，跳过`,
      });
      continue;
    }
    try {
      outcomes.push(await applyAction(action, plan, opts, written));
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
  if (!opts.dryRun && plan.target === 'codex' && !outcomes.some((o) => o.status === 'failed')) {
    try {
      ensureCodexSkillYaml(opts.root, plan, written);
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
    // 把这次安装的产物镜像进版本目录：以后可以整版切换，而不是只能原地回退一步
    try {
      stageVersion(opts.root, plan, outcomes, written, opts.packRoot ?? opts.root);
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
    state.apiVersion = 'packhub.dev/state/v0';
    // 升级到新版本时把同名的旧记录并进来：written 取并集，旧 key 不留
    const oldKeys = Object.keys(state.packs).filter(
      (k) => k !== key && (k.split('@')[0] ?? '') === plan.pack.name,
    );
    const previous = [
      ...(state.packs[key]?.written ?? []),
      ...oldKeys.flatMap((k) => state.packs[k]?.written ?? []),
    ];
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
      written: [...new Set([...previous, ...written])],
      // 计划快照：update 靠它算出「多了什么、少了什么」
      plan,
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
  if (!existsSync(file)) return { apiVersion: 'packhub.dev/active/v0', packs: {} };
  let parsed: Partial<ActiveFile>;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ActiveFile>;
  } catch {
    return { apiVersion: 'packhub.dev/active/v0', packs: {} };
  }
  assertApiVersion(file, parsed, 'packhub.dev/active/v0');
  return { apiVersion: 'packhub.dev/active/v0', packs: parsed.packs ?? {} };
}

function writeActive(root: string, next: ActiveFile): void {
  const file = join(root, ACTIVE_FILE);
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(next, null, 2) + '\n');
}

function setActive(root: string, pack: string, version: string, planHash: string, target: string): void {
  const active = readActive(root);
  active.packs[pack] = { version, target, planHash, at: new Date().toISOString() };
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
  written: string[],
  packRoot: string,
): VersionRecord {
  const dir = versionDirOf(root, plan.pack.name, plan.pack.version);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'files'), { recursive: true });
  const files: string[] = [];
  for (const rel of touchedPaths(plan)) {
    if (isSharedPath(rel)) continue;
    const abs = within(root, rel);
    if (!existsSync(abs)) continue;
    // 版本镜像优先用硬链接共享字节；跨盘/不支持的文件系统退回复制
    linkTree(abs, join(dir, 'files', rel));
    files.push(rel);
  }
  const record: VersionRecord = {
    apiVersion: 'packhub.dev/version/v0',
    pack: plan.pack.name,
    version: plan.pack.version,
    target: plan.target,
    planHash: plan.planHash,
    installedAt: new Date().toISOString(),
    plan,
    actions: outcomes,
    written: [...written],
    files,
  };
  writeFileSync(join(dir, 'record.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
  setActive(root, plan.pack.name, plan.pack.version, plan.planHash, plan.target);
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
  if (!existsSync(file)) throw new Error(`没有这个版本：${pack}@${version}（用 packhub versions ${pack} 查看）`);
  const record = JSON.parse(readFileSync(file, 'utf8')) as VersionRecord;
  assertApiVersion(file, record, 'packhub.dev/version/v0');
  return record;
}

/** 列出所有可切换的版本，active 标记当前挂载的那个。 */
export function listVersions(root: string, pack?: string): VersionInfo[] {
  const base = join(root, VERSIONS_DIR);
  if (!existsSync(base)) return [];
  const active = readActive(root).packs;
  const out: VersionInfo[] = [];
  for (const packDir of readdirSync(base, { withFileTypes: true })) {
    if (!packDir.isDirectory()) continue;
    for (const verDir of readdirSync(join(base, packDir.name), { withFileTypes: true })) {
      if (!verDir.isDirectory()) continue;
      try {
        const record = JSON.parse(
          readFileSync(join(base, packDir.name, verDir.name, 'record.json'), 'utf8'),
        ) as VersionRecord;
        if (pack && record.pack !== pack) continue;
        out.push({
          pack: record.pack,
          version: record.version,
          target: record.target,
          planHash: record.planHash,
          installedAt: record.installedAt,
          active: active[record.pack]?.version === record.version,
          files: record.files?.length ?? 0,
          actions: record.actions?.length ?? 0,
          failed: (record.actions ?? []).filter((a) => a.status === 'failed').length,
        });
      } catch {
        /* 坏掉的版本目录跳过 */
      }
    }
  }
  return out.sort((a, b) => (a.pack === b.pack ? (a.installedAt < b.installedAt ? 1 : -1) : a.pack.localeCompare(b.pack)));
}

export interface ActivateResult {
  pack: string;
  from: string | null;
  to: string;
  removed: string[];
  written: string[];
}

/** 读一份文本文件；不存在、或不是普通文件（比如被占成了目录）就当原本没有。 */
function readTextIfFile(file: string): string | undefined {
  try {
    return lstatSync(file).isFile() ? readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/** 把一份文本恢复原样；原本没有就删掉自己写出来的那个文件，不动别的。 */
function restoreText(file: string, before: string | undefined): void {
  if (before !== undefined) {
    // 已经和原来一样就不碰它：省一次写，也免得撞上只读文件
    try {
      if (readFileSync(file, 'utf8') === before) return;
    } catch {
      /* 读不了就照写 */
    }
    writeFileSync(file, before, 'utf8');
    return;
  }
  try {
    if (lstatSync(file).isFile()) rmSync(file, { force: true });
  } catch {
    /* 原本就没有 */
  }
}

/**
 * 把某个已装版本挂到项目上：拆掉当前版本的产物，铺开目标版本的镜像，
 * 再重放配置与会话指令。整次切换在锁里做，失败按快照恢复。
 */
export async function activatePack(root: string, pack: string, version: string): Promise<ActivateResult> {
  const release = acquireLock(root);
  try {
    const record = readVersionRecord(root, pack, version);
    const state = loadState(root);
    const fromKey = Object.keys(state.packs).find((k) => (k.split('@')[0] ?? '') === pack);
    const previous = fromKey ? state.packs[fromKey] : undefined;

    // 快照要覆盖「旧版本留下、新版本不再产出」的文件，否则切换失败会留下半套
    const snapshotPlan: Plan = {
      ...record.plan,
      actions: [...(previous?.plan?.actions ?? []), ...record.plan.actions],
    };
    // 失败时这两份也要退回去：只恢复文件会留下「文件是旧的、记录说新的」
    const before = {
      state: readTextIfFile(join(root, STATE_FILE)),
      active: readTextIfFile(join(root, ACTIVE_FILE)),
    };
    const gen = prepareGeneration(root, snapshotPlan);
    const keep = touchedPaths(record.plan);
    const removed = previous?.plan
      ? deactivatePlan(root, previous.plan, previous.actions, keep)
      : [];

    const snapshotDir = join(root, STATE_DIR, 'snapshots', gen.id);
    try {
      materialize(root, record);
      const actions = await replayShared(root, record);
      if (fromKey) delete state.packs[fromKey];
      state.packs[`${record.pack}@${record.version}`] = {
        pack: record.pack,
        version: record.version,
        planHash: record.planHash,
        installedAt: record.installedAt,
        actions,
        written: [...record.written],
        plan: record.plan,
      };
      state.generations = [...(state.generations ?? []), gen].slice(-5);
      pruneSnapshots(root, state.generations);
      writeFileSync(join(root, STATE_FILE), JSON.stringify(state, null, 2) + '\n', 'utf8');
      setActive(root, record.pack, record.version, record.planHash, record.target);
    } catch (err) {
      restoreGeneration(root, gen);
      const rollbackErrors: string[] = [];
      for (const [file, text] of [
        [join(root, STATE_FILE), before.state],
        [join(root, ACTIVE_FILE), before.active],
      ] as const) {
        try {
          restoreText(file, text);
        } catch (restoreErr) {
          rollbackErrors.push(`${file}：${(restoreErr as Error).message}`);
        }
      }
      rmSync(snapshotDir, { recursive: true, force: true });
      if (rollbackErrors.length > 0) {
        throw new Error(
          `${(err as Error).message}；切换失败但记录没退回去（${rollbackErrors.join('；')}），先看 state 与 active`,
        );
      }
      throw err;
    }

    return {
      pack: record.pack,
      from: fromKey ?? null,
      to: `${record.pack}@${record.version}`,
      removed,
      written: record.files,
    };
  } finally {
    release();
  }
}

/** 把版本目录里的文件镜像铺回项目。 */
function materialize(root: string, record: VersionRecord): void {
  const src = join(versionDirOf(root, record.pack, record.version), 'files');
  for (const rel of record.files) {
    const from = join(src, rel);
    if (!existsSync(from)) continue;
    const to = within(root, rel);
    if (lstatSync(from).isDirectory()) replaceTree(from, to);
    else linkFileAtomic(from, to);
  }
}

/** 重放这个版本的共享改动；文件镜像已经在 materialize 里铺好。 */
async function replayShared(root: string, record: VersionRecord): Promise<ActionOutcome[]> {
  const outcomes: ActionOutcome[] = [];
  const scratch: string[] = [];
  const opts: ApplyOptions = { root, packRoot: root };
  for (const action of record.plan.actions) {
    if (action.op === 'register.mcp' || action.op === 'instruction') {
      outcomes.push(await applyAction(action, record.plan, opts, scratch));
      continue;
    }
    if (action.op === 'state.dir') {
      mkdirSync(within(root, action.to), { recursive: true });
      outcomes.push({ actionId: action.actionId, op: action.op, status: 'done', target: action.to });
      continue;
    }
    if (action.op === 'exec') {
      outcomes.push({
        actionId: action.actionId,
        op: action.op,
        status: 'noop',
        message: '激活时不重跑安装期命令',
      });
      continue;
    }
    const target = 'to' in action ? action.to : 'dest' in action ? action.dest : undefined;
    outcomes.push({ actionId: action.actionId, op: action.op, status: 'done', target });
  }
  return outcomes;
}

/**
 * 拆掉旧版本的产物：文件删掉、配置按 undo 还原、MCP 条目摘掉、指令块摘掉。
 * `keep` 是新版本仍会产出的路径——重叠部分让新版本覆盖，不先删。
 */
function deactivatePlan(
  root: string,
  plan: Plan,
  actions: ActionOutcome[],
  keep: string[],
): string[] {
  const removed: string[] = [];
  const byId = new Map(actions.map((o) => [o.actionId, o]));
  const keptBy = (rel: string): boolean =>
    keep.some((p) => p === rel || rel.startsWith(`${p}/`) || p.startsWith(`${rel}/`));
  const configs: { path: string; ops: { path: string[]; had: boolean; value?: unknown }[] }[] = [];
  const servers: { path: string; resource: string }[] = [];
  const blocks: { file: string; blockId: string }[] = [];

  for (const action of plan.actions) {
    if (
      action.op === 'write' ||
      action.op === 'link.skill' ||
      action.op === 'unpack' ||
      action.op === 'copy' ||
      action.op === 'link.exec'
    ) {
      if (keptBy(action.to)) continue;
      const withCmd = action.op === 'link.exec';
      for (const rel of withCmd ? [action.to, `${action.to}.cmd`] : [action.to]) {
        const abs = within(root, rel);
        if (!existsSync(abs)) continue;
        rmSync(abs, { recursive: true, force: true });
        removed.push(rel);
      }
      continue;
    }
    if (action.op === 'register.mcp') {
      servers.push({ path: action.path ?? '.packhub/config.json', resource: action.resource ?? 'mcp' });
      continue;
    }
    if (action.op === 'instruction') blocks.push({ file: action.file, blockId: action.blockId });
  }


  for (const { path: rel, resource } of servers) {
    const abs = within(root, rel);
    if (!existsSync(abs)) continue;
    if (/\.toml$/i.test(rel)) {
      const text = stripMcpToml(readFileSync(abs, 'utf8'), resource);
      if (text.trim() === '') rmSync(abs, { force: true });
      else writeFileSync(abs, text, 'utf8');
      removed.push(rel);
      continue;
    }
    const data = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
    const list = { ...(data.mcpServers as Record<string, unknown> | undefined) };
    delete list[resource];
    if (Object.keys(list).length === 0) delete data.mcpServers;
    else data.mcpServers = list;
    const pruned = pruneEmpty(data);
    if (Object.keys(pruned).length === 0) rmSync(abs, { force: true });
    else writeFileSync(abs, JSON.stringify(pruned, null, 2) + '\n', 'utf8');
    removed.push(rel);
  }

  for (const { file, blockId } of blocks) {
    const abs = within(root, file);
    if (!existsSync(abs)) continue;
    const text = stripBlock(readFileSync(abs, 'utf8'), blockId);
    if (text.trim() === '') rmSync(abs, { force: true });
    else writeFileSync(abs, text, 'utf8');
    removed.push(file);
  }

  return removed;
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
    // 激活指针也要跟着退回：否则 versions 会显示一个已经不在盘上的版本
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
  for (const rel of gen.existed) {
    const src = join(dir, 'files', rel);
    if (!existsSync(src)) continue;
    const abs = within(root, rel);
    if (lstatSync(src).isDirectory()) replaceTree(src, abs);
    else copyFileAtomic(src, abs);
    restored.push(rel);
  }

  const removed: string[] = [];
  for (const rel of [...gen.created].sort((a, b) => b.length - a.length)) {
    const abs = within(root, rel);
    if (!existsSync(abs)) continue;
    rmSync(abs, { recursive: true, force: true });
    removed.push(rel);
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
        const abs = within(root, spec.path);
        if (!existsSync(abs)) continue;
        if (spec.retain === 'remove') {
          rmSync(abs, { recursive: true, force: true });
          removed.push(spec.path);
        } else {
          kept.push(spec.path);
        }
      }
      const files = [...record.written].sort((a, b) => b.length - a.length);
      for (const rel of files) {
        if (rel === '.packhub/config.json' && !isLast) {
          kept.push(rel);
          continue;
        }
        const abs = within(root, rel);
        if (!existsSync(abs)) continue;

        // 配置文件是共享的：先按 merge 的 undo 还原键，再摘掉自己登记的 server 条目，不整文件删
        const regs = record.actions.filter((a) => a.op === 'register.mcp' && a.target === rel && a.resource);
        if (regs.length > 0 && /\.toml$/i.test(rel)) {
          let text = readFileSync(abs, 'utf8');
          for (const a of regs) text = stripMcpToml(text, a.resource as string);
          if (text.trim() === '') rmSync(abs, { force: true });
          else writeFileSync(abs, text, 'utf8');
          removed.push(rel);
          continue;
        }
        if (regs.length > 0 && /\.json$/i.test(rel)) {
          const data = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
          const servers = { ...(data.mcpServers as Record<string, unknown> | undefined) };
          for (const a of regs) delete servers[a.resource as string];
          if (Object.keys(servers).length === 0) delete data.mcpServers;
          else data.mcpServers = servers;
          const pruned = pruneEmpty(data);
          if (Object.keys(pruned).length === 0) rmSync(abs, { force: true });
          else writeFileSync(abs, JSON.stringify(pruned, null, 2) + '\n', 'utf8');
          removed.push(rel);
          continue;
        }

        // 指令文件是用户也会写的：只摘掉自己的托管块，不整文件删
        const blockIds = record.actions
          .filter((a) => a.op === 'instruction' && a.target === rel && a.blockId)
          .map((a) => a.blockId as string);
        if (blockIds.length > 0) {
          let text = readFileSync(abs, 'utf8');
          for (const id of blockIds) text = stripBlock(text, id);
          if (text.trim() === '') rmSync(abs, { force: true });
          else writeFileSync(abs, text, 'utf8');
          removed.push(rel);
          continue;
        }

        rmSync(abs, { recursive: true, force: true });
        removed.push(rel);
      }
      // 从 registry 装进来的包会留一份清单副本；卸载时一起清掉
      const packName = key.split('@')[0] ?? '';
      if (packName) {
        const copy = within(root, join(STATE_DIR, 'packs', packName));
        if (existsSync(copy)) rmSync(copy, { recursive: true, force: true });
      }
      delete state.packs[key];
      // 没有任何版本记录留下时，把整个版本目录与激活项一并摘掉
      if (packName && !Object.keys(state.packs).some((k) => (k.split('@')[0] ?? '') === packName)) {
        const versions = within(root, join(VERSIONS_DIR, packSlug(packName)));
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

async function applyAction(
  action: PlanAction,
  plan: Plan,
  opts: ApplyOptions,
  written: string[],
): Promise<ActionOutcome> {
  switch (action.op) {
    case 'fetch': {
      const dest = within(opts.root, action.dest);
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
      written.push(action.dest);
      return {
        actionId: action.actionId,
        op: action.op,
        status: 'done',
        target: action.dest,
        message: `${Math.max(1, Math.round(res.bytes / 1024))} KB · ${res.integrity.slice(0, 14)}…`,
      };
    }

    case 'unpack': {
      const from = readable(opts.packRoot ?? opts.root, action.from);
      const to = within(opts.root, action.to);
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
      written.push(action.to);
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
      const cwd = action.cwd ? within(opts.root, action.cwd) : within(opts.root, '.');
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
      const from = readable(opts.packRoot ?? opts.root, action.from);
      const to = within(opts.root, action.to);
      if (!existsSync(from)) {
        throw new Error(`skill 源目录不存在：${action.from}`);
      }
      if (opts.dryRun) return { actionId: action.actionId, op: action.op, status: 'done' };
      mkdirSync(dirname(to), { recursive: true });
      // 覆盖安装时先移除旧的 skill 目录：文件可能是版本镜像的硬链接
      rmSync(to, { recursive: true, force: true });
      cpSync(from, to, { recursive: true, force: true });
      written.push(action.to);
      return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
    }

    case 'copy': {
      const from = readable(opts.packRoot ?? opts.root, action.from);
      const to = within(opts.root, action.to);
      if (!existsSync(from)) throw new Error(`copy 的来源不存在：${action.from}`);
      if (!opts.dryRun) {
        mkdirSync(dirname(to), { recursive: true });
        rmSync(to, { recursive: true, force: true });
        cpSync(from, to, { recursive: true, force: true });
        written.push(action.to);
      }
      return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
    }

    case 'link.exec': {
      const entry = within(opts.root, action.entry);
      const modulePath = action.module ? within(opts.root, action.module) : undefined;
      if (!existsSync(entry)) throw new Error(`工具入口不存在：${action.entry}`);
      if (modulePath && !existsSync(modulePath)) throw new Error(`工具模块不存在：${action.module}`);
      const to = within(opts.root, action.to);
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
      written.push(action.to);
      if (process.platform === 'win32') {
        writeFileAtomic(`${to}.cmd`, `@echo off\r\nrem generated by packhub\r\n${winEnv}${line} %*\r\n`);
        written.push(`${action.to}.cmd`);
      }
      return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
    }

    case 'delete': {
      const to = within(opts.root, action.to);
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
      const to = within(opts.root, action.to);
      // 覆盖层可能带二进制文件（图片、字体、脚本），不能一律按 UTF-8 读
      if (action.content === undefined && action.from) {
        const raw = readFileSync(readable(opts.packRoot ?? opts.root, action.from));
        const binary = raw.subarray(0, 8192).includes(0);
        if (binary) {
          if (existsSync(to) && readFileSync(to).equals(raw)) {
            return { actionId: action.actionId, op: action.op, status: 'noop', target: action.to };
          }
          if (!opts.dryRun) {
            mkdirSync(dirname(to), { recursive: true });
            copyFileAtomic(readable(opts.packRoot ?? opts.root, action.from), to);
            written.push(action.to);
          }
          return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
        }
      }
      const content =
        action.content !== undefined
          ? action.content
          : readFileSync(readable(opts.packRoot ?? opts.root, action.from ?? ''), 'utf8');
      if (existsSync(to) && readFileSync(to, 'utf8') === content) {
        return { actionId: action.actionId, op: action.op, status: 'noop', target: action.to };
      }
      if (!opts.dryRun) {
        mkdirSync(dirname(to), { recursive: true });
        writeFileAtomic(to, content);
        written.push(action.to);
      }
      return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
    }

    case 'register.mcp': {
      const path = action.path ?? '.packhub/config.json';
      const to = within(opts.root, path);
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
          if (before) backup(opts.root, path, before);
          writeFileAtomic(to, next);
          if (!written.includes(path)) written.push(path);
        }
        return {
          actionId: action.actionId,
          op: action.op,
          status: 'done',
          target: path,
          resource: action.resource ?? 'mcp',
        };
      }
      const current = (existsSync(to) ? readStructured(to) : {}) as Record<string, unknown>;
      const servers = { ...(current.mcpServers as Record<string, unknown> | undefined) } as Record<string, unknown>;
      const key = action.resource ?? 'mcp';
      const nextServer = { ...(servers[key] as object | undefined), ...action.spec };
      const merged = deepMerge(current, { mcpServers: { [key]: nextServer } });
      const nextText = JSON.stringify(merged, null, 2) + '\n';
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
        if (before) backup(opts.root, path, before);
        writeFileAtomic(to, nextText);
        if (!written.includes(path)) written.push(path);
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
      const to = within(opts.root, action.file);
      const before = existsSync(to) ? readFileSync(to, 'utf8') : '';
      const next = upsertBlock(before, action.blockId, action.content);
      if (before === next) {
        return { actionId: action.actionId, op: action.op, status: 'noop', target: action.file };
      }
      if (!opts.dryRun) {
        mkdirSync(dirname(to), { recursive: true });
        if (before) backup(opts.root, action.file, before);
        writeFileAtomic(to, next);
        if (!written.includes(action.file)) written.push(action.file);
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
      const to = within(opts.root, action.to);
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
      // 认不出的动作说明 state 或锁是旧版本留下的：直接失败，别静默跳过
      const unknown = action as { op: string; actionId: string };
      throw new Error(
        `认不出的动作：${unknown.op}（${unknown.actionId}）；很可能是旧版本留下的 state 或锁，重新安装这个包`,
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


function backup(root: string, relPath: string, content: string): void {
  const dest = within(root, join(STATE_DIR, 'backups', sha256(content).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12), relPath));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content, 'utf8');
}

function within(root: string, relPath: string): string {
  const base = resolve(root);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`路径越界，拒绝写入：${relPath}`);
  }
  return target;
}

/**
 * 只读取源文件时用的定位：extends 会让父包的本地资源落在包目录之外，
 * 读它不产生写入越界；写目标仍然走 within。
 */
function readable(root: string, relPath: string): string {
  if (relPath.startsWith('../') || relPath.startsWith('..\\')) return resolve(root, relPath);
  return within(root, relPath);
}

export function loadState(root: string): State {
  const file = join(root, STATE_FILE);
  if (!existsSync(file)) return { apiVersion: STATE_API, packs: {} };
  let parsed: Partial<State>;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<State>;
  } catch (err) {
    throw new Error(`state 损坏：${file}（${(err as Error).message}）；先备份再删除或修复后重试`);
  }
  // 早期 state 没有 apiVersion：补上而不是拒绝——它是本机缓存，不是发布契约
  // 但写了别的主版本就是另一份格式：拒绝，按契约不猜字段
  assertApiVersion(file, parsed, STATE_API);
  return {
    apiVersion: STATE_API,
    ...(parsed.generations ? { generations: parsed.generations } : {}),
    packs: parsed.packs ?? {},
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

/** 共享路径：配置文件（多个包合并）与根目录的指令文件（托管块各写各的）。 */
function isSharedPath(rel: string): boolean {
  if (/\.(json|jsonc|toml)$/i.test(rel)) return true;
  return !rel.includes('/') && /\.md$/i.test(rel);
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
  previous: Plan,
  next: Plan,
  previousActions: ActionOutcome[] = [],
): PruneResult {
  const { removed: gone } = diffActions(previous.actions, next.actions);
  const produced = new Set(touchedPaths(next));
  for (const action of next.actions) {
    if (action.op === 'fetch') produced.add(action.dest);
  }
  const newMcp = new Set(
    next.actions.filter((a) => a.op === 'register.mcp').map((a) => a.resource ?? 'mcp'),
  );
  const newBlocks = new Set(
    next.actions.filter((a) => a.op === 'instruction').map((a) => `${a.file}::${a.blockId}`),
  );
  const outcomes = new Map(previousActions.map((o) => [o.actionId, o]));
  const removed: string[] = [];
  const kept: string[] = [];
  const warnings: string[] = [];

  /** 新计划还要产出这个路径（或它的子路径）时不能删。 */
  const stillProduced = (rel: string): boolean =>
    [...produced].some((p) => p === rel || rel.startsWith(`${p}/`) || p.startsWith(`${rel}/`));

  for (const action of gone) {
    if (
      action.op === 'write' ||
      action.op === 'link.skill' ||
      action.op === 'unpack' ||
      action.op === 'copy' ||
      action.op === 'link.exec' ||
      action.op === 'fetch'
    ) {
      const rel = action.op === 'fetch' ? action.dest : action.to;
      if (isSharedPath(rel) || stillProduced(rel)) {
        kept.push(rel);
        continue;
      }
      const withCmd = action.op === 'link.exec';
      for (const targetRel of withCmd ? [rel, `${rel}.cmd`] : [rel]) {
        const abs = within(root, targetRel);
        if (existsSync(abs)) {
          rmSync(abs, { recursive: true, force: true });
          removed.push(targetRel);
        }
      }
      continue;
    }

    if (action.op === 'state.dir') {
      // 状态目录是数据，不是产物：新版本去掉声明也只提示，不删
      kept.push(action.to);
      warnings.push(`状态目录保留（数据不随升级删除）：${action.to}`);
      continue;
    }

    if (action.op === 'register.mcp') {
      const outcome = outcomes.get(action.actionId);
      const server = outcome?.resource ?? action.resource ?? 'mcp';
      if (newMcp.has(server)) {
        kept.push(action.path ?? '.packhub/config.json');
        continue;
      }
      const path = action.path ?? '.packhub/config.json';
      const abs = within(root, path);
      if (!existsSync(abs)) continue;
      if (/\.toml$/i.test(path)) {
        let text = readFileSync(abs, 'utf8');
        text = stripMcpToml(text, server);
        if (text.trim() === '') rmSync(abs, { force: true });
        else writeFileSync(abs, text, 'utf8');
        removed.push(path);
        continue;
      }
      const data = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
      const servers = { ...(data.mcpServers as Record<string, unknown> | undefined) };
      delete servers[server];
      if (Object.keys(servers).length === 0) delete data.mcpServers;
      else data.mcpServers = servers;
      const pruned = pruneEmpty(data);
      if (Object.keys(pruned).length === 0) rmSync(abs, { force: true });
      else writeFileSync(abs, JSON.stringify(pruned, null, 2) + '\n', 'utf8');
      removed.push(path);
      continue;
    }

    if (action.op === 'instruction') {
      if (newBlocks.has(`${action.file}::${action.blockId}`)) {
        kept.push(action.file);
        continue;
      }
      const abs = within(root, action.file);
      if (!existsSync(abs)) continue;
      const text = stripBlock(readFileSync(abs, 'utf8'), action.blockId);
      if (text.trim() === '') rmSync(abs, { force: true });
      else writeFileSync(abs, text, 'utf8');
      removed.push(action.file);
    }
  }

  if (removed.length > 0) {
    const state = loadState(root);
    const record = state.packs[`${next.pack.name}@${next.pack.version}`];
    if (record) {
      record.written = record.written.filter((w) => !removed.includes(w));
      writeFileSync(join(root, STATE_FILE), JSON.stringify(state, null, 2) + '\n', 'utf8');
    }
  }

  return { removed, kept, warnings };
}

/** 这次安装要写的路径里，哪些已经被别的包占了。 */
function findOwnershipConflicts(plan: Plan, key: string, root: string): string[] {
  const state = loadState(root);
  const owners = new Map<string, string>();
  const selfName = key.split('@')[0] ?? '';
  for (const [packKey, record] of Object.entries(state.packs)) {
    if (packKey === key) continue;
    // 同一个包的旧版本不算冲突：升级本来就该覆盖自己
    if ((packKey.split('@')[0] ?? '') === selfName) continue;
    for (const rel of record.written) owners.set(rel, packKey);
    for (const spec of record.stateDirs ?? []) owners.set(spec.path, packKey);
  }
  const out: string[] = [];
  const targets = [...touchedPaths(plan), ...stateDirSpecs(plan).map((s) => s.path)];
  for (const rel of targets) {
    if (isSharedPath(rel)) continue;
    // 目录整体归一个包时，另一个包往目录里写文件同样算冲突
    for (const [owned, owner] of owners) {
      if (rel === owned || rel.startsWith(`${owned}/`) || owned.startsWith(`${rel}/`)) {
        out.push(`${rel}（${owner} 拥有 ${owned}）`);
        break;
      }
    }
  }
  return out;
}

/** 给 codex 目标下的 skill 补 agents/openai.yaml；已有就尊重源内容。 */
function ensureCodexSkillYaml(root: string, plan: Plan, written: string[]): void {
  for (const action of plan.actions) {
    if (action.op !== 'link.skill') continue;
    const dir = within(root, action.to);
    const file = join(dir, 'agents', 'openai.yaml');
    if (existsSync(file)) continue;
    let front;
    try {
      front = readSkillFrontmatter(dir);
    } catch {
      continue; // 不是标准 skill 的目录（比如用户手放的）不强行生成
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, generateOpenaiYaml(front));
    written.push(`${action.to}/agents/openai.yaml`);
  }
}