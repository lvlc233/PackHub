import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  loadPack,
  mergeManifest,
  validateGraph,
  type Issue,
  type Manifest,
  type PackContext,
  type ResourceSpec,
} from '@packhub/kernel';
import { defaultRegistryIndex } from './config.ts';
import { fetchPack } from './registry.ts';

export interface LoadPackResolvedOptions {
  /** registry 索引；不传就按 PACKHUB_INDEX / 本机配置 */
  index?: string;
  /** 已展开的远程引用，用来报环 */
  seen?: string[];
}

const PACKHUB_REF = /^packhub:\/\/([a-z0-9-]+\/[a-z0-9-]+)@([^#\s]+)(?:#(.+))?$/;

function cacheRoot(packDir: string, kind: 'extends' | 'packhub', name: string, version: string): string {
  return join(packDir, '.packhub', 'cache', kind, ...name.split('/'), version);
}

/** 把一个 registry 版本取到子包的缓存目录；已有就直接用。 */
async function ensurePackCached(
  packDir: string,
  kind: 'extends' | 'packhub',
  name: string,
  version: string,
  index: string,
): Promise<string> {
  const dest = cacheRoot(packDir, kind, name, version);
  if (existsSync(join(dest, 'packhub.yaml'))) return dest;
  const work = mkdtempSync(join(tmpdir(), `packhub-${kind}-`));
  try {
    const fetched = await fetchPack({ name, index, version, dest: work });
    if (fetched.version !== version) {
      throw new Error(`registry 解析到 ${fetched.version}，与要求的 ${version} 不一致`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(work, dest, { recursive: true, force: true });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return dest;
}

async function applyExtends(
  abs: string,
  ctx: PackContext,
  opts: LoadPackResolvedOptions,
): Promise<PackContext> {
  const spec = ctx.manifest?.extends;
  if (!spec || !spec.startsWith('packhub://')) return ctx;

  const seen = opts.seen ?? [];
  if (seen.includes(spec)) {
    return {
      ...ctx,
      issues: [
        ...ctx.issues,
        { code: 'extends-cycle', severity: 'error', message: `远程 extends 成环：${[...seen, spec].join(' → ')}` },
      ],
    };
  }
  if (!/^packhub:\/\/[a-z0-9-]+\/[a-z0-9-]+@[^\s]+$/.test(spec)) {
    return {
      ...ctx,
      issues: [
        ...ctx.issues,
        { code: 'extends-invalid', severity: 'error', message: `extends 引用不合法：${spec}（要 packhub://scope/name@version）` },
      ],
    };
  }

  const index = opts.index ?? defaultRegistryIndex();
  if (!index) {
    return {
      ...ctx,
      issues: [
        ...ctx.issues,
        {
          code: 'extends-unresolved',
          severity: 'error',
          message: `远程 extends 需要 registry 索引：加 --index，或设 PACKHUB_INDEX（${spec}）`,
        },
      ],
    };
  }

  const body = spec.replace(/^packhub:\/\//, '');
  const at = body.lastIndexOf('@');
  const name = body.slice(0, at);
  const version = body.slice(at + 1);
  let cacheDir: string;
  try {
    cacheDir = await ensurePackCached(abs, 'extends', name, version, index);
  } catch (err) {
    return {
      ...ctx,
      issues: [
        ...ctx.issues,
        { code: 'extends-fetch', severity: 'error', message: `父 Pack 取不到（${spec}）：${(err as Error).message}` },
      ],
    };
  }

  const parent = await loadPackResolved(cacheDir, { index, seen: [...seen, spec] });
  const parentErrors = parent.issues.filter((i) => i.severity === 'error');
  if (!parent.manifest || parentErrors.length > 0) {
    return {
      ...ctx,
      issues: [
        ...ctx.issues,
        { code: 'extends-invalid', severity: 'error', message: `父 Pack（${spec}）不合法：${parentErrors.map((i) => i.message).join('; ')}` },
      ],
    };
  }

  const merged = mergeManifest(parent.manifest, ctx.manifest, cacheDir, abs);
  const validated = validateGraph(merged);
  return {
    dir: abs,
    manifest: merged,
    graph: validated.graph,
    issues: [...ctx.issues, ...validated.issues],
  };
}

/**
 * 资源级 `packhub://scope/name@ver#path`：把引用包取进缓存，再把 source 改写成
 * 缓存里的相对路径。之后 kernel 照常按本地资源出计划，planHash 跨机器稳定。
 */
async function materializePackhubSources(
  abs: string,
  ctx: PackContext,
  index: string | undefined,
): Promise<PackContext> {
  const resources = ctx.manifest?.resources ?? [];
  if (!resources.some((r) => r.source.startsWith('packhub://'))) return ctx;

  const issues: Issue[] = [];
  const next: ResourceSpec[] = [];
  for (const res of resources) {
    if (!res.source.startsWith('packhub://')) {
      next.push(res);
      continue;
    }
    const parsed = PACKHUB_REF.exec(res.source);
    if (!parsed) {
      issues.push({
        code: 'packhub-source-invalid',
        severity: 'error',
        message: `资源 ${res.id} 的 packhub:// 引用不合法：${res.source}（要 packhub://scope/name@ver#path）`,
      });
      next.push(res);
      continue;
    }
    const [, name, version, subpath] = parsed;
    if (!subpath) {
      issues.push({
        code: 'packhub-source-path',
        severity: 'error',
        message: `资源 ${res.id} 必须写归档内路径：packhub://${name}@${version}#docs/x.md`,
      });
      next.push(res);
      continue;
    }
    if (!['knowledge', 'prompt', 'config', 'skill'].includes(res.type)) {
      issues.push({
        code: 'packhub-source-type',
        severity: 'error',
        message: `资源级 packhub:// 只支持 knowledge / prompt / config / skill（${res.id} 是 ${res.type}）`,
      });
      next.push(res);
      continue;
    }
    if (!index) {
      issues.push({
        code: 'packhub-source-unresolved',
        severity: 'error',
        message: `资源级 packhub:// 需要 registry 索引：加 --index，或设 PACKHUB_INDEX（${res.id}）`,
      });
      next.push(res);
      continue;
    }
    let dir: string;
    try {
      dir = await ensurePackCached(abs, 'packhub', name!, version!, index);
    } catch (err) {
      issues.push({
        code: 'packhub-source-fetch',
        severity: 'error',
        message: `资源 ${res.id} 的包取不到（${res.source}）：${(err as Error).message}`,
      });
      next.push(res);
      continue;
    }
    const target = resolve(dir, subpath);
    if (!target.startsWith(resolve(dir) + (process.platform === 'win32' ? '\\' : '/'))) {
      issues.push({
        code: 'packhub-source-escape',
        severity: 'error',
        message: `资源 ${res.id} 的路径逃出了归档：${subpath}`,
      });
      next.push(res);
      continue;
    }
    if (!existsSync(target)) {
      issues.push({
        code: 'packhub-source-missing',
        severity: 'error',
        message: `资源 ${res.id} 在 ${name}@${version} 里找不到：${subpath}`,
      });
      next.push(res);
      continue;
    }
    const isDir = statSync(target).isDirectory();
    if ((res.type === 'skill') !== isDir) {
      issues.push({
        code: 'packhub-source-kind',
        severity: 'error',
        message: `资源 ${res.id} 的路径类型不对：${res.type} 需要${res.type === 'skill' ? '目录' : '文件'}`,
      });
      next.push(res);
      continue;
    }
    next.push({
      ...res,
      source: `./.packhub/cache/packhub/${name!.split('/').join('/')}/${version}/${subpath.replace(/^\.\//, '')}`,
    });
  }

  const manifest: Manifest = { ...ctx.manifest, resources: next };
  const validated = validateGraph(manifest);
  // 改写前的 source 校验（pin 冲突等）已经过时，不能带进结果
  const stale = new Set(['pin-conflict', 'unpinned-source', 'http-missing-integrity']);
  const base = ctx.issues.filter((i) => !stale.has(i.code));
  return { ...ctx, manifest, graph: validated.graph, issues: [...base, ...issues, ...validated.issues] };
}

/**
 * 读取 Pack，并展开两类 registry 引用：`extends` 与资源级 `packhub://`。
 * 父包/被引用包落在子包的 `.packhub/cache/…`：只读、可缓存、相对路径稳定。
 */
export async function loadPackResolved(
  dir: string,
  opts: LoadPackResolvedOptions = {},
): Promise<PackContext> {
  const abs = resolve(dir);
  const index = opts.index ?? defaultRegistryIndex();
  const withExtends = await applyExtends(abs, loadPack(abs), opts);
  if (!withExtends.manifest) return withExtends;
  return materializePackhubSources(abs, withExtends, index);
}