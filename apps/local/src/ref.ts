/**
 * `name@version` 的唯一解析点。
 *
 * 命令里别再自己 `lastIndexOf('@')`：包名可能带 owner（`owner/name`），版本里不会
 * 再有 `@`，所以取最后一个 `@` 切。清单里的能力令牌（`tool/repo-search@1`）也带
 * `@`，但那是格式层的声明、不是命令引用，不走这里；两者别混着切。
 * 解析失败返回 undefined，由各命令决定提示文案与退出码（install 把 name@version
 * 当版本、update 回落到 registry latest，两者不一样）。
 */
export interface PackRef {
  name: string;
  version: string;
}

/** 解析 `name@version`；缺包名或缺版本返回 undefined。 */
export function parsePackRef(ref: string): PackRef | undefined {
  const at = ref.lastIndexOf('@');
  if (at <= 0 || at === ref.length - 1) return undefined;
  return { name: ref.slice(0, at), version: ref.slice(at + 1) };
}

/** 拼回 `name@version`。 */
export function formatPackRef(ref: PackRef): string {
  return `${ref.name}@${ref.version}`;
}
