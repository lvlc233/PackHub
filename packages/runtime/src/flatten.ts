import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { loadPack, planFor, type Manifest } from '@packhub/kernel';
import { loadPackResolved, type LoadPackResolvedOptions } from './extends.ts';
import { readSignatures, SIGNATURE_FILE, type SignatureEntry } from './signfile.ts';
import { verifySignatures } from './signature.ts';

export interface FlattenResult {
  /** 可以拿去 run / lock / publish 的目录；没有远程引用时就是原目录 */
  dir: string;
  manifest: Manifest;
  warnings: string[];
  /** 临时目录的清理函数；原目录时是空操作 */
  cleanup: () => void;
}

const CACHE_MARKER = `${'.packhub'}/cache/`;
/** 包目录外的本地资源落到这里；归档与版本目录只带包目录，所以必须先搬进来。 */
const LOCAL_DIR = 'external/local';

function isLocalSource(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../');
}

/** 解析后确实落在包目录外（本地 extends 常见的 `../base/resources/x`）。 */
function escapesRoot(root: string, source: string): boolean {
  const base = resolve(root);
  const target = resolve(base, source);
  return target !== base && !target.startsWith(base + sep);
}

/**
 * 把远程 extends / 资源级 packhub:// / 包目录外的本地资源展开成自包含目录：
 * 被引用的文件复制到 `external/`，清单改成本地 source，`extends` 去掉。
 * 发布的版本目录与 `.phub` 都从扁平化后的目录生成，消费端不再需要父包。
 */
export async function flattenPack(
  dir: string,
  opts: LoadPackResolvedOptions = {},
): Promise<FlattenResult> {
  const abs = resolve(dir);
  const ctx = await loadPackResolved(abs, opts);
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (!ctx.manifest || errors.length > 0) {
    throw new Error(`清单不合法，无法扁平化：${errors.map((e) => e.message).join('; ')}`);
  }

  const remoteExtends = ctx.manifest.extends?.startsWith('packhub://') ?? false;
  const remoteResources = ctx.manifest.resources.some((r) => r.source.includes(CACHE_MARKER));
  const remoteOverlays = (ctx.manifest.overlays ?? []).some((o) => o.from.includes(CACHE_MARKER));
  const outside = [
    ...ctx.manifest.resources.map((res) => res.source),
    ...(ctx.manifest.overlays ?? []).map((ov) => ov.from),
  ].filter((source) => isLocalSource(source) && escapesRoot(abs, source));
  if (!remoteExtends && !remoteResources && !remoteOverlays && outside.length === 0) {
    return { dir: abs, manifest: ctx.manifest, warnings: [], cleanup: () => {} };
  }

  const work = mkdtempSync(join(tmpdir(), 'packhub-flatten-'));
  cpSync(abs, work, {
    recursive: true,
    force: true,
    filter: (src) => {
      const name = src.split(/[\\/]/).pop() ?? '';
      if (!name) return true;
      if (src === abs) return true;
      return !['.packhub', '.git', 'node_modules', 'dist'].includes(name) && !name.endsWith('.phub');
    },
  });
  // 旧锁绑在原先的计划上，扁平化后必须重新生成；签名则要先验证是否对得上新计划
  rmSync(join(work, 'packhub.lock.json'), { force: true });
  const originalFileSigs = readSignatures(abs);

  const cacheRoot = join(abs, '.packhub', 'cache');
  const warnings: string[] = [];
  const copied = new Map<string, string>();
  const usedNames = new Set<string>();

  const materialize = (source: string): string => {
    const target = resolve(abs, source);
    if (target.startsWith(cacheRoot)) {
      const rel = relative(cacheRoot, target).split(/[\\/]/).join('/');
      const destRel = `external/${rel}`;
      const dest = join(work, destRel.split('/').join(requireSep()));
      cpSync(target, dest, { recursive: true, force: true });
      return `./${destRel}`;
    }
    // 本地 extends 父包里的文件在包目录外：归档和版本目录都只带包目录，先搬进来再改路径。
    if (!isLocalSource(source) || !escapesRoot(abs, source)) return source;
    const known = copied.get(target);
    if (known) return known;
    const name = target.split(/[\\/]/).filter(Boolean).pop() ?? 'entry';
    let destRel = `${LOCAL_DIR}/${name}`;
    for (let i = 2; usedNames.has(destRel); i += 1) destRel = `${LOCAL_DIR}/${i}-${name}`;
    usedNames.add(destRel);
    cpSync(target, join(work, destRel.split('/').join(requireSep())), { recursive: true, force: true });
    const rewritten = `./${destRel}`;
    copied.set(target, rewritten);
    return rewritten;
  };

  const manifest: Manifest = {
    ...ctx.manifest,
    extends: undefined,
    resources: ctx.manifest.resources.map((res) => ({ ...res, source: materialize(res.source) })),
    overlays: (ctx.manifest.overlays ?? []).map((ov) => ({ ...ov, from: materialize(ov.from) })),
    signatures: [],
  };
  if (remoteExtends) warnings.push('扁平化去掉了远程 extends；发布的是合并后的自包含清单');
  if (copied.size > 0) {
    warnings.push(`把 ${copied.size} 条包目录外的本地资源复制进 ${LOCAL_DIR}/；清单里的路径已改写`);
  }

  // 先写一版清单算扁平化后的计划，再把能对上这个计划的签名留下。
  // 这样「对原包 sign → publish 自动扁平化」不会因为计划变了而把签名静默丢掉。
  writeFileSync(join(work, 'packhub.yaml'), stringifyYaml(manifest), 'utf8');
  const pack = `${manifest.metadata.name}@${manifest.metadata.version}`;
  const flatCtx = loadPack(work);
  const flatPlan = planFor(flatCtx, { target: 'dir' }).plan;
  const keep = (entries: SignatureEntry[]): SignatureEntry[] => {
    if (!flatPlan || entries.length === 0) return [];
    return entries.filter((entry) => verifySignatures([entry], pack, flatPlan.planHash)[0]?.ok === true);
  };
  const fileSigs = keep(originalFileSigs);
  const manifestSigs = keep(ctx.manifest.signatures ?? []);
  if (fileSigs.length < originalFileSigs.length || manifestSigs.length < (ctx.manifest.signatures ?? []).length) {
    warnings.push('有签名对应的是扁平化前的计划，已移除；发布前请对扁平化后的清单重新 sign');
  }
  manifest.signatures = manifestSigs;
  writeFileSync(join(work, 'packhub.yaml'), stringifyYaml(manifest), 'utf8');
  if (fileSigs.length > 0) {
    writeFileSync(
      join(work, SIGNATURE_FILE),
      JSON.stringify({ apiVersion: 'packhub.dev/signatures/v0', signatures: fileSigs }, null, 2) + '\n',
      'utf8',
    );
  } else {
    rmSync(join(work, SIGNATURE_FILE), { force: true });
  }

  return {
    dir: work,
    manifest,
    warnings,
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  };
}

function requireSep(): string {
  return process.platform === 'win32' ? '\\' : '/';
}