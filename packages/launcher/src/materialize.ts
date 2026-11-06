import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fetchPack, resolveAddSource, resolveRegistry } from '@packhub/runtime';
import { instancesRoot } from './index.ts';

export interface MaterializeOptions {
  /** registry 索引：路径、URL 或配置里的名字 */
  index?: string;
  version?: string;
  log?: (line: string) => void;
}

/** 取回来的 Pack 放在实例根旁边，按来源 slug 分目录。 */
export function packCacheRoot(): string {
  return join(dirname(instancesRoot()), 'cache', 'packs');
}

function slug(packRef: string): string {
  return (
    packRef
      .replace(/^git\+/, '')
      .replace(/\.phub$/, '')
      .replace(/[@/\\:]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(-48) || 'pack'
  );
}

/**
 * 把一个 Pack 引用落到本地目录：本地目录直接用；.phub / git+ 取回来解包；
 * 其余按 registry 名去索引里取。只负责取，装不装由调用方决定。
 */
export async function materializePack(
  packRef: string,
  opts: MaterializeOptions = {},
): Promise<string> {
  if (existsSync(join(packRef, 'packhub.yaml'))) return resolve(packRef);

  const dest = join(packCacheRoot(), slug(packRef));
  mkdirSync(dest, { recursive: true });
  opts.log?.(`→ 取 ${packRef}`);

  if (packRef.endsWith('.phub') || packRef.startsWith('git+')) {
    const resolved = await resolveAddSource(packRef, dest);
    return resolved.dir;
  }

  const index = resolveRegistry(opts.index);
  if (!index) {
    throw new Error('用 registry 名称需要一个索引：--index <路径|URL>，或设 PACKHUB_INDEX');
  }
  const fetched = await fetchPack({
    name: packRef,
    index,
    dest,
    ...(opts.version ? { version: opts.version, allowUnlisted: true } : {}),
  });
  return fetched.dir;
}
