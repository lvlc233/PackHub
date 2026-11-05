import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  loadPack,
  mergeManifest,
  validateGraph,
  type Issue,
  type PackContext,
} from '@packhub/kernel';
import { defaultRegistryIndex } from './config.ts';
import { fetchPack } from './registry.ts';

export interface LoadPackResolvedOptions {
  /** registry 索引；不传就按 PACKHUB_INDEX / 本机配置 */
  index?: string;
  /** 已展开的远程引用，用来报环 */
  seen?: string[];
}

/** 远程父 Pack 的落点：放进子包的缓存目录，plan 里的相对路径才跨机器一致。 */
function parentCacheDir(packDir: string, ref: string): string {
  const body = ref.replace(/^packhub:\/\//, '');
  const at = body.lastIndexOf('@');
  const name = at > 0 ? body.slice(0, at) : body;
  const version = at > 0 ? body.slice(at + 1) : 'latest';
  return join(packDir, '.packhub', 'cache', 'extends', ...name.split('/'), version);
}

/**
 * 读取 Pack，并把 `extends: packhub://scope/name@ver` 展开成本地合并结果。
 * 父包落在子包的 `.packhub/cache/extends/…`：只读、可缓存、路径相对子包且稳定。
 * 本地 `../` 继承由 kernel 处理；远程父包自己的 extends 会递归展开。
 */
export async function loadPackResolved(
  dir: string,
  opts: LoadPackResolvedOptions = {},
): Promise<PackContext> {
  const abs = resolve(dir);
  const ctx = loadPack(abs);
  const spec = ctx.manifest?.extends;
  if (!spec || !spec.startsWith('packhub://')) return ctx;

  const seen = opts.seen ?? [];
  if (seen.includes(spec)) {
    return {
      ...ctx,
      issues: [
        ...ctx.issues,
        {
          code: 'extends-cycle',
          severity: 'error',
          message: `远程 extends 成环：${[...seen, spec].join(' → ')}`,
        },
      ],
    };
  }
  if (!/^packhub:\/\/[a-z0-9-]+\/[a-z0-9-]+@[^\s]+$/.test(spec)) {
    return {
      ...ctx,
      issues: [
        ...ctx.issues,
        {
          code: 'extends-invalid',
          severity: 'error',
          message: `extends 引用不合法：${spec}（要 packhub://scope/name@version）`,
        },
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
  const cacheDir = parentCacheDir(abs, spec);
  const notes: Issue[] = [];

  if (!existsSync(join(cacheDir, 'packhub.yaml'))) {
    const work = mkdtempSync(join(tmpdir(), 'packhub-extends-'));
    try {
      const fetched = await fetchPack({ name, index, version, dest: work });
      if (fetched.version !== version) {
        notes.push({
          code: 'extends-version',
          severity: 'warning',
          message: `extends 要求 ${version}，registry 解析到 ${fetched.version}`,
        });
      }
      mkdirSync(dirname(cacheDir), { recursive: true });
      cpSync(work, cacheDir, { recursive: true, force: true });
    } catch (err) {
      return {
        ...ctx,
        issues: [
          ...ctx.issues,
          ...notes,
          {
            code: 'extends-fetch',
            severity: 'error',
            message: `父 Pack 取不到（${spec}）：${(err as Error).message}`,
          },
        ],
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  const parent = await loadPackResolved(cacheDir, { index, seen: [...seen, spec] });
  const parentErrors = parent.issues.filter((i) => i.severity === 'error');
  if (!parent.manifest || parentErrors.length > 0) {
    return {
      ...ctx,
      issues: [
        ...ctx.issues,
        ...notes,
        {
          code: 'extends-invalid',
          severity: 'error',
          message: `父 Pack（${spec}）不合法：${parentErrors.map((i) => i.message).join('; ')}`,
        },
      ],
    };
  }

  const merged = mergeManifest(parent.manifest, ctx.manifest, cacheDir, abs);
  const validated = validateGraph(merged);
  return {
    dir: abs,
    manifest: merged,
    graph: validated.graph,
    issues: [...ctx.issues, ...notes, ...validated.issues],
  };
}