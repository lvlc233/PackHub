import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as tar from 'tar';

export interface PackArchiveOptions {
  /** vendored：把本地资源一起装进归档，离线可装；默认只带清单与锁 */
  vendored?: boolean;
  /** 覆盖输出路径 */
  out?: string;
}

export interface PackArchiveResult {
  file: string;
  entries: string[];
  bytes: number;
}

/** 需要随包走的本地目录（vendored 模式）。 */
const VENDOR_DIRS = ['resources', 'fragments', 'overrides', 'skills', 'glue'];

/**
 * 把 Pack 打成 `.phub`（tar.gz）：清单 + 锁（+ 可选本地资源）。
 * 产物是分发的唯一载体，解包后即可 plan/install。
 */
export async function packArchive(
  root: string,
  opts: PackArchiveOptions = {},
): Promise<PackArchiveResult> {
  const manifest = join(root, 'packhub.yaml');
  if (!existsSync(manifest)) throw new Error(`没有 packhub.yaml：${root}`);

  const entries = ['packhub.yaml', 'packhub.lock.json', 'packhub.signatures.json'].filter((f) =>
    existsSync(join(root, f)),
  );
  if (opts.vendored) {
    // vendored：把本地引用到的东西都带上。不按固定目录列，避免漏掉根目录下的文件
    const skip = new Set(['.packhub', 'node_modules', '.git', 'dist']);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      if (entry.isFile() && (entry.name === 'pack.phub' || entry.name.endsWith('.tar.gz'))) continue;
      entries.push(entry.name);
    }
  }

  const out = opts.out ?? join(root, 'pack.phub');
  mkdirSync(dirname(out), { recursive: true });
  const unique = [...new Set(entries)];
  await tar.c({ gzip: true, file: out, cwd: root, portable: true }, unique);
  return { file: out, entries: unique, bytes: statSync(out).size };
}

/** 拒绝逃出目标目录的路径与链接条目；解包与测试共用同一条规则。 */
export function isSafeArchiveEntry(path: string, entry?: unknown): boolean {
  const type = (entry as { type?: string } | undefined)?.type;
  return !path.split('/').includes('..') && type !== 'SymbolicLink' && type !== 'Link';
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
