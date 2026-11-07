import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as tar from 'tar';
import { loadPack, parseSource } from '@packhub/kernel';

export interface PackArchiveOptions {
  /**
   * 默认自包含（vendored）：本地内容一起进归档，离线可装。
   * 显式传 false 才是 reference 模式：只打清单与锁，安装时按 source 去取。
   */
  vendored?: boolean;
  /** 覆盖输出路径 */
  out?: string;
}

export interface PackArchiveResult {
  file: string;
  entries: string[];
  bytes: number;
}

/** reference 模式装不上：清单里有本地来源，归档里却没有那些文件。 */
export class LocalSourceNotVendoredError extends Error {
  readonly sources: string[];

  constructor(sources: string[]) {
    const shown = sources.slice(0, 3).map((s) => `  ${s}`).join('\n');
    super(
      `清单里有 ${sources.length} 条本地来源，reference 模式打出来装不上：\n${shown}${sources.length > 3 ? '\n  …' : ''}\n去掉 --reference（默认自包含），或把这些内容换成可远程获取的来源。`,
    );
    this.name = 'local-source-not-vendored';
    this.sources = sources;
  }
}

/** vendored 归档会带上的顶层条目；安装状态、依赖、构建产物与旧归档不算。 */
export function vendoredEntries(root: string): string[] {
  const skip = new Set(['.packhub', 'node_modules', '.git', 'dist']);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => !skip.has(entry.name))
    .filter((entry) => !(entry.isFile() && (entry.name.endsWith('.phub') || entry.name.endsWith('.tar.gz'))))
    .map((entry) => entry.name)
    .sort();
}

/** 清单里指向本机文件的来源（./）；这些字节不在清单里。 */
export function localSources(root: string): string[] {
  const ctx = loadPack(root);
  return (ctx.manifest?.resources ?? [])
    .map((res) => res.source)
    .filter((source) => parseSource(source).kind === 'local');
}

/**
 * 封装：把 Pack 目录打成 `.phub`（tar.gz）。只带清单、锁与要随包走的内容，不生成安装计划。
 * 默认自包含；reference 只适合全部来源都能在安装时远程取到的包。
 */
export async function packArchive(
  root: string,
  opts: PackArchiveOptions = {},
): Promise<PackArchiveResult> {
  const manifest = join(root, 'packhub.yaml');
  if (!existsSync(manifest)) throw new Error(`没有 packhub.yaml：${root}`);

  const vendored = opts.vendored !== false;
  const locals = localSources(root);
  if (!vendored && locals.length > 0) {
    // reference 模式只可能对远程来源成立：./ 的文件不在归档里，装到 write 那步必然 ENOENT。
    throw new LocalSourceNotVendoredError(locals);
  }

  const entries = ['packhub.yaml', 'packhub.lock.json', 'packhub.signatures.json'].filter((f) =>
    existsSync(join(root, f)),
  );
  if (vendored) entries.push(...vendoredEntries(root));

  const out = opts.out ?? join(root, 'pack.phub');
  mkdirSync(dirname(out), { recursive: true });
  const unique = [...new Set(entries)];
  await tar.c({ gzip: true, file: out, cwd: root, portable: true }, unique);
  return { file: out, entries: unique, bytes: statSync(out).size };
}

/** 拒绝逃出目标目录的路径与链接条目；解包与测试共用同一条规则。 */
export function isSafeArchiveEntry(path: string, entry?: unknown): boolean {
  const type = (entry as { type?: string } | undefined)?.type;
  const normalized = path.replace(/\\/g, '/');
  const absolute = normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
  return !absolute && !normalized.split('/').includes('..') && type !== 'SymbolicLink' && type !== 'Link';
}

/** 解包 `.phub` 到目录（strip 0：归档内就是 Pack 根）。 */
export async function unpackArchive(file: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  await tar.x({
    file,
    cwd: dest,
    filter: (path, entry) => isSafeArchiveEntry(path, entry),
  });
}
