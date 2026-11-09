import {
  lstatSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { cacheRoot } from './paths.ts';
import { readCacheMeta, readPackIdentity, slug, type CacheMeta } from './materialize.ts';
import { PalError } from './errors.ts';

export type { CacheMeta };

/**
 * 一份缓存条目的形状：`<cacheRoot>/<slug>/<variant>/`。
 * ref / source / fetchedAt 只来自 meta；meta 缺失时用清单补 pack 与 version，
 * ref 留 null（目录名里有哈希，但不该反推成引用）。
 */
export interface CacheEntry {
  /** 第一层目录名（Pack 引用的 slug） */
  slug: string;
  /** 第二层目录名（明确版本或内容哈希） */
  variant: string;
  /** 绝对目录 */
  dir: string;
  /** meta.ref；没有 meta 时为 null */
  ref: string | null;
  /** meta.version，缺了就从 packhub.yaml 补 */
  version: string | null;
  /** 清单 metadata.name */
  pack: string | null;
  /** registry / archive / git（来自 meta） */
  source: string | null;
  /** 取回时间（ISO，来自 meta） */
  fetchedAt: string | null;
  /** 完整 meta；老缓存没有这个文件时为 null */
  meta: CacheMeta | null;
  /** 目录里文件的总字节 */
  bytes: number;
  /** 文件数 */
  files: number;
  /** 目录 mtime（毫秒），--older-than 按它算 */
  mtimeMs: number;
  /** 目录 mtime（ISO） */
  mtime: string;
  /** 这一条自己的小问题（meta 坏了、个别文件读不了）；不影响列出来 */
  problems: string[];
}

/** 扫到了但没法当条目用：缓存根下的散文件、空 slug 目录、版本层不是目录等。 */
export interface CacheProblem {
  dir: string;
  reason: string;
}

export interface CacheScan {
  root: string;
  entries: CacheEntry[];
  problems: CacheProblem[];
  totalBytes: number;
}

export interface CacheStats {
  count: number;
  totalBytes: number;
}

export interface CleanOptions {
  /** 清全部；与 ref / olderThanDays 互斥 */
  all?: boolean;
  /** 只清这个 Pack 引用（按 meta.ref 或目录 slug 匹配） */
  ref?: string;
  /** 只清目录 mtime 早于 N 天的条目 */
  olderThanDays?: number;
}

export interface CleanResult {
  /** 成功删掉的绝对目录 */
  removed: string[];
  /** 没删的条目数（含删除失败留在盘上的） */
  kept: number;
  /** 删除失败与扫描时跳过的坏目录；清理不因单项失败中断 */
  errors: string[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 递归量目录大小与文件数；读不了的文件/目录记进 problems，不抛。 */
function measure(dir: string, problems: string[]): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      problems.push(`读不了目录 ${current}：${errorText(err)}`);
      continue;
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isSymbolicLink()) {
        // 不跟随链接：缓存里不该有，也不能让它把统计/删除带到别处
        problems.push(`符号链接未统计：${abs}`);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        bytes += statSync(abs).size;
        files += 1;
      } catch (err) {
        problems.push(`读不了文件 ${abs}：${errorText(err)}`);
      }
    }
  }
  return { bytes, files };
}

function readEntry(
  slugName: string,
  variantName: string,
  dir: string,
  problems: CacheProblem[],
): CacheEntry | null {
  let dirStat: Stats;
  try {
    dirStat = statSync(dir);
  } catch (err) {
    problems.push({ dir, reason: `读不了目录：${errorText(err)}` });
    return null;
  }
  const entryProblems: string[] = [];
  const { meta, problem } = readCacheMeta(dir);
  if (problem) entryProblems.push(problem);
  const identity = readPackIdentity(dir);
  const size = measure(dir, entryProblems);
  return {
    slug: slugName,
    variant: variantName,
    dir,
    ref: meta?.ref ?? null,
    version: meta?.version ?? identity.version ?? null,
    pack: meta?.pack ?? identity.name ?? null,
    source: meta?.source ?? null,
    fetchedAt: meta?.fetchedAt ?? null,
    meta: meta ?? null,
    bytes: size.bytes,
    files: size.files,
    mtimeMs: dirStat.mtimeMs,
    mtime: new Date(dirStat.mtimeMs).toISOString(),
    problems: entryProblems,
  };
}

/**
 * 扫缓存根：`<slug>/<variant>/` 两层都只认目录，符号链接按“坏目录”报告，不跟随。
 * 坏目录跳过（进 problems），能读的条目照常列出来；缓存根不存在就是空。
 */
export function scanCache(): CacheScan {
  const root = resolve(cacheRoot());
  const entries: CacheEntry[] = [];
  const problems: CacheProblem[] = [];

  let firstLevel: Dirent[];
  try {
    firstLevel = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') problems.push({ dir: root, reason: `读不了缓存根：${errorText(err)}` });
    return { root, entries, problems, totalBytes: 0 };
  }

  for (const slugEntry of firstLevel) {
    const slugDir = join(root, slugEntry.name);
    if (!slugEntry.isDirectory()) {
      problems.push({ dir: slugDir, reason: '缓存根下不是目录，跳过' });
      continue;
    }
    let variants: Dirent[];
    try {
      variants = readdirSync(slugDir, { withFileTypes: true });
    } catch (err) {
      problems.push({ dir: slugDir, reason: `读不了目录：${errorText(err)}` });
      continue;
    }
    let variantCount = 0;
    for (const variantEntry of variants) {
      const dir = join(slugDir, variantEntry.name);
      if (!variantEntry.isDirectory()) {
        problems.push({ dir, reason: '版本层不是目录，跳过' });
        continue;
      }
      variantCount += 1;
      const entry = readEntry(slugEntry.name, variantEntry.name, dir, problems);
      if (entry) entries.push(entry);
    }
    if (variantCount === 0) problems.push({ dir: slugDir, reason: '没有版本目录（空目录或残留）' });
  }

  entries.sort(
    (a, b) =>
      b.mtimeMs - a.mtimeMs || a.slug.localeCompare(b.slug) || a.variant.localeCompare(b.variant),
  );
  return {
    root,
    entries,
    problems,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

/** 列出缓存条目；坏目录不混进列表（用 scanCache().problems 报告）。 */
export function listCache(): CacheEntry[] {
  return scanCache().entries;
}

export function cacheStats(entries: CacheEntry[]): CacheStats {
  return {
    count: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

/** 人类可读的大小；CLI 汇总用。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  if (index === 0) return `${Math.round(value)} B`;
  return `${value.toFixed(1)} ${units[index] ?? 'B'}`;
}

interface CleanSelector {
  all: boolean;
  ref?: string;
  refSlug?: string;
  cutoff?: number;
}

/**
 * 清缓存的三种选择器必须显式给且只给一个：
 * 没给就报 invalid-input（绝不当成“清全部”），给两个也不猜优先级。
 */
function selectorFor(opts: CleanOptions): CleanSelector {
  const given: string[] = [];
  if (opts.all === true) given.push('--all');
  if (opts.ref !== undefined) given.push('--ref');
  if (opts.olderThanDays !== undefined) given.push('--older-than');
  if (given.length === 0) {
    throw new PalError('invalid-input', '清缓存要说清清哪些：--all、--ref <引用> 或 --older-than <天数>', {
      hint: '三者必须显式给一个；可以先跑 pal cache 看清楚再决定',
    });
  }
  if (given.length > 1) {
    throw new PalError('invalid-input', `清缓存的选择器只能给一个：${given.join(' / ')}`, {
      hint: '要清某个引用用 --ref，要按时间用 --older-than，要全清用 --all',
    });
  }
  if (opts.ref !== undefined) {
    const ref = opts.ref.trim();
    if (!ref) throw new PalError('invalid-input', '--ref 要一个非空的 Pack 引用');
    return { all: false, ref, refSlug: slug(ref) };
  }
  if (opts.olderThanDays !== undefined) {
    const days = Number(opts.olderThanDays);
    if (!Number.isFinite(days) || days < 0) {
      throw new PalError('invalid-input', '--older-than 要一个非负的天数', {
        details: { olderThanDays: opts.olderThanDays },
      });
    }
    return { all: false, cutoff: Date.now() - days * 24 * 60 * 60 * 1000 };
  }
  return { all: true };
}

function selectEntries(entries: CacheEntry[], selector: CleanSelector): CacheEntry[] {
  if (selector.all) return [...entries];
  if (selector.ref !== undefined) {
    const target = selector.ref;
    // 老缓存没有 meta：允许直接拿目录 slug 对；新缓存按 meta.ref 或由引用算出的 slug 对。
    return entries.filter(
      (entry) =>
        entry.meta?.ref === target ||
        entry.ref === target ||
        entry.slug === target ||
        entry.slug === selector.refSlug,
    );
  }
  const cutoff = selector.cutoff;
  if (cutoff === undefined) return [];
  return entries.filter((entry) => entry.mtimeMs < cutoff);
}

/** 先算出会清哪些（CLI 拿它做确认文案）；选择器不合法在这里就抛。 */
export function planClean(opts: CleanOptions = {}): CacheEntry[] {
  const selector = selectorFor(opts);
  return selectEntries(scanCache().entries, selector);
}

/**
 * 只删 cacheRoot 下面两层的条目：先确认路径在缓存根内，且不是缓存根本身。
 * 符号链接只删链接本身，不跟进去。
 */
function removeEntryDir(dir: string): void {
  const base = resolve(cacheRoot());
  const target = resolve(dir);
  if (target === base || !target.startsWith(base + sep)) {
    throw new Error(`拒绝删除缓存根之外的路径：${target}`);
  }
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    unlinkSync(target);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`不是目录：${target}`);
  rmSync(target, { recursive: true, force: true });
}

/** 一个 slug 下没有版本目录了就顺手删掉空壳；非空或删不掉都留着。 */
function pruneEmptyDir(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    /* 还有别的条目在，或删不掉：留着 */
  }
}

/**
 * 按选择器清缓存。单项删除失败收进 errors，继续删其它条目。
 * 扫描时跳过的坏目录也进 errors（它们不会被删，需要人工看）。
 */
export function cleanCache(opts: CleanOptions = {}): CleanResult {
  const selector = selectorFor(opts);
  const scan = scanCache();
  const matched = selectEntries(scan.entries, selector);
  const removed: string[] = [];
  const errors = scan.problems.map((problem) => `跳过 ${problem.dir}：${problem.reason}`);
  const touchedSlugs = new Set<string>();

  for (const entry of matched) {
    try {
      __cacheInternals.removeEntryDir(entry.dir);
      removed.push(entry.dir);
      touchedSlugs.add(join(scan.root, entry.slug));
    } catch (err) {
      errors.push(`${entry.dir}：${errorText(err)}`);
    }
  }
  for (const slugDir of touchedSlugs) pruneEmptyDir(slugDir);

  return { removed, kept: scan.entries.length - removed.length, errors };
}

/** 测试用：替换 removeEntryDir 来模拟「删到一半失败」，不用真去锁文件。 */
export const __cacheInternals = { removeEntryDir };
