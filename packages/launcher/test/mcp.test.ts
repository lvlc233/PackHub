import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DSH_PATCH_FILE,
  readMcpServers,
  renderDshPatch,
  toServerName,
  writeDshMcpPatch,
} from '../src/mcp.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-mcp-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(dir: string, servers: Record<string, unknown>): void {
  mkdirSync(join(dir, '.packhub'), { recursive: true });
  writeFileSync(join(dir, '.packhub', 'config.json'), JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');
}

describe('Pack 的 MCP 资源接进 dsh', () => {
  it('读实例里登记的服务器：stdio 与 http 都认', () => {
    const root = join(tmp, 'inst');
    mkdirSync(root, { recursive: true });
    writeConfig(root, {
      'repo-search': { command: 'npx', args: ['-y', 'srv'], env: { TOKEN: 'x' } },
      'remote': { url: 'https://mcp.example/mcp', transport: 'http', headers: { Authorization: 'Bearer y' } },
      'broken': { args: ['-y', 'x'] },
    });
    const servers = readMcpServers(root);
    expect(servers.map((server) => server.id)).toEqual(['repo-search', 'remote']);
    expect(servers[0]).toMatchObject({ serverName: 'repo-search', transport: 'stdio', command: 'npx' });
    expect(servers[1]).toMatchObject({ transport: 'streamable-http', url: 'https://mcp.example/mcp' });
  });

  it('patch 内容是可被 --patch 读的 insert 列表，serverName 合法', () => {
    const text = renderDshPatch([
      { id: 'a/b:c', serverName: toServerName('a/b:c'), transport: 'stdio', command: 'npx', args: ['-y', 'x'] },
    ]);
    expect(text).toBeTruthy();
    expect(text!).toContain('- insert:');
    expect(text!).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(text!).toContain(`serverName: "${toServerName('a/b:c')}"`);
    expect(toServerName('a/b:c')).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });

  it('超长 id 截断到 32 字符以内且不撞名', () => {
    const a = toServerName('x'.repeat(80));
    const b = toServerName(`${'x'.repeat(80)}-other`);
    expect(a.length).toBeLessThanOrEqual(32);
    expect(a).not.toBe(b);
  });

  it('写进 home 的 patch 文件；没有服务器时删掉旧文件', () => {
    const root = join(tmp, 'inst2');
    const home = join(tmp, 'home-dsh');
    mkdirSync(root, { recursive: true });
    mkdirSync(home, { recursive: true });

    const empty = writeDshMcpPatch(root, home);
    expect(empty.servers).toBe(0);
    expect(existsSync(join(home, DSH_PATCH_FILE))).toBe(false);

    writeConfig(root, { lint: { command: 'npx', args: ['-y', 'lint-mcp'] } });
    const written = writeDshMcpPatch(root, home);
    expect(written.servers).toBe(1);
    const text = readFileSync(join(home, DSH_PATCH_FILE), 'utf8');
    expect(text).toContain('serverName: "lint"');
    expect(text).toContain('- "-y"');
    expect(text).toContain('- "lint-mcp"');

    // Pack 换成没有 MCP 的版本：旧接线不能留着继续生效
    writeConfig(root, {});
    writeDshMcpPatch(root, home);
    expect(existsSync(join(home, DSH_PATCH_FILE))).toBe(false);
  });
});
