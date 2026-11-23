// MCP 的公共规则：serverName 合法化与 dsh 的 loader 条目形状。
//
// 有两处要为 dsh 生成同一种条目：launcher 每次启动 managed 实例时整份生成 `--patch` 文件
// （`pal-mcp.patch.yml`），kernel 给 attached 安装写进各 profile 的 `cordis.patch.yml`。
// 条目形状必须一致，所以纯函数放在这里，两边都从它派生；文本渲染留在 launcher——managed 的
// patch 是整份生成，不需要读回来合并，attached 的合并由 runtime 按 `list` 规则做。

/** dsh 的 mcp-client 要求 serverName 匹配 `[A-Za-z0-9_-]{1,32}`，且在一个作用域内唯一。 */
const SERVER_NAME_MAX = 32;

/** serverName 只留合法字符；太长就截断并加短哈希，避免两个服务器撞名。 */
export function toServerName(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'mcp';
  if (cleaned.length <= SERVER_NAME_MAX) return cleaned;
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `${cleaned.slice(0, SERVER_NAME_MAX - 9)}-${hash.toString(36).slice(0, 8)}`;
}

/**
 * 一个作用域内的 serverName 去重：先到先得，后来的按 `<id>-2`、`<id>-3` 改名。
 * 用它是为了「同一份计划里的两条资源不会算出同一个 serverName」——文件里的条目 id 由它派生。
 */
export function claimServerName(id: string, used: Set<string>): string {
  let name = toServerName(id);
  for (let n = 2; used.has(name); n += 1) name = toServerName(`${id}-${n}`);
  used.add(name);
  return name;
}

/** dsh 的 MCP loader 条目 id 前缀：条目按它认领（`pal-mcp-<serverName>`）。 */
export const DSH_MCP_ENTRY_PREFIX = 'pal-mcp-';

/** dsh 里承担 MCP 客户端的那一层 loader。 */
export const DSH_MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';

/** dsh mcp-client 的启动配置：字段顺序就是写进 patch 的顺序。 */
export interface McpLoaderConfig {
  serverName: string;
  transport: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function asStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(asRecord(value))) out[key] = String(item);
  return out;
}

/**
 * 通用 MCP spec（计划里 `register.mcp` 的 spec，或 `.packhub/config.json` 里的一条登记）→
 * dsh mcp-client 的 config。transport 归一成 `stdio` / `streamable-http`，env / headers 字符串化。
 *
 * 归一规则与 launcher 从一个实例的登记里读服务器时逐条一致：显式 http 就是 http；没写
 * transport 但有 url 且没有 command 的按 streamable-http；其余按 stdio。
 */
export function mcpLoaderConfig(spec: Record<string, unknown>, serverName: string): McpLoaderConfig {
  const url = typeof spec.url === 'string' ? spec.url : undefined;
  const command = typeof spec.command === 'string' ? spec.command : undefined;
  const declared = typeof spec.transport === 'string' ? spec.transport : undefined;
  const transport: McpLoaderConfig['transport'] =
    declared === 'http' || declared === 'streamable-http'
      ? 'streamable-http'
      : url && !command
        ? 'streamable-http'
        : 'stdio';
  const config: McpLoaderConfig = { serverName, transport };
  if (command) config.command = command;
  const args = asStringArray(spec.args);
  if (args.length > 0) config.args = args;
  const env = asStringMap(spec.env);
  if (Object.keys(env).length > 0) config.env = env;
  if (url) config.url = url;
  const headers = asStringMap(spec.headers);
  if (Object.keys(headers).length > 0) config.headers = headers;
  return config;
}

/** dsh 能不能真的拉起这条服务器：两种传输各自缺启动参数时写进 patch 也起不来。 */
export function mcpConfigRunnable(config: McpLoaderConfig): boolean {
  return config.transport === 'stdio' ? Boolean(config.command) : Boolean(config.url);
}

/**
 * 计划里的通用 spec → dsh profile patch 的 loader 条目。
 *
 * 条目的 `id` 是所有权标记：写进用户的 `cordis.patch.yml` 时按它认领，卸载只摘 `pal-mcp-*`
 * 这组条目；`serverName` 由调用方传（同一份计划里已经去过重）。
 */
export function dshMcpLoaderEntry(
  spec: Record<string, unknown>,
  serverName: string,
): Record<string, unknown> {
  return {
    id: `${DSH_MCP_ENTRY_PREFIX}${serverName}`,
    name: DSH_MCP_CLIENT,
    config: mcpLoaderConfig(spec, serverName),
  };
}
