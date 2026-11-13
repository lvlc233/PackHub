/**
 * 带版本 JSON 的统一闸门。
 *
 * 契约：v0 只认当前代际；读方遇到不认识的主版本、或根本没有 `apiVersion` 的文件，一律拒绝。
 * 不再把「缺 apiVersion」当同代际早期文件补上——重构期不认旧格式。
 */
export function assertApiVersion(file: string, value: unknown, expected: string): void {
  const api = (value as { apiVersion?: unknown } | null)?.apiVersion;
  if (api === expected) return;
  throw new Error(
    api === undefined
      ? `${file} 没有 apiVersion（只认 ${expected}）；旧格式不再兼容，重新生成或删掉它`
      : `${file} 的格式版本不认识：${String(api)}（只认 ${expected}）；它可能是更高版本的 PackHub 写的，先备份再处理`,
  );
}
