import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { fetchPack, loadManifest, resolveAddSource, resolveRegistry } from '@packhub/runtime';
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

/** 可读尾段的上限；加 1 个分隔符与 10 位哈希后，目录名最长 51 字符（要求 ≤60）。 */
const SLUG_TAIL = 40;
/** 完整 packRef 的 sha256 短哈希长度（要求 ≥8 hex）。 */
const SLUG_HASH = 10;

/**
 * 把 Pack 引用映射成缓存目录名：可读尾段（最多 40 字符）+ 完整引用的 sha256 前 10 hex。
 * 单看末 40 字符时，前段不同、尾段相同的长引用会共用一个目录，所以哈希必须覆盖整串。
 * 名称清掉 Windows 非法字符，并去掉首尾的连字符/点/空格（不能以点或空格结尾，也不会得到 . / ..）。
 *
 * @internal 导出只为单元测试直接用；包对外入口（index.ts）没有再导出它。
 */
export function slug(packRef: string): string {
  const readable = packRef
    .replace(/^git\+/, '')
    .replace(/\.phub$/, '')
    .replace(/[@/\\:?*"<>|]+/g, '-')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .replace(/^[-. ]+|[-. ]+$/g, '')
    .slice(-SLUG_TAIL)
    .replace(/^[-. ]+|[-. ]+$/g, '');
  const hash = createHash('sha256').update(packRef).digest('hex').slice(0, SLUG_HASH);
  return `${readable || 'pack'}-${hash}`;
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

/** 直接取回来的来源：.phub 归档与 git+，不按 registry 版本落在缓存目录里。 */
function isDirectSource(packRef: string): boolean {
  return packRef.endsWith('.phub') || packRef.startsWith('git+');
}

/**
 * 明确版本：只有这种才按目录复用。latest / * / 范围（^ ~ > < = | 空格）都会变，
 * 复用会把旧内容当新版本发出去。
 */
function isPinnedVersion(version?: string): version is string {
  if (!version) return false;
  if (/^(latest|\*|x)$/i.test(version)) return false;
  return !/[\s^~<>*=|]/.test(version);
}

/** 缓存目录里已有清单的版本；清单缺了或读不了就当没缓存。 */
function cachedVersion(dest: string): string | undefined {
  const file = manifestFile(dest);
  if (!file) return undefined;
  try {
    return loadManifest(file).manifest?.metadata.version;
  } catch {
    return undefined;
  }
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

  // C5：明确版本 + registry 来源时，目录里已有同版本清单就直接复用，不 reset 不 fetch。
  // latest 未知、.phub/git+ 内容可能被上游换掉，都仍然重取。
  if (!isDirectSource(packRef) && isPinnedVersion(opts.version) && cachedVersion(dest) === opts.version) {
    opts.log?.(`缓存命中 ${packRef}@${opts.version} → ${dest}`);
    return dest;
  }

  resetDir(dest);
  opts.log?.(`→ 取 ${packRef}${opts.version ? `@${opts.version}` : ''}`);

  try {
    if (isDirectSource(packRef)) {
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
