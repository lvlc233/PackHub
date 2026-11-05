import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Plan } from '@packhub/kernel';
import { loadState } from './install.ts';

export interface CacheEntry {
  /** 相对项目根的路径，例如 .packhub/cache/skills/x */
  path: string;
  bytes: number;
  kind: 'archive' | 'skill' | 'tool' | 'other';
  /** 还有已装版本的计划引用它 */
  referenced: boolean;
}

export interface CacheReport {
  root: string;
  entries: CacheEntry[];
  totalBytes: number;
}

function sizeOf(target: string): number {
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    total += sizeOf(join(target, entry.name));
  }
  return total;
}

/** 计划里引用到的缓存路径：fetch 的落点、unpack 的来源/落点、skill 的来源。 */
function referencedPaths(plans: Plan[]): string[] {
  const out = new Set<string>();
  for (const plan of plans) {
    for (const action of plan.actions) {
      if (action.op === 'fetch') out.add(action.dest);
      else if (action.op === 'unpack') out.add(action.from), out.add(action.to);
      else if (action.op === 'link.skill' || action.op === 'link.bin') out.add(action.from);
    }
  }
  return [...out];
}

/**
 * 缓存里有什么、还有没有被引用。
 * 引用关系只认 state 里的计划快照：被删掉的版本留下的下载物就是可回收的。
 */
export function inspectCache(root: string): CacheReport {
  const base = join(root, '.packhub/cache');
  const state = loadState(root);
  const refs = referencedPaths(Object.values(state.packs).map((p) => p.plan).filter((p): p is Plan => Boolean(p)));
  const isReferenced = (rel: string): boolean =>
    refs.some((ref) => ref === rel || rel.startsWith(`${ref}/`) || ref.startsWith(`${rel}/`));
  const entries: CacheEntry[] = [];
  if (!existsSync(base)) return { root, entries, totalBytes: 0 };

  // 以「可回收单位」列：缓存根下的文件，以及 skills/<id>、tools/<id> 目录
  const add = (abs: string, kind: CacheEntry['kind']): void => {
    const rel = relative(root, abs).split(sep).join('/');
    entries.push({ path: rel, bytes: sizeOf(abs), kind, referenced: isReferenced(rel) });
  };
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const abs = join(base, entry.name);
    if (entry.isDirectory() && (entry.name === 'skills' || entry.name === 'tools')) {
      for (const sub of readdirSync(abs, { withFileTypes: true })) {
        add(join(abs, sub.name), entry.name === 'skills' ? 'skill' : 'tool');
      }
      continue;
    }
    if (entry.isDirectory()) {
      add(abs, 'other');
      continue;
    }
    add(abs, /\.(tar\.gz|tgz)$/i.test(entry.name) ? 'archive' : 'other');
  }
  return { root, entries, totalBytes: entries.reduce((n, e) => n + e.bytes, 0) };
}

export interface CacheCleanResult {
  dryRun: boolean;
  removed: string[];
  freedBytes: number;
  kept: string[];
}

/**
 * 删掉没有被任何已装计划引用的缓存。
 * 只动 .packhub/cache；state、快照、版本目录都不碰。
 */
export function cleanCache(root: string, opts: { dryRun?: boolean } = {}): CacheCleanResult {
  const report = inspectCache(root);
  const removed: string[] = [];
  let freedBytes = 0;
  // 只删最外层未被引用的单位：删了父目录就不必再删子项
  const gone = new Set<string>();
  for (const entry of report.entries) {
    if (entry.referenced) continue;
    if ([...gone].some((p) => entry.path === p || entry.path.startsWith(`${p}/`))) continue;
    const abs = resolve(root, entry.path);
    if (!abs.startsWith(resolve(root, '.packhub/cache') + sep)) continue;
    if (!existsSync(abs)) continue;
    if (!opts.dryRun) rmSync(abs, { recursive: true, force: true });
    gone.add(entry.path);
    removed.push(entry.path);
    freedBytes += entry.bytes;
  }
  return {
    dryRun: opts.dryRun === true,
    removed,
    freedBytes,
    kept: report.entries.filter((e) => e.referenced).map((e) => e.path),
  };
}
