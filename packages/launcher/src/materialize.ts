import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { fetchPack, resolveAddSource, resolveRegistry } from '@packhub/runtime';
import { cacheRoot } from './paths.ts';
import { PalError } from './errors.ts';

export interface MaterializeOptions {
  /** registry 索引：路径、URL 或配置里的名字 */
  index?: string;
  version?: string;
  log?: (line: string) => void;
}

/** 取回来的 Pack 放在实例根旁边，按来源分目录（兼容旧调用点）。 */
export function packCacheRoot(): string {
  return cacheRoot();
}

function slug(packRef: string): string {
  return (
    packRef
      .replace(/^git\+/, '')
      .replace(/\.phub$/, '')
      .replace(/[@/\\:]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(-40) || 'pack'
  );
}

/** 同一来源的不同版本必须落到不同目录：换版本时不会叠在旧文件上。 */
function variant(packRef: string, version?: string): string {
  if (version) return version.replace(/[^\w.-]+/g, '_');
  return createHash('sha256').update(packRef).digest('hex').slice(0, 10);
}

function manifestFile(dir: string): string | undefined {
  const direct = join(dir, 'packhub.yaml');
  return existsSync(direct) ? direct : undefined;
}

/**
 * 只清我们自己缓存目录下、这一层的落点：先确认路径在 cacheRoot 里面。
 * 绝不 rm 一个用户传进来的目录。
 */
function resetDir(dir: string): void {
  const base = resolve(cacheRoot());
  const target = resolve(dir);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`拒绝清理缓存目录之外的路径：${target}`);
  }
  if (target === base) throw new Error('拒绝清理缓存根');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
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

  const dest = join(packCacheRoot(), slug(packRef), variant(packRef, opts.version));
  resetDir(dest);
  opts.log?.(`→ 取 ${packRef}${opts.version ? `@${opts.version}` : ''}`);

  try {
    if (packRef.endsWith('.phub') || packRef.startsWith('git+')) {
      const resolved = await resolveAddSource(packRef, dest);
      if (!manifestFile(resolved.dir)) {
        throw new PalError('invalid-input', `取回来的目录里没有 packhub.yaml：${resolved.dir}`, {
          hint: '确认 .phub / git+ 指向的是一个 Pack 仓库',
        });
      }
      return resolved.dir;
    }

    const index = resolveRegistry(opts.index);
    if (!index) {
      throw new PalError('invalid-input', '用 registry 名称需要一个索引：--index <路径|URL>，或设 PACKHUB_INDEX', {
        hint: '也可以直接填 Pack 目录、.phub 或 git+https',
      });
    }
    const fetched = await fetchPack({
      name: packRef,
      index,
      dest,
      ...(opts.version ? { version: opts.version, allowUnlisted: true } : {}),
    });
    if (!manifestFile(fetched.dir)) {
      throw new PalError('invalid-input', `registry 归档里没有 packhub.yaml：${packRef}@${fetched.version}`);
    }
    return fetched.dir;
  } catch (err) {
    // 取失败不留半份：下次同版本重取，不会把旧文件和新的混在一起
    try {
      resetDir(dest);
      rmSync(dest, { recursive: true, force: true });
    } catch {
      /* 清不掉就留着，反正下次会先 reset */
    }
    throw err;
  }
}

/** 缓存里有哪些来源/版本，排障与界面用。 */
export function listPackCache(): Array<{ source: string; variant: string; dir: string; pack?: string }> {
  const base = packCacheRoot();
  if (!existsSync(base)) return [];
  const out: Array<{ source: string; variant: string; dir: string; pack?: string }> = [];
  for (const entry of safeDirs(base)) {
    const sourceDir = join(base, entry);
    for (const inner of safeDirs(sourceDir)) {
      const dir = join(sourceDir, inner);
      const item: { source: string; variant: string; dir: string; pack?: string } = {
        source: entry,
        variant: inner,
        dir,
      };
      try {
        const text = readFileSync(join(dir, 'packhub.yaml'), 'utf8');
        const name = /^\s*name:\s*(\S+)/m.exec(text)?.[1];
        if (name) item.pack = name;
      } catch {
        /* 不是完整 Pack 就只报目录 */
      }
      out.push(item);
    }
  }
  return out;
}

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
