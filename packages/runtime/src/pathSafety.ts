import { resolve, sep } from 'node:path';

/**
 * 把 relPath 解析到 root 之内，越界抛错。
 *
 * install 的写入面与 verify 的读取面共用这一条规则：解析后等于 base 或落在
 * `base + 分隔符` 之内才放行。用分隔符而不是裸前缀，是为了不把 /a 与 /ab 当同一棵目录；
 * 相等要单独放行，因为 `relPath` 为空或 `.` 时解析结果就是 base 本身。
 */
export function resolveWithin(root: string, relPath: string): string {
  const base = resolve(root);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`路径越界：${relPath}`);
  }
  return target;
}
