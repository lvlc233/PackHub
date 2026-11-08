import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { failedRoot, quarantineRoot, stamp } from './paths.ts';
import { nowIso } from './time.ts';

/**
 * 坏记录与失败现场的搬移：只做「挪走 + 留原因」，不删、不改用户目录里的东西。
 * 落点在 paths.ts（隔离区 / .failed）；归档复用 moveAside，但归档本身不在这里判断。
 */

/** 内部工具：把 from 整个挪到 dir 下，附 reason.json；挪不动就返回 undefined。 */
export function moveAside(from: string, dir: string, meta: Record<string, unknown>): string | undefined {
  const target = join(dir, `${basename(from)}-${stamp()}`);
  try {
    mkdirSync(dir, { recursive: true });
    renameSync(from, target);
    writeFileSync(join(target, 'reason.json'), JSON.stringify({ at: nowIso(), ...meta }, null, 2) + '\n', 'utf8');
    return target;
  } catch {
    return undefined;
  }
}

/** 坏记录隔离：移出实例列表，保留现场和原因，可以人工搬回来。 */
export function quarantineInstance(root: string, reason: string, link?: string): string | undefined {
  if (link) {
    // 记录在用户的目录里：只收走指针与原因，用户的目录一个字节都不动
    const dir = join(quarantineRoot(), `${basename(root)}-${stamp()}`);
    try {
      mkdirSync(dir, { recursive: true });
      renameSync(link, join(dir, 'link.json'));
      writeFileSync(join(dir, 'reason.json'), JSON.stringify({ at: nowIso(), reason, from: root }, null, 2) + '\n', 'utf8');
      return dir;
    } catch {
      return undefined;
    }
  }
  return moveAside(root, quarantineRoot(), { reason, from: root });
}

/** 建实例失败时的现场：整根移到 .failed，不留半个实例在列表里。 */
export function failInstance(root: string, error: { code: string; message: string }): string | undefined {
  return moveAside(root, failedRoot(), error);
}
