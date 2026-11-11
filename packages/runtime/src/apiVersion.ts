/**
 * 带版本 JSON 的统一闸门。
 *
 * 契约：v0 只认当前代际，读方遇到不认识的主版本必须拒绝，不得猜字段。
 * 缺 `apiVersion` 的老文件按 v0 处理（写回时补上）——那是同代际的早期文件，不是别的格式。
 */
export function assertApiVersion(file: string, value: unknown, expected: string): void {
  const api = (value as { apiVersion?: unknown } | null)?.apiVersion;
  if (api === undefined || api === expected) return;
  throw new Error(
    `${file} 的格式版本不认识：${String(api)}（只认 ${expected}）；它可能是更高版本的 PackHub 写的，先备份再处理`,
  );
}
