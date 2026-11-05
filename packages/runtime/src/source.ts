import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { download } from './download.ts';
import { unpackArchive } from './pack.ts';

export interface ResolvedSource {
  /** 解出来的 Pack 根目录（含 packhub.yaml） */
  dir: string;
  /** 来源类型，给日志用 */
  kind: 'archive' | 'git';
  label: string;
}

/** git+https://host/org/repo[@ref] → 归档地址（GitHub / GitLab 的 archive 端点）。 */
export function gitArchiveUrl(target: string): string {
  const raw = target.replace(/^git\+/, '');
  const at = raw.lastIndexOf('@');
  const repoUrl = at > raw.indexOf('//') + 2 ? raw.slice(0, at) : raw;
  const ref = at > raw.indexOf('//') + 2 ? raw.slice(at + 1) : 'HEAD';
  const u = new URL(repoUrl);
  const path = u.pathname.replace(/^\/|\/$/g, '').replace(/\.git$/, '');
  if (u.hostname === 'github.com') {
    return `https://codeload.github.com/${path}/tar.gz/${ref}`;
  }
  const name = path.split('/').pop() ?? 'repo';
  return `${u.origin}/${path}/-/archive/${ref}/${name}-${ref}.tar.gz`;
}

function findPackRoot(dir: string): string | null {
  if (existsSync(join(dir, 'packhub.yaml'))) return dir;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = join(dir, entry.name);
    if (existsSync(join(sub, 'packhub.yaml'))) return sub;
  }
  return null;
}

/**
 * 从 `.phub` 或 `git+https://…` 取一个 Pack 到 dest。
 * registry 的 scope/name 走 fetchPack，不在这里。
 */
export async function resolveAddSource(
  target: string,
  dest: string,
): Promise<ResolvedSource> {
  mkdirSync(dest, { recursive: true });

  if (target.endsWith('.phub')) {
    if (!existsSync(target)) throw new Error(`没有这个归档：${target}`);
    copyFileSync(target, join(dest, 'pack.phub'));
    await unpackArchive(join(dest, 'pack.phub'), dest);
    return { dir: dest, kind: 'archive', label: target };
  }

  if (target.startsWith('git+')) {
    const url = gitArchiveUrl(target);
    const archive = join(dest, 'source.tar.gz');
    await download(url, archive);
    // 归档顶层是一个目录，直接解到 dest，再找 packhub.yaml（根或一层子目录）
    await unpackArchive(archive, dest);
    const root = findPackRoot(dest);
    if (!root) throw new Error('这个仓库里没有 packhub.yaml（可以放在根目录或一层子目录）');
    return { dir: root, kind: 'git', label: target };
  }

  throw new Error(`无法识别的来源：${target}（支持 .phub、git+https://…，或配合 --index 用 scope/name）`);
}

export const __sourceInternals = { findPackRoot };
