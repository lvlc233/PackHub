import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseCatalog, type CatalogEntry } from '@packhub/kernel';
import { httpJson } from './download.ts';

export interface CatalogLoadResult {
  entries: CatalogEntry[];
  /** 目录来自哪：本地路径、URL 或 npm 搜索 */
  source: string;
  /** 加载失败时的原因；调用方决定是报错还是只提示 */
  error?: string;
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** 默认资源目录：与 index.json 同目录的 resources.json。 */
export function catalogPathNear(indexRef: string): string {
  if (isUrl(indexRef)) return new URL('resources.json', indexRef).toString();
  return join(dirname(resolve(indexRef)), 'resources.json');
}

/** 读一份资源目录；`--catalog` 可直接指向文件或 URL。 */
export async function loadCatalog(opts: { catalog?: string; index?: string } = {}): Promise<CatalogLoadResult> {
  const explicit = opts.catalog ?? process.env.PACKHUB_CATALOG;
  const ref = explicit ?? (opts.index ? catalogPathNear(opts.index) : undefined);
  if (!ref) {
    return { entries: [], source: 'none', error: '没有资源目录：加 --catalog <文件|URL>，或设 PACKHUB_CATALOG' };
  }
  let raw: unknown;
  try {
    if (isUrl(ref)) {
      raw = await httpJson(ref);
    } else {
      if (!existsSync(ref)) {
        return {
          entries: [],
          source: ref,
          error: `资源目录不存在：${ref}（registry 可以把 resources.json 和 index.json 放一起）`,
        };
      }
      raw = JSON.parse(readFileSync(ref, 'utf8'));
    }
  } catch (err) {
    return { entries: [], source: ref, error: `资源目录读取失败：${(err as Error).message}` };
  }
  const { catalog, issues } = parseCatalog(raw);
  if (!catalog) {
    return { entries: [], source: ref, error: issues.map((i) => i.message).join('; ') };
  }
  return { entries: catalog.resources, source: ref };
}

interface NpmSearchPayload {
  objects?: {
    package?: {
      name?: string;
      version?: string;
      description?: string;
      keywords?: string[];
      links?: { homepage?: string };
    };
  }[];
}

/**
 * 查 npm registry 的搜索接口，把结果映射成候选。
 * 只做“发现”：是否真是 MCP server 由关键词猜，装之前仍要看上游文档。
 */
export async function searchNpm(
  keyword: string,
  limit = 8,
): Promise<{ entries: CatalogEntry[]; error?: string }> {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(keyword)}&size=${Math.min(limit, 20)}`;
  try {
    const payload = await httpJson<NpmSearchPayload>(url);
    const entries: CatalogEntry[] = [];
    for (const item of payload.objects ?? []) {
      const pkg = item.package;
      if (!pkg?.name || !pkg.version) continue;
      const text = `${pkg.name} ${pkg.description ?? ''} ${(pkg.keywords ?? []).join(' ')}`.toLowerCase();
      const type = /mcp|model context protocol|modelcontextprotocol/.test(text) ? 'mcp' : 'tool';
      entries.push({
        id: `npm-${pkg.name.replace(/[^a-zA-Z0-9._-]+/g, '-')}`,
        type,
        source: `npm:${pkg.name}@${pkg.version}`,
        ...(pkg.description ? { title: pkg.name, description: pkg.description } : { title: pkg.name }),
        ...(pkg.keywords ? { keywords: pkg.keywords } : {}),
        ...(pkg.links?.homepage ? { homepage: pkg.links.homepage } : {}),
      });
    }
    return { entries };
  } catch (err) {
    return { entries: [], error: `npm 搜索失败：${(err as Error).message}` };
  }
}
