import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * 原子写文件：同目录写临时文件，再 rename 覆盖目标。
 *
 * launcher 里所有「临时文件 + rename」都从这里走，一处维护。各调用点原来的差异
 * （临时文件名格式、mode、失败时删不删临时文件、写前建不建目录）全部走 opts，
 * 调用点不再手写 writeFileSync + renameSync。新增调用点时先看清上面四条：
 * 不删临时文件的现场是有意的，别顺手统一成删。
 */
export interface WriteAtomicOptions {
  /** 原子写之前 mkdir -p 这个目录（通常是 dirname(file)）；不给就不建。 */
  mkdir?: string;
  /** 新文件的 mode（secrets 用 0o600）；不给走 Node 默认。 */
  mode?: number;
  /** 临时文件名后缀，直接拼在目标路径后面；默认 `.tmp-${process.pid}`。 */
  tmpSuffix?: string;
  /** 写临时文件或 rename 失败时删掉临时文件；默认留下。 */
  cleanupOnFailure?: boolean;
}

/**
 * 写 data 到 file：先写 `<file><tmpSuffix>`，再 rename。
 * 失败一律原样抛出（不包装成 PalError：各调用点的错误文案与分类不一样，留给它们自己包）。
 */
export function writeAtomic(file: string, data: string | Uint8Array, opts: WriteAtomicOptions = {}): void {
  if (opts.mkdir !== undefined) mkdirSync(opts.mkdir, { recursive: true });
  const tmp = `${file}${opts.tmpSuffix ?? `.tmp-${process.pid}`}`;
  try {
    writeFileSync(tmp, data, opts.mode === undefined ? 'utf8' : { encoding: 'utf8', mode: opts.mode });
    renameSync(tmp, file);
  } catch (err) {
    if (opts.cleanupOnFailure) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* 临时文件删不掉就留着，不影响主流程 */
      }
    }
    throw err;
  }
}
