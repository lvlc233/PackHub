import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { planFor, type PackContext, type Plan, type TargetId } from '@packhub/kernel';
import {
  installPack,
  loadLock,
  loadPack,
  loadState,
  removePack,
  saveState,
  withLockPins,
} from '@packhub/runtime';
import { ADAPTERS, HARNESS_IDS, targetVarsFor } from './layout.ts';
import { PalError } from './errors.ts';
import { isPidAlive, killTree, waitForExit } from './process.ts';
import { clearStopping, markStopping } from './stopMark.ts';
import { archiveRoot, failedRoot, instancesRoot, newId, quarantineRoot, stamp } from './paths.ts';

export const RECORD = 'instance.json';
export const BASELINE = 'baseline.json';
export const API_VERSION = 'packhub.dev/instance/v1';

export type InstanceStatus =
  | 'installing'
  | 'installed'
  | 'running'
  | 'stopped'
  | 'broken'
  | 'failed';

export interface InstanceRecord {
  apiVersion: typeof API_VERSION;
  /** 与名字无关的身份 */
  id: string;
  name: string;
  harness: TargetId;
  /** 宿主自己的版本；探测不到就不写 */
  harnessVersion?: string;
  /** 实例根：配置、数据、缓存、会话都在它下面 */
  root: string;
  /** 实例自己的 home 段（dsh: DSH_HOME）；dir 没有 */
  home?: string;
  pack: { name: string; version: string; ref?: string };
  planHash: string;
  createdAt: string;
  updatedAt: string;
  status: InstanceStatus;
  /** 这个根是 PAL 建的（false = 接管已有目录）：只有 true 才允许整根删除 */
  managed: boolean;
  /** 从哪来：pack 引用、接管目录或复制；导出模板只认 kind='pack' 且有 ref */
  origin?: { kind: 'pack' | 'adopted' | 'copy'; ref?: string; dir?: string; from?: string; seededFrom?: string };
  /** 运行中的进程与端口；停掉后清空。url 已摘掉凭据，凭据在 secrets.json */
  pid?: number;
  port?: number;
  /** 启动时分配过的端口（旧到新），排障用 */
  ports?: number[];
  url?: string;
  startedAt?: string;
  /** 最近一次运行结束的原因；崩溃诊断看这里 */
  lastExit?: { code: number | null; signal: NodeJS.Signals | null; at: string; restarts: number };
  lastError?: { code: string; message: string; at: string };
  /** on-failure 时由 PAL 的守护重起；默认 never */
  restart?: 'never' | 'on-failure';
  maxRestarts?: number;
}

export interface CreateInstanceOptions {
  name: string;
  harness: TargetId;
  /** 已经落到本地的 Pack 目录 */
  packDir: string;
  /** 实例根；不写就建在 instances 根下的新目录里 */
  root?: string;
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
}

/** 从已有 home 带过来时不搬的东西：会话、缓存、附件、运行时、库文件、profile（带绝对路径）。 */
const SEED_SKIP = new Set(['sessions', 'cache', 'attachments', 'dsh-runtimes', 'storages', 'profiles', 'logs']);

/**
 * 把已有 home 里的凭据/指令补进实例 home：只补空缺，已存在的路径一律不动。
 * 先装 Pack 再 seed，所以 Pack 写好的 AGENTS.md、skills 不会被全局那份盖掉。
 */
export function seedHome(from: string, to: string): string[] {
  const source = resolve(from);
  if (!existsSync(source)) {
    throw new PalError('not-found', `这个 home 不存在：${source}`);
  }
  const copied: string[] = [];
  const walk = (src: string, dest: string, name: string): void => {
    const stat = statSync(src);
    if (stat.isDirectory()) {
      if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
      for (const entry of readdirSync(src, { withFileTypes: true })) {
        if (SEED_SKIP.has(entry.name)) continue;
        walk(join(src, entry.name), join(dest, entry.name), entry.name);
      }
      return;
    }
    if (existsSync(dest)) return;
    try {
      cpSync(src, dest, { force: false, errorOnExist: false });
    } catch {
      /* 单个文件搬不过来不影响建实例 */
    }
  };
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (SEED_SKIP.has(entry.name)) continue;
    const before = existsSync(join(to, entry.name));
    walk(join(source, entry.name), join(to, entry.name), entry.name);
    if (!before || entry.isDirectory()) copied.push(entry.name);
  }
  return copied;
}

/** 实例根清单：正常记录 + 坏记录（坏记录不静默消失，移进隔离区并留下原因）。 */
export interface InstanceScan {
  records: InstanceRecord[];
  broken: Array<{ dir: string; reason: string; quarantined?: string; link?: string }>;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/* ---------- 记录读写 ---------- */

export function recordFile(root: string): string {
  return join(root, RECORD);
}

function parseRecord(root: string, text: string): InstanceRecord {
  const data = JSON.parse(text) as InstanceRecord;
  if (!data || typeof data !== 'object' || typeof data.id !== 'string' || typeof data.name !== 'string') {
    throw new Error('记录缺字段');
  }
  const harness = (data.harness ?? 'dir') as TargetId;
  const normalized: InstanceRecord = {
    ...data,
    apiVersion: API_VERSION,
    harness,
    root: data.root ?? root,
    updatedAt: data.updatedAt ?? data.createdAt ?? nowIso(),
    managed: data.managed ?? true,
    ports: Array.isArray(data.ports) ? data.ports : [],
    pack: data.pack ?? { name: 'unknown', version: '0.0.0' },
  };
  return normalized;
}

export interface RecordRead {
  record?: InstanceRecord;
  error?: string;
}

/** 读一份记录；坏记录给出原因，由调用方决定隔离还是跳过。 */
export function readRecordResult(root: string): RecordRead {
  const file = recordFile(root);
  if (!existsSync(file)) return { error: '没有 instance.json' };
  try {
    return { record: parseRecord(root, readFileSync(file, 'utf8')) };
  } catch (err) {
    return { error: `instance.json 读不了：${(err as Error).message}` };
  }
}

export function readRecord(root: string): InstanceRecord | undefined {
  return readRecordResult(root).record;
}

/** 原子写：临时文件 + rename。写到一半崩溃只会留临时文件，不会留半份配置。 */
export function writeInstance(record: InstanceRecord): void {
  const next: InstanceRecord = { ...record, apiVersion: API_VERSION, updatedAt: nowIso() };
  const file = recordFile(record.root);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 临时文件删不掉就留着，不影响主流程 */
    }
    throw err;
  }
  record.updatedAt = next.updatedAt;
  writeLink(next);
}

/* ---------- 隔离与归档 ---------- */

function moveAside(from: string, dir: string, meta: Record<string, unknown>): string | undefined {
  const target = join(dir, `${basename(from)}-${stamp()}`);
  try {
    mkdirSync(dir, { recursive: true });
    renameSync(from, target);
    writeFileSync(join(target, 'reason.json'), JSON.stringify({ at: nowIso(), ...meta }, null, 2) + '\n', 'utf8');
    return target;
  } catch {
    return undefined;
  }
}

/** 坏记录隔离：移出实例列表，保留现场和原因，可以人工搬回来。 */
export function quarantineInstance(root: string, reason: string, link?: string): string | undefined {
  if (link) {
    // 记录在用户的目录里：只收走指针与原因，用户的目录一个字节都不动
    const dir = join(quarantineRoot(), `${basename(root)}-${stamp()}`);
    try {
      mkdirSync(dir, { recursive: true });
      renameSync(link, join(dir, 'link.json'));
      writeFileSync(join(dir, 'reason.json'), JSON.stringify({ at: nowIso(), reason, from: root }, null, 2) + '\n', 'utf8');
      return dir;
    } catch {
      return undefined;
    }
  }
  return moveAside(root, quarantineRoot(), { reason, from: root });
}

/** 建实例失败时的现场：整根移到 .failed，不留半个实例在列表里。 */
export function failInstance(root: string, error: { code: string; message: string }): string | undefined {
  return moveAside(root, failedRoot(), error);
}

/* ---------- 列表 ---------- */

function linksDir(): string {
  return join(instancesRoot(), '.links');
}

function linkFile(id: string): string {
  return join(linksDir(), `${id}.json`);
}

function insideInstances(dir: string): boolean {
  const base = resolve(instancesRoot());
  const target = resolve(dir);
  return target === base || target.startsWith(base + sep) || target.startsWith(base + '/');
}

/**
 * 接管的目录在实例根之外：记录仍然写在那个目录里（root 就是身份），
 * 另外在 .links 留一个指针，列表才找得到它。删指针不动用户的目录。
 */
function writeLink(record: InstanceRecord): void {
  const file = linkFile(record.id);
  if (insideInstances(record.root)) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(linksDir(), { recursive: true });
  writeFileSync(file, JSON.stringify({ id: record.id, name: record.name, root: record.root }, null, 2) + '\n', 'utf8');
}

function removeLink(id: string): void {
  rmSync(linkFile(id), { force: true });
}

/** 扫实例根；坏记录只报告不移动（读操作不该有副作用）。 */
export function scanInstances(): InstanceScan {
  const base = instancesRoot();
  if (!existsSync(base)) return { records: [], broken: [] };
  const records: InstanceRecord[] = [];
  const broken: InstanceScan['broken'] = [];
  const seen = new Set<string>();
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(base, entry.name);
    const read = readRecordResult(dir);
    if (read.record) {
      records.push(read.record);
      seen.add(read.record.id);
    } else {
      broken.push({ dir, reason: read.error ?? '未知原因' });
    }
  }
  // 接管来的实例：记录在用户目录里，列表靠 .links 找到
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name !== '.links') continue;
    for (const link of safeFiles(join(base, entry.name))) {
      try {
        const data = JSON.parse(readFileSync(link.file, 'utf8')) as { id?: string; root?: string };
        if (!data.id || !data.root) throw new Error('指针缺字段');
        if (seen.has(data.id)) continue;
        const read = readRecordResult(data.root);
        if (read.record) {
          records.push(read.record);
          seen.add(read.record.id);
        } else {
          broken.push({ dir: data.root, reason: read.error ?? '未知原因', link: link.file });
        }
      } catch (err) {
        broken.push({ dir: link.file, reason: `指针读不了：${(err as Error).message}`, link: link.file });
      }
    }
  }
  records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { records, broken };
}

function safeFiles(dir: string): Array<{ file: string }> {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({ file: join(dir, entry.name) }));
  } catch {
    return [];
  }
}

/** 列出实例；坏记录默认移进隔离区，不再从列表里凭空消失。 */
export function listInstances(opts: { quarantine?: boolean } = {}): InstanceRecord[] {
  const scan = scanInstances();
  if (opts.quarantine === false) return scan.records;
  for (const bad of scan.broken) {
    const moved = quarantineInstance(bad.dir, bad.reason, bad.link);
    if (moved) bad.quarantined = moved;
  }
  return scan.records;
}

export function readInstance(nameOrId: string): InstanceRecord | undefined {
  return listInstances().find((i) => i.id === nameOrId || i.name === nameOrId);
}

export function requireInstance(nameOrId: string): InstanceRecord {
  const record = readInstance(nameOrId);
  if (!record) {
    throw new PalError('unknown-instance', `没有这个实例：${nameOrId}`, {
      hint: 'pal list 看现有实例',
      details: { target: nameOrId },
    });
  }
  return record;
}

/* ---------- 当前实例（每个宿主一个默认） ---------- */

type ActiveMap = Record<string, string>;

export function activeMapPath(): string {
  return join(instancesRoot(), '.active.json');
}

export function readActiveMap(): ActiveMap {
  const file = activeMapPath();
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as ActiveMap;
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function writeActiveMap(map: ActiveMap): void {
  mkdirSync(instancesRoot(), { recursive: true });
  const file = activeMapPath();
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

function dropActive(id: string): void {
  const map = readActiveMap();
  let touched = false;
  for (const [harness, value] of Object.entries(map)) {
    if (value === id) {
      delete map[harness];
      touched = true;
    }
  }
  if (touched) writeActiveMap(map);
}

/* ---------- lock ---------- */

const LOCK = '.pal-lock.json';

interface LockInfo {
  pid: number;
  op: string;
  at: string;
}

class InstanceBusy extends PalError {
  constructor(root: string, holder: LockInfo) {
    super('busy', `实例正在被另一个 PAL 进程操作：${holder.op}（pid ${holder.pid}）`, {
      hint: '等它结束；确认那个进程已经不在了就删掉实例根里的 .pal-lock.json',
      details: { root, holder },
    });
  }
}

function readLock(root: string): LockInfo | undefined {
  const file = join(root, LOCK);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

/**
 * 抢实例锁：拿到返回 true；本进程已持有返回 false（嵌套直接执行，不再写锁）。
 * 锁里记 pid：持有者已经不在了当陈旧锁清掉，不让崩溃永久锁死实例。
 */
function acquireInstanceLock(root: string, op: string): boolean {
  const holder = readLock(root);
  if (holder) {
    if (holder.pid === process.pid) return false;
    if (isPidAlive(holder.pid)) throw new InstanceBusy(root, holder);
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, LOCK),
    JSON.stringify({ pid: process.pid, op, at: nowIso() }, null, 2) + '\n',
    'utf8',
  );
  return true;
}

function releaseInstanceLock(root: string): void {
  try {
    rmSync(join(root, LOCK), { force: true });
  } catch {
    /* 锁文件删不掉不影响结果 */
  }
}

/**
 * 同步版锁：给必须保持同步签名的调用方（migrateInstance，CLI 直接同步调用）用。
 * 锁文件、陈旧锁判定与 withInstanceLock 共用同一套协议，只是不经过 Promise。
 */
function withInstanceLockSync<T>(root: string, op: string, fn: (owned: boolean) => T): T {
  const owned = acquireInstanceLock(root, op);
  try {
    return fn(owned);
  } finally {
    if (owned) releaseInstanceLock(root);
  }
}

/**
 * 一个实例一次只允许一个写操作（安装、启停、删除）。
 */
export function withInstanceLock<T>(root: string, op: string, fn: () => Promise<T> | T): Promise<T> {
  const run = async (): Promise<T> => {
    if (!acquireInstanceLock(root, op)) return fn();
    try {
      return await fn();
    } finally {
      releaseInstanceLock(root);
    }
  };
  return run();
}

/** 读锁信息（排障用，不改变状态）。 */
export function instanceLock(root: string): LockInfo | undefined {
  return readLock(root);
}

/* ---------- 基线 ---------- */

export interface BaselineFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface Baseline {
  apiVersion: 'packhub.dev/baseline/v0';
  pack: string;
  version: string;
  harness: TargetId;
  planHash: string;
  at: string;
  files: BaselineFile[];
  /** 只属于运行时、不参与漂移判断的路径前缀 */
  ignore?: string[];
}

function hashFile(file: string): BaselineFile | undefined {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return undefined;
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    return { path: file, sha256: hash, bytes: stat.size };
  } catch {
    return undefined;
  }
}

/** 建完实例写基线：后面查“Pack 更新了什么、本地改了什么”都以它为准。 */
export function writeBaseline(root: string, baseline: Omit<Baseline, 'apiVersion' | 'at'>): Baseline {
  const value: Baseline = { apiVersion: 'packhub.dev/baseline/v0', at: nowIso(), ...baseline };
  const file = join(root, BASELINE);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
  return value;
}

export function readBaseline(root: string): Baseline | undefined {
  const file = join(root, BASELINE);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Baseline;
  } catch {
    return undefined;
  }
}

/** 从已安装状态收集基线文件清单。 */
export function baselineFromState(root: string): BaselineFile[] {
  const state = loadState(root);
  const out: BaselineFile[] = [];
  const seen = new Set<string>();
  for (const pack of Object.values(state.packs)) {
    for (const rel of pack.written ?? []) {
      const abs = resolve(root, rel);
      if (seen.has(abs)) continue;
      seen.add(abs);
      const hashed = hashFile(abs);
      if (hashed) out.push({ ...hashed, path: rel });
    }
  }
  return out;
}

/* ---------- 创建 ---------- */

function assertNameFree(name: string): void {
  if (listInstances().some((i) => i.name === name)) {
    throw new PalError('name-taken', `实例名已存在：${name}`, { hint: '换一个名字，或先删掉旧实例' });
  }
}

function assertHarness(value: string): TargetId {
  if (!(HARNESS_IDS as string[]).includes(value)) {
    throw new PalError('unknown-harness', `没有这个宿主：${value}`, {
      hint: `可选：${HARNESS_IDS.join(' / ')}`,
      details: { harness: value, choices: HARNESS_IDS },
    });
  }
  return value as TargetId;
}

/**
 * 从一个 Pack 目录创建实例：出计划、装进实例根、写实例记录与基线。
 * 失败时只清理我们自己造的根：先把现场移到 .failed，绝不 rm 一个已存在的目录。
 */
export async function createInstance(opts: CreateInstanceOptions): Promise<InstanceRecord> {
  const name = opts.name.trim();
  if (!name) throw new PalError('invalid-input', '实例名不能为空');
  const harness = assertHarness(opts.harness);
  if (!ADAPTERS[harness]) throw new PalError('unknown-harness', `没有这个宿主：${harness}`);
  assertNameFree(name);

  const id = newId();
  const root = resolve(opts.root ?? join(instancesRoot(), id));
  const existed = existsSync(root);
  if (existsSync(recordFile(root))) {
    throw new PalError('root-occupied', `这个目录已经是一份实例：${root}`, {
      hint: '换个目录，或从列表里操作它',
    });
  }

  const packDir = resolve(opts.packDir);
  const loaded = loadPack(packDir);
  if (!loaded.manifest) {
    const detail = loaded.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ');
    throw new PalError('invalid-input', `清单有问题：${detail || packDir}`, { details: { packDir } });
  }
  const lock = loadLock(packDir);
  const ctx: PackContext = withLockPins(loaded, lock);
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new PalError('invalid-input', `清单有问题：${errors.map((i) => i.message).join('; ')}`);
  }
  if (!ctx.manifest.metadata.targets.includes(harness)) {
    throw new PalError(
      'invalid-input',
      `这个包没有声明 target ${harness}；声明了：${ctx.manifest.metadata.targets.join(', ')}`,
      { details: { pack: ctx.manifest.metadata.name, declared: ctx.manifest.metadata.targets } },
    );
  }

  const adapter = ADAPTERS[harness];
  const targetVars = targetVarsFor(harness);
  const { plan, issues } = planFor(ctx, { target: harness, ...(targetVars ? { targetVars } : {}) });
  if (!plan) {
    throw new PalError('invalid-input', `生成不了计划：${issues.map((i) => i.message).join('; ')}`);
  }

  const home = adapter.homeDir ? join(root, adapter.homeDir) : undefined;
  mkdirSync(root, { recursive: true });
  if (home) mkdirSync(home, { recursive: true });

  const draft: InstanceRecord = {
    apiVersion: API_VERSION,
    id,
    name,
    harness,
    ...(opts.harnessVersion ? { harnessVersion: opts.harnessVersion } : {}),
    root,
    ...(home ? { home } : {}),
    pack: {
      name: ctx.manifest.metadata.name,
      version: ctx.manifest.metadata.version,
      ...(opts.packRef ? { ref: opts.packRef } : {}),
    },
    planHash: plan.planHash,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'installing',
    managed: true,
    origin: { kind: 'pack', ...(opts.packRef ? { ref: opts.packRef } : {}), dir: packDir },
    ports: [],
    restart: 'never',
    maxRestarts: 3,
  };
  // 先落 installing：中途崩溃时列表里能看到它，能删能查，不是凭空消失
  writeInstance(draft);

  try {
    await withInstanceLock(root, 'create', async () => {
      const result = await installPack(ctx, plan, { root, packRoot: packDir });
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
      writeBaseline(root, {
        pack: draft.pack.name,
        version: draft.pack.version,
        harness,
        planHash: plan.planHash,
        files: baselineFromState(root),
      });
      if (opts.seedFrom && home) {
        // 先装 Pack，再补凭据：Pack 写好的文件不被覆盖
        seedHome(opts.seedFrom, home);
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
      // 复用已有目录：只把配置摘掉，目录本身和里面的东西一概不动
      try {
        rmSync(recordFile(root), { force: true });
      } catch {
        /* 摘不掉就留着 failed 记录，至少能查能删 */
      }
    } else {
      failInstance(root, reason);
    }
    dropActive(id);
    throw err;
  }

  const record = readRecord(root)!;
  if (opts.activate !== false) {
    const map = readActiveMap();
    map[harness] = record.id;
    writeActiveMap(map);
  }
  return record;
}

/**
 * 删目录：Windows 上刚结束的进程可能还握着文件句柄，
 * 所以先重试几次；实在删不掉就改名挪走（rename 通常还能成），不把半个实例留在列表里。
 */
async function removeTreeWithRetry(dir: string, tries = 6): Promise<{ removed: boolean; movedTo?: string }> {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      if (!existsSync(dir)) return { removed: true };
    } catch {
      /* 换下一次 */
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
  }
  const moved = moveAside(dir, archiveRoot(), { reason: '删除时目录被占用，改为归档', from: dir });
  if (moved) return { removed: false, movedTo: moved };
  throw new PalError('busy', `删不掉这个目录：${dir}`, {
    hint: '有进程还握着里面的文件；结束它，或先关掉正在读它的程序',
  });
}

/* ---------- 删除 ---------- */

export interface RemoveOptions {
  /** 保留数据：卸掉 Pack 装进去的文件，把实例根移进 .archive，记录从列表里去掉 */
  keepData?: boolean;
  /** 已经在跑就先停掉；默认 true */
  force?: boolean;
  kill?: (pid: number) => void;
  isAlive?: (pid: number) => boolean;
  /** 等进程退出的上限；默认 10s（测试用短值） */
  timeoutMs?: number;
}

export interface RemoveResult {
  record: InstanceRecord;
  /** 停掉的进程 pid */
  stopped?: number;
  uninstalled: string[];
  /** keepData 时的去向 */
  archivedTo?: string;
  /** 目录是否真的删掉了（接管来的实例默认不删） */
  removed: boolean;
}

/**
 * 删一份实例：先停进程，再按需处理根。
 * - 默认：直接删根（删不动就归档），成功后才摘 link/active；失败则记录、state、包都原样留着。
 * - keepData：先按 state 卸包，再把根归档。
 * 运行中的实例不再出现“删一半”（EBUSY、包卸了目录还在）的情况。
 */
export async function removeInstance(
  nameOrId: string,
  opts: RemoveOptions = {},
): Promise<RemoveResult> {
  const record = requireInstance(nameOrId);
  const isAlive = opts.isAlive ?? isPidAlive;
  const kill = opts.kill ?? killTree;
  const uninstalled: string[] = [];
  let stopped: number | undefined;
  let archivedTo: string | undefined;

  await withInstanceLock(record.root, 'remove', async () => {
    if (record.pid && isAlive(record.pid)) {
      if (opts.force === false) {
        throw new PalError('already-running', `实例还在运行：pid ${record.pid}`, {
          hint: '先 pal stop，或让删除自己停（默认行为）',
        });
      }
      stopped = record.pid;
      const pid = record.pid;
      // 标记必须先于 kill 落盘：pal serve 里的看护一看到进程退出就会走 onExit，
      // 没有标记就会把正在删除的 on-failure 实例又拉起来。
      markStopping(record.root, pid);
      try {
        kill(pid);
        const gone = await waitForExit(pid, { isAlive, timeoutMs: opts.timeoutMs ?? 10_000 });
        if (!gone) {
          throw new PalError('busy', `停不掉这个进程：pid ${pid}`, {
            hint: '手工结束它，或用任务管理器；然后重试删除',
          });
        }
      } finally {
        // 成功失败都清：失败留着标记会把之后真实的崩溃一直压掉。
        // 这里在卸包/搬根之前清，归档目录不会带着标记走。
        clearStopping(record.root);
      }
    }

    // 接管来的目录不是 PAL 的：不能按 state 卸包，keepData 也不搬走它；
    // 只摘记录，目录原样保留。
    if (!record.managed) {
      rmSync(recordFile(record.root), { force: true });
      rmSync(join(record.root, BASELINE), { force: true });
      removeLink(record.id);
      dropActive(record.id);
      return;
    }

    // keepData 要先把 Pack 写进去的文件卸掉，再把（剩下的）根归档
    if (opts.keepData) {
      try {
        const state = loadState(record.root);
        for (const key of Object.keys(state.packs)) {
          removePack(record.root, key);
          uninstalled.push(key);
        }
      } catch (err) {
        throw new PalError('install-failed', `卸载 Pack 失败：${(err as Error).message}`, {
          hint: '先手动清掉实例根里的 .packhub 再删，或保留数据后手工处理',
          cause: err,
        });
      }
      const target = moveAside(record.root, archiveRoot(), {
        reason: '保留数据删除',
        id: record.id,
        name: record.name,
        harness: record.harness,
        pack: record.pack,
      });
      if (!target) {
        throw new PalError('busy', `归档失败：${record.root}`, {
          hint: '目录可能被占用；关掉正在读它的程序后重试',
        });
      }
      archivedTo = target;
      removeLink(record.id);
      dropActive(record.id);
      return;
    }

    // 默认删除：根是唯一真实的删除动作，先走它。
    // 顺序反了（先 removePack 再删根）一旦删根失败，包已经卸掉、目录和记录还在，
    // 没有回滚手段；反过来根删不掉就整根原样留着，state 和记录都完整，可以直接重试。
    // 包 key 只在删根前读一次，纯粹为了结果里的 uninstalled 报告（删完 state 就没了）。
    let packKeys: string[] = [];
    try {
      packKeys = Object.keys(loadState(record.root).packs);
    } catch {
      // state 损坏不该挡住删根：目录整个要消失，报告当作没装过包
    }
    const settled = await removeTreeWithRetry(record.root);
    uninstalled.push(...packKeys);
    removeLink(record.id);
    dropActive(record.id);
    if (!settled.removed) archivedTo = settled.movedTo;
  });

  return {
    record,
    ...(stopped ? { stopped } : {}),
    uninstalled,
    ...(archivedTo ? { archivedTo } : {}),
    removed: !opts.keepData && record.managed && !archivedTo,
  };
}

/* ---------- 更新与重新基准化 ---------- */

export interface UpdateInstanceResult {
  record: InstanceRecord;
  from: string;
  to: string;
  changed: boolean;
  planHash: string;
  /** 上一版有、这一版不再需要的文件 */
  removedFiles: string[];
  addedFiles: string[];
  /** 上一版文件里被本地改过、更新会覆盖的（保护提示） */
  localChanges: string[];
}

function writtenOf(root: string, names: string[]): string[] {
  const state = loadState(root);
  const out = new Set<string>();
  for (const key of names) {
    for (const rel of state.packs[key]?.written ?? []) out.add(rel);
  }
  return [...out];
}

/** 计划会写到的路径：更新后据此判断上一版的哪些文件已经没人要了。 */
function planTargets(plan: Plan): Set<string> {
  const out = new Set<string>();
  for (const action of plan.actions) {
    if (
      action.op === 'write' ||
      action.op === 'link.skill' ||
      action.op === 'unpack' ||
      action.op === 'link.bin' ||
      action.op === 'state.dir'
    ) {
      out.add(action.to);
    } else if (action.op === 'instruction') {
      out.add(action.file);
    } else if (action.op === 'merge.config') {
      out.add(action.path);
    } else if (action.op === 'register.mcp') {
      out.add(action.path ?? '.packhub/config.json');
    }
  }
  return out;
}

/**
 * 把实例里的 Pack 换成另一个版本：先在同一个根上装新版，再清掉上一版独有的文件。
 * 要求实例已停：更新期间有进程在读这些文件，删了会留下半套。
 * 更新前先按基线算本地改动；计划确实会变（changed）且改动非空、又没给 force 就拒绝并抛
 * PalError，一个文件都不写。同版本重跑不写盘，也不拦。
 */
export async function updateInstance(
  nameOrId: string,
  opts: { packDir: string; packRef?: string; force?: boolean },
): Promise<UpdateInstanceResult> {
  const record = requireInstance(nameOrId);
  if (record.pid && isPidAlive(record.pid)) {
    throw new PalError('already-running', `实例还在运行，先停掉再更新：pid ${record.pid}`, {
      hint: 'pal stop <id>，更新完再 pal start',
    });
  }
  const harness = record.harness;
  const loaded = loadPack(resolve(opts.packDir));
  if (!loaded.manifest) {
    const detail = loaded.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ');
    throw new PalError('invalid-input', `清单有问题：${detail || opts.packDir}`);
  }
  const ctx: PackContext = withLockPins(loaded, loadLock(resolve(opts.packDir)));
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) throw new PalError('invalid-input', `清单有问题：${errors.map((i) => i.message).join('; ')}`);
  if (!ctx.manifest.metadata.targets.includes(harness)) {
    throw new PalError('invalid-input', `这个包没有声明 target ${harness}`);
  }
  if (ctx.manifest.metadata.name !== record.pack.name) {
    throw new PalError(
      'invalid-input',
      `这不是同一个 Pack：实例里是 ${record.pack.name}，新的是 ${ctx.manifest.metadata.name}`,
      { hint: '换 Pack 请新建实例，不要原地替换' },
    );
  }

  const targetVars = targetVarsFor(harness);
  const { plan, issues } = planFor(ctx, { target: harness, ...(targetVars ? { targetVars } : {}) });
  if (!plan) throw new PalError('invalid-input', `生成不了计划：${issues.map((i) => i.message).join('; ')}`);

  const before = loadState(record.root);
  const oldKeys = Object.keys(before.packs).filter((key) => key.startsWith(`${record.pack.name}@`));
  const oldWritten = writtenOf(record.root, oldKeys);
  const baseline = readBaseline(record.root);
  // 更新会覆盖 Pack 装过的文件，所以先看哪些已经被本地改过：改过的要提前告诉人
  const localChanges = baseline
    ? baseline.files
        .filter((file) => {
          try {
            const abs = resolve(record.root, file.path);
            return (
              existsSync(abs) &&
              createHash('sha256').update(readFileSync(abs)).digest('hex') !== file.sha256
            );
          } catch {
            return false;
          }
        })
        .map((file) => file.path)
    : [];

  const changed = record.planHash !== plan.planHash || record.pack.version !== ctx.manifest.metadata.version;

  // P0：计划真的会覆盖 Pack 装过的文件时，先停下来问人；--force / body.force 才继续。
  // 同版本重跑（changed=false）本来不写盘，不拦。
  if (changed && localChanges.length > 0 && !opts.force) {
    const shown = localChanges.slice(0, 5).join('、');
    const more = localChanges.length > 5 ? ` 等 ${localChanges.length} 个文件` : '';
    throw new PalError('invalid-input', `更新会覆盖本地改过的文件：${shown}${more}；确认覆盖请加 --force`, {
      hint: '先备份改动，或 pal rebaseline <id> 把当前内容认作基线；确实要覆盖就带 --force（API: body.force=true）',
      details: { localChanges },
    });
  }

  let removedFiles: string[] = [];
  let addedFiles: string[] = [];

  await withInstanceLock(record.root, 'update', async () => {
    if (!changed) return;
    // 同一 Pack 的新版本要能覆盖旧版本写过的文件；overwrite 只放开"自己的包"
    await installPack(ctx, plan, { root: record.root, packRoot: resolve(opts.packDir), overwrite: true });

    // install 已经把同名的旧 key 并进新 key、written 取并集；这里清掉新计划不再要的文件
    const targets = planTargets(plan);
    removedFiles = oldWritten.filter((rel) => !targets.has(rel));
    addedFiles = [...targets].filter((rel) => !oldWritten.includes(rel));
    for (const rel of removedFiles) {
      const abs = resolve(record.root, rel);
      if (!abs.startsWith(resolve(record.root))) continue;
      try {
        if (existsSync(abs) && statSync(abs).isFile()) rmSync(abs, { force: true });
      } catch {
        /* 删不掉就留着，下次更新再说 */
      }
    }

    const after = loadState(record.root);
    const key = Object.keys(after.packs).find((item) => item.startsWith(`${ctx.manifest.metadata.name}@`));
    const recordState = key ? after.packs[key] : undefined;
    if (recordState) {
      const stale = new Set(removedFiles);
      recordState.written = recordState.written.filter((rel) => !stale.has(rel));
    }
    saveState(record.root, after);

    writeBaseline(record.root, {
      pack: ctx.manifest.metadata.name,
      version: ctx.manifest.metadata.version,
      harness,
      planHash: plan.planHash,
      files: baselineFromState(record.root),
    });

    const next: InstanceRecord = {
      ...record,
      pack: {
        name: ctx.manifest.metadata.name,
        version: ctx.manifest.metadata.version,
        ...(opts.packRef ? { ref: opts.packRef } : record.pack.ref ? { ref: record.pack.ref } : {}),
      },
      planHash: plan.planHash,
      status: 'installed',
    };
    delete next.lastError;
    writeInstance(next);
  });

  const localChangesAfter = baseline
    ? baseline.files
        .filter((file) => !new Set(removedFiles).has(file.path))
        .filter((file) => {
          try {
            const abs = resolve(record.root, file.path);
            return existsSync(abs) && createHash('sha256').update(readFileSync(abs)).digest('hex') !== file.sha256;
          } catch {
            return false;
          }
        })
        .map((file) => file.path)
    : [];

  return {
    record: readRecord(record.root)!,
    from: `${record.pack.name}@${record.pack.version}`,
    to: `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`,
    changed,
    planHash: plan.planHash,
    removedFiles,
    addedFiles,
    localChanges: [...new Set([...localChanges, ...localChangesAfter])],
  };
}

/** 重新基准化：把当前磁盘状态认作基线（本地改动被"接受"，体检不再报漂移）。 */
export function rebaselineInstance(nameOrId: string): Baseline {
  const record = requireInstance(nameOrId);
  const baseline = readBaseline(record.root);
  // ignore 必须随 files 一起交给 writeBaseline：写盘后改返回值不会落进 baseline.json
  return writeBaseline(record.root, {
    pack: record.pack.name,
    version: record.pack.version,
    harness: record.harness,
    planHash: record.planHash,
    files: baselineFromState(record.root),
    ...(baseline?.ignore ? { ignore: baseline.ignore } : {}),
  });
}

/* ---------- 接管 / 复制 / 改名 / 迁移 / 模板 ---------- */

export interface AdoptOptions {
  dir: string;
  name: string;
  harness: TargetId;
  /** 接管后是否设为当前实例 */
  activate?: boolean;
}

/**
 * 接管一个已经存在的环境：目录原样不动，只写一份记录指过去。
 * managed=false：删除时只摘记录，绝不删用户目录。
 */
export function adoptInstance(opts: AdoptOptions): InstanceRecord {
  const dir = resolve(opts.dir);
  if (!existsSync(dir)) {
    throw new PalError('not-found', `这个目录不存在：${dir}`);
  }
  const harness = assertHarness(opts.harness);
  assertNameFree(opts.name.trim());
  if (existsSync(recordFile(dir))) {
    throw new PalError('root-occupied', `这个目录已经是一份实例：${dir}`);
  }
  const adapter = ADAPTERS[harness];
  const home = adapter.homeDir && existsSync(join(dir, adapter.homeDir)) ? join(dir, adapter.homeDir) : undefined;
  let pack = { name: 'external', version: '0.0.0' };
  let planHash = '';
  try {
    const entries = Object.values(loadState(dir).packs);
    // 只有恰好一个 Pack 时它的名字才能代表这个实例；多个 Pack 里「第一个」只是对象顺序，
    // 拿来当身份会让记录撒谎，updateInstance 也会把别的 Pack 当成同一个。此时记 external。
    const only = entries.length === 1 ? entries[0] : undefined;
    if (only?.pack) pack = { name: only.pack, version: only.version ?? '0.0.0' };
    if (only?.planHash) planHash = only.planHash;
  } catch {
    /* 没有 state 就是空环境 */
  }
  const record: InstanceRecord = {
    apiVersion: API_VERSION,
    id: newId(),
    name: opts.name.trim(),
    harness,
    root: dir,
    ...(home ? { home } : {}),
    pack,
    planHash,
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
    map[harness] = record.id;
    writeActiveMap(map);
  }
  return record;
}

/** 复制一份实例：连 home 一起拷，得到可独立改的副本；端口与运行信息清空。 */
export async function cloneInstance(
  nameOrId: string,
  opts: { name: string; root?: string; activate?: boolean } = { name: '' },
): Promise<InstanceRecord> {
  const source = requireInstance(nameOrId);
  const name = opts.name.trim();
  if (!name) throw new PalError('invalid-input', '复制出来的实例要一个新名字');
  assertNameFree(name);
  if (source.pid && isPidAlive(source.pid)) {
    throw new PalError('already-running', `源实例还在运行：pid ${source.pid}`, {
      hint: '先停掉源实例再复制，拷一份正在写的 home 没有意义',
    });
  }
  const id = newId();
  const target = resolve(opts.root ?? join(instancesRoot(), id));
  if (existsSync(target)) {
    throw new PalError('root-occupied', `目标目录已存在：${target}`);
  }
  try {
    cpSync(source.root, target, { recursive: true, force: true, errorOnExist: false });
  } catch (err) {
    if (!source.managed) {
      throw new PalError('busy', `复制失败：${(err as Error).message}`, { cause: err });
    }
    throw err;
  }
  // 复制来的运行痕迹一律作废
  rmSync(join(target, 'logs'), { recursive: true, force: true });
  rmSync(join(target, LOCK), { force: true });
  rmSync(join(target, 'secrets.json'), { force: true });
  const record: InstanceRecord = {
    ...source,
    id,
    name,
    root: target,
    ...(source.home ? { home: source.home.replace(source.root, target) } : {}),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'installed',
    // 目标目录是这里新建并拷贝出来的，删实例时整个根都归 PAL 管
    managed: true,
    // 复制体不是从 Pack 重建的：只记它从哪份实例拷来，绝不复用源的 pack 来源
    origin: { kind: 'copy', from: source.id },
    ports: [],
    restart: source.restart ?? 'never',
    maxRestarts: source.maxRestarts ?? 3,
  };
  delete record.pid;
  delete record.port;
  delete record.url;
  delete record.startedAt;
  delete record.lastExit;
  delete record.lastError;
  writeInstance(record);
  if (opts.activate) {
    const map = readActiveMap();
    map[record.harness] = record.id;
    writeActiveMap(map);
  }
  return record;
}

export function renameInstance(nameOrId: string, newName: string): InstanceRecord {
  const record = requireInstance(nameOrId);
  const name = newName.trim();
  if (!name) throw new PalError('invalid-input', '新名字不能为空');
  if (name === record.name) return record;
  // 重名检查与写记录必须在同一把锁里：并发 rename/remove/update 时，
  // 检查和落盘之间插进来的写会把名字或记录覆盖掉。
  return withInstanceLockSync(record.root, 'rename', () => {
    // 锁内重读：等锁期间记录可能已经被别的进程改过或删掉
    const current = readRecord(record.root);
    if (!current) {
      // 记录已经没了就不能拿旧内存写回去，否则等于把删掉的实例复活
      throw new PalError('unknown-instance', `这个实例已经不在了：${nameOrId}`);
    }
    if (current.name === name) return current;
    assertNameFree(name);
    writeInstance({ ...current, name });
    // 读回落盘结果，别把内存里的 draft 当事实
    return readRecord(record.root)!;
  });
}

/** 回滚迁移：把目录挪回原路径，并把记录改回旧 root。 */
function rollbackMigrate(
  record: InstanceRecord,
  target: string,
): { ok: boolean; scene: string; error?: string } {
  try {
    renameSync(target, record.root);
  } catch (err) {
    return {
      ok: false,
      scene: `目录没能挪回 ${record.root}，现场还在 ${target}`,
      error: (err as Error).message,
    };
  }
  // 目录已经回来了；如果记录已经写成新路径，再把它改回旧路径
  const current = readRecord(record.root);
  if (current && current.id === record.id && current.root === record.root) {
    return { ok: true, scene: record.root };
  }
  try {
    writeInstance(record);
    return { ok: true, scene: record.root };
  } catch (err) {
    return {
      ok: false,
      scene: `目录已挪回 ${record.root}，但记录仍指向 ${target}`,
      error: (err as Error).message,
    };
  }
}

/** 在实例锁里执行迁移：rename 与写记录是一个整体，写记录失败就把目录挪回去。 */
function migrateLocked(record: InstanceRecord, target: string, owned: boolean): InstanceRecord {
  try {
    renameSync(record.root, target);
  } catch (err) {
    throw new PalError('busy', `挪不动这个实例根：${(err as Error).message}`, {
      hint: '跨盘时先手动复制再删；或换一个同盘目录',
      cause: err,
    });
  }

  try {
    const next: InstanceRecord = {
      ...record,
      root: target,
      ...(record.home ? { home: record.home.replace(record.root, target) } : {}),
    };
    writeInstance(next);
    // 不能静默：写记录返回后必须能从新根读回同一份记录
    const read = readRecordResult(target);
    if (!read.record) {
      throw new PalError('record-corrupt', `迁移后读不到新根的记录：${read.error ?? '没有 instance.json'}`, {
        hint: '写记录没有真正落盘，迁移会回滚',
        details: { root: record.root, target },
      });
    }
    // 锁文件跟着目录搬到了新根；只清我们这次迁移写进去的那一把
    const atTarget = readLock(target);
    if (owned && atTarget?.pid === process.pid && atTarget.op === 'migrate') {
      releaseInstanceLock(target);
    }
    return read.record;
  } catch (err) {
    const rollback = rollbackMigrate(record, target);
    if (!rollback.ok) {
      if (owned) releaseInstanceLock(target);
      throw new PalError('internal', `迁移写记录失败，回滚也失败；${rollback.scene}：${(err as Error).message}`, {
        hint: rollback.error,
        cause: err,
        details: { root: record.root, target },
      });
    }
    throw new PalError(
      err instanceof PalError ? err.code : 'internal',
      `迁移写记录失败，已回滚（目录回到 ${record.root}）：${(err as Error).message}`,
      { hint: '实例根与记录都回到迁移前的位置，可以重试', cause: err, details: { root: record.root, target } },
    );
  }
}

/** 把实例根整体挪到别处（换盘、整理目录），记录里的路径一起改。 */
export function migrateInstance(nameOrId: string, to: string): InstanceRecord {
  const record = requireInstance(nameOrId);
  if (record.pid && isPidAlive(record.pid)) {
    throw new PalError('already-running', `实例还在运行：pid ${record.pid}`, { hint: '先停掉再迁移' });
  }
  const target = resolve(to);
  if (existsSync(target)) {
    throw new PalError('root-occupied', `目标已存在：${target}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  return withInstanceLockSync(record.root, 'migrate', (owned) => migrateLocked(record, target, owned));
}

export interface InstanceTemplate {
  apiVersion: 'packhub.dev/instance-template/v0';
  name: string;
  harness: TargetId;
  pack: { name: string; version: string; ref?: string };
  origin?: InstanceRecord['origin'];
  createdAt: string;
  /** 接管来的实例没有可复现的来源，导出时明确写出来 */
  reproducible: boolean;
  note?: string;
}

export function exportTemplate(nameOrId: string): InstanceTemplate {
  const record = requireInstance(nameOrId);
  const reproducible = record.origin?.kind === 'pack' && Boolean(record.origin.ref);
  return {
    apiVersion: 'packhub.dev/instance-template/v0',
    name: record.name,
    harness: record.harness,
    pack: record.pack,
    ...(record.origin ? { origin: record.origin } : {}),
    createdAt: nowIso(),
    reproducible,
    ...(reproducible
      ? {}
      : { note: '这份实例不是用 Pack 引用建的，导出的模板只能记录它是什么，不能复原内容' }),
  };
}

export function writeTemplate(template: InstanceTemplate, file: string): string {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(resolve(file), JSON.stringify(template, null, 2) + '\n', 'utf8');
  return resolve(file);
}

export function readTemplate(file: string): InstanceTemplate {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new PalError('not-found', `没有这个模板文件：${abs}`);
  let data: InstanceTemplate;
  try {
    data = JSON.parse(readFileSync(abs, 'utf8')) as InstanceTemplate;
  } catch (err) {
    throw new PalError('invalid-input', `模板读不了：${(err as Error).message}`, { cause: err });
  }
  if (data?.apiVersion !== 'packhub.dev/instance-template/v0') {
    throw new PalError('invalid-input', '不是 PAL 实例模板（apiVersion 不对）');
  }
  if (!data.reproducible) {
    throw new PalError('invalid-input', `这份模板不可复现：${data.note ?? '没有来源引用'}`, {
      hint: '从 Pack registry 或 .phub / git+ 引用建的实例才能导出可复现模板',
    });
  }
  return data;
}
