import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Pack 装进实例后登记的 MCP 服务器（`.packhub/config.json` 里的 mcpServers）。 */
export interface McpServer {
  id: string;
  /** dsh 的 mcp-client 要求 [A-Za-z0-9_-]{1,32}，且在一个作用域内唯一 */
  serverName: string;
  transport: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

const MCP_CONFIG = '.packhub/config.json';
export const DSH_PATCH_FILE = 'pal-mcp.patch.yml';

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

/** serverName 只留合法字符；太长就截断并加短哈希，避免两个服务器撞名。 */
export function toServerName(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'mcp';
  if (cleaned.length <= 32) return cleaned;
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `${cleaned.slice(0, 23)}-${hash.toString(36).slice(0, 8)}`;
}

/** 读实例里登记的 MCP 服务器；读不到返回空数组。 */
export function readMcpServers(root: string): McpServer[] {
  const file = join(root, MCP_CONFIG);
  if (!existsSync(file)) return [];
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return [];
  }
  const servers = asRecord(data.mcpServers);
  const out: McpServer[] = [];
  const used = new Set<string>();
  for (const [id, raw] of Object.entries(servers)) {
    const spec = asRecord(raw);
    let serverName = toServerName(id);
    for (let n = 1; used.has(serverName); n += 1) serverName = toServerName(`${id}-${n}`);
    used.add(serverName);
    const url = typeof spec.url === 'string' ? spec.url : undefined;
    const command = typeof spec.command === 'string' ? spec.command : undefined;
    const transport =
      (typeof spec.transport === 'string' ? spec.transport : undefined) === 'http' || spec.transport === 'streamable-http'
        ? 'streamable-http'
        : url && !command
          ? 'streamable-http'
          : 'stdio';
    const server: McpServer = { id, serverName, transport };
    if (command) server.command = command;
    const args = asStringArray(spec.args);
    if (args.length > 0) server.args = args;
    const env = asStringMap(spec.env);
    if (Object.keys(env).length > 0) server.env = env;
    if (url) server.url = url;
    const headers = asStringMap(spec.headers);
    if (Object.keys(headers).length > 0) server.headers = headers;
    // 两种传输都不成立时跳过：写进 patch 也起不来
    if (transport === 'stdio' && !command) continue;
    if (transport === 'streamable-http' && !url) continue;
    out.push(server);
  }
  return out;
}

/** YAML 双引号标量：JSON 的字符串转义在 YAML 里合法。 */
function scalar(value: string): string {
  return JSON.stringify(value);
}

function renderRows(servers: McpServer[]): string {
  const lines: string[] = [];
  for (const server of servers) {
    lines.push(`    - id: pal-mcp-${server.serverName}`);
    lines.push("      name: '@deepseek-ai/dsh-mcp-client'");
    lines.push('      config:');
    lines.push(`        serverName: ${scalar(server.serverName)}`);
    lines.push(`        transport: ${server.transport}`);
    if (server.transport === 'stdio') {
      if (server.command) lines.push(`        command: ${scalar(server.command)}`);
      if (server.args?.length) {
        lines.push('        args:');
        for (const arg of server.args) lines.push(`          - ${scalar(arg)}`);
      }
    } else if (server.url) {
      lines.push(`        url: ${scalar(server.url)}`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push('        env:');
      for (const [key, value] of Object.entries(server.env)) lines.push(`          ${key}: ${scalar(value)}`);
    }
    if (server.headers && Object.keys(server.headers).length > 0) {
      lines.push('        headers:');
      for (const [key, value] of Object.entries(server.headers)) lines.push(`          ${key}: ${scalar(value)}`);
    }
  }
  return lines.join('\n');
}

/** 生成 dsh 的 --patch 文件内容；没有服务器就返回 undefined。 */
export function renderDshPatch(servers: McpServer[]): string | undefined {
  if (servers.length === 0) return undefined;
  return [
    '# 由 PAL 生成：把 Pack 里声明的 MCP 服务器接进这个 dsh 实例。',
    '# 每次启动前重写，手改会被覆盖；要加自己的服务器请改 Pack 或 home 里的 cordis.patch.yml。',
    '- insert:',
    renderRows(servers),
    '',
  ].join('\n');
}

export interface WritePatchResult {
  file: string;
  servers: number;
  /** 这次没写文件（没有服务器 / 不是 dsh）的原因 */
  skipped?: string;
}

/**
 * 把 Pack 的 MCP 资源写成 dsh 的 patch 层。
 * 没有服务器时删掉旧文件：上一次启动留下的服务器不会悄悄继续生效。
 */
export function writeDshMcpPatch(root: string, home: string): WritePatchResult {
  const file = join(home, DSH_PATCH_FILE);
  const servers = readMcpServers(root);
  const text = renderDshPatch(servers);
  if (!text) {
    rmSync(file, { force: true });
    return { file, servers: 0, skipped: '实例里没有登记 MCP 服务器' };
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
  return { file, servers: servers.length };
}
