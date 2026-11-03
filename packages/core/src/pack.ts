import { existsSync, mkdirSync, statSync } from 'node:fs';
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

  const entries = ['packhub.yaml', 'packhub.lock.json'].filter((f) => existsSync(join(root, f)));
  if (opts.vendored) {
    for (const dir of VENDOR_DIRS) {
      if (existsSync(join(root, dir))) entries.push(dir);
    }
  }

  const out = opts.out ?? join(root, 'pack.phub');
  mkdirSync(dirname(out), { recursive: true });
  await tar.c({ gzip: true, file: out, cwd: root, portable: true }, entries);
  return { file: out, entries, bytes: statSync(out).size };
}

/** 解包 `.phub` 到目录（strip 0：归档内就是 Pack 根）。 */
export async function unpackArchive(file: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  await tar.x({
    file,
    cwd: dest,
    filter: (path) => !path.split('/').includes('..'),
  });
}
