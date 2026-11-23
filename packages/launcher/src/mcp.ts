import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  claimServerName,
  DSH_MCP_CLIENT,
  DSH_MCP_ENTRY_PREFIX,
  mcpConfigRunnable,
  mcpLoaderConfig,
  STATE_DIR,
  type McpLoaderConfig,
} from '@packhub/kernel';
import { writeAtomic } from './atomic.ts';

/**
 * Pack 装进实例后登记的 MCP 服务器（`.packhub/config.json` 里的 mcpServers）。
 *
 * `serverName` / `transport` 与条目形状由 kernel 的 `mcpLoaderConfig` 归一：attached 安装写
 * profile patch 时用的是同一份规则，两处写进 dsh 的条目必须一致。
 */
export interface McpServer extends McpLoaderConfig {
  id: string;
}

const MCP_CONFIG = `${STATE_DIR}/config.json`;
export const DSH_PATCH_FILE = 'pal-mcp.patch.yml';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
    const config = mcpLoaderConfig(asRecord(raw), claimServerName(id, used));
    // 两种传输都不成立时跳过：写进 patch 也起不来
    if (!mcpConfigRunnable(config)) continue;
    out.push({ id, ...config });
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
    lines.push(`    - id: ${DSH_MCP_ENTRY_PREFIX}${server.serverName}`);
    lines.push(`      name: '${DSH_MCP_CLIENT}'`);
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
  writeAtomic(file, text);
  return { file, servers: servers.length };
}
