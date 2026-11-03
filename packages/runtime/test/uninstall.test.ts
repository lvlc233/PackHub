import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPack, loadPack, planFor, removePack } from '../src/index.ts';

const EXAMPLE = fileURLToPath(new URL('../../../examples/team-conventions/', import.meta.url));

function work(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-rm-'));
  cpSync(EXAMPLE, dir, { recursive: true });
  rmSync(join(dir, '.packhub'), { recursive: true, force: true });
  return dir;
}

describe('卸载', () => {
  it('按 state 删掉装过的文件，state 一起清空', async () => {
    const dir = work();
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    await installPack(ctx, plan!);
    expect(existsSync(join(dir, '.packhub/knowledge/style-guide.md'))).toBe(true);

    const res = removePack(dir);
    expect(res.removed.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, '.packhub/knowledge/style-guide.md'))).toBe(false);
    expect(existsSync(join(dir, '.packhub/state.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('没有记录时是空操作', () => {
    const dir = work();
    const res = removePack(dir);
    expect(res.removed).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('安装锁存在时拒绝并发安装，并指出持有者', async () => {
    const dir = work();
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    mkdirSync(join(dir, '.packhub'), { recursive: true });
    writeFileSync(join(dir, '.packhub/installing.lock'), '12345', 'utf8');
    await expect(installPack(ctx, plan!)).rejects.toThrow(/另一个安装正在进行.*12345/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('卸载不破坏共享配置', () => {
  it('只摘掉自己登记的 server 条目，用户自己的保留', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-rmcfg-'));
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/share, version: 0.0.1, targets: [dir, claude-code] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: pack-search
    type: mcp
    source: npm:@scope/x@1.0.0
    transport: stdio
`,
      'utf8',
    );
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { mine: { command: 'my-server' } } }, null, 2) + '\n',
      'utf8',
    );

    const ctx = loadPack(dir);
    const { plan } = planFor(ctx, { target: 'claude-code' });
    await installPack(ctx, plan!);

    const installed = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(installed.mcpServers).sort()).toEqual(['mine', 'pack-search']);

    removePack(dir);
    const after = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(after.mcpServers)).toEqual(['mine']);
    rmSync(dir, { recursive: true, force: true });
  });
});
