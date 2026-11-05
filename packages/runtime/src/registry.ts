import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { download, httpText } from './download.ts';
import { unpackArchive } from './pack.ts';

export interface IndexEntry {
  name: string;
  title?: string;
  description?: string;
  latest: string;
  versions: string[];
  trust?: 'verified' | 'community';
  keywords?: string[];
  resourceCount?: number;
  install?: string;
}

export interface RegistryIndex {
  apiVersion: string;
  packs: IndexEntry[];
}

export class RegistryError extends Error {
  readonly code: 'not-found' | 'bad-index' | 'no-archive';

  constructor(message: string, code: RegistryError['code']) {
    super(message);
    this.code = code;
    this.name = 'RegistryError';
  }
}

const isUrl = (s: string): boolean => /^https?:\/\//i.test(s);

/** 读索引：本地路径或 http(s)。索引本身很小，直接读全文。 */
export async function readIndex(indexRef: string): Promise<RegistryIndex> {
  let text: string;
  if (isUrl(indexRef)) {
    const base = dirname(new URL(indexRef).pathname);
    void base;
    text = await httpText(indexRef, { accept: 'application/json' });
  } else {
    if (!existsSync(indexRef)) throw new RegistryError(`索引不存在：${indexRef}`, 'bad-index');
    text = readFileSync(indexRef, 'utf8');
  }
  const data = JSON.parse(text) as RegistryIndex;
  if (!Array.isArray(data.packs)) throw new RegistryError('索引格式不对：缺少 packs', 'bad-index');
  return data;
}

/** 归档在 registry 里的相对路径（约定，不写进索引，避免两处真相）。 */
export function archivePath(name: string, version: string): string {
  return `packs/${name}/${version}.phub`;
}

/**
 * 把一个包从 registry 取到本地目录。
 * 只负责"取"：解包后是完整的 Pack 目录，装不装由调用方决定。
 */
export async function fetchPack(opts: {
  name: string;
  index: string;
  version?: string;
  dest: string;
  /** unlisted：知道确切名称与版本时，可以不走索引 */
  allowUnlisted?: boolean;
}): Promise<{ dir: string; version: string; bytes: number }> {
  const index = await readIndex(opts.index);
  const entry = index.packs.find((p) => p.name === opts.name);
  if (!entry && !(opts.allowUnlisted && opts.version)) {
    throw new RegistryError(`索引里没有这个包：${opts.name}`, 'not-found');
  }

  const version = opts.version ?? entry?.latest;
  if (!version) throw new RegistryError(`${opts.name} 没有可用的版本`, 'not-found');
  if (entry && !entry.versions.includes(version)) {
    throw new RegistryError(
      `${opts.name} 没有版本 ${version}（有：${entry.versions.join(', ')}）`,
      'not-found',
    );
  }

  const base = isUrl(opts.index)
    ? opts.index.replace(/\/[^/]*$/, '')
    : dirname(opts.index).replaceAll('\\', '/');
  const rel = archivePath(opts.name, version);
  const archiveUrl = `${base}/${rel}`;

  mkdirSync(opts.dest, { recursive: true });
  clearContents(opts.dest);
  const localArchive = join(opts.dest, 'pack.phub');

  if (isUrl(archiveUrl)) {
    await download(archiveUrl, localArchive);
  } else {
    const src = join(dirname(opts.index), rel.replaceAll('/', require_sep()));
    if (!existsSync(src)) {
      throw new RegistryError(`registry 里没有归档：${rel}`, 'no-archive');
    }
    copyFileSync(src, localArchive);
  }

  await unpackArchive(localArchive, opts.dest);
  return { dir: opts.dest, version, bytes: statSync(localArchive).size };
}

function require_sep(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

/**
 * 清空一个「我们自己的」缓存目录里的内容，再解新归档。
 * 只删目录内的条目，不删目录本身；遇到盘符根/用户目录这种明显不该清的目标直接拒绝，
 * 避免 update 在两个版本之间留下上一版的文件，也避免误删。
 */
function clearContents(dir: string): void {
  const abs = resolve(dir);
  const protectedDirs = new Set([resolve('/'), resolve(homedir()), resolve(process.cwd())]);
  const bad = !basename(abs) || /^[a-zA-Z]:[\\/]?$/.test(abs) || abs === resolve('/') || protectedDirs.has(abs);
  if (bad) throw new Error(`拒绝清空这个目录：${abs}`);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs)) {
    rmSync(join(abs, entry), { recursive: true, force: true });
  }
}
