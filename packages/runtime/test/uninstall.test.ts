import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionUndoPayload, planFor } from '@packhub/kernel';
import { installPack, loadPack, removePack } from '../src/index.ts';

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
    // 活着的持有者才该挡住并发；崩溃留下的死 pid 会被自动收回（见 guards.test）
    writeFileSync(join(dir, '.packhub/installing.lock'), String(process.pid), 'utf8');
    await expect(installPack(ctx, plan!)).rejects.toThrow(
      new RegExp(`另一个安装正在进行.*${process.pid}`),
    );
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

describe('撤销负载只在 PLAN_OPS 表里定义一次', () => {
  it('register.mcp 与 instruction 的撤销字段与安装实际用的键/块逐字一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-undo-payload-'));
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/share, version: 0.0.1, targets: [claude-code] }
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
    writeFileSync(join(dir, 'CLAUDE.md'), '用户自己的说明\n', 'utf8');

    const ctx = loadPack(dir);
    const { plan } = planFor(ctx, { target: 'claude-code' });
    await installPack(ctx, plan!);

    // mcp：撤销要摘的键与安装写进配置的键是同一个
    const mcp = plan!.actions.find((a) => a.op === 'register.mcp');
    expect(mcp).toBeTruthy();
    const mcpPayload = actionUndoPayload(mcp!);
    expect(mcpPayload?.undo).toBe('restore-shared');
    if (mcpPayload?.undo !== 'restore-shared') throw new Error('register.mcp 的撤销负载应由表给出');
    expect(mcpPayload).toEqual({ undo: 'restore-shared', path: '.mcp.json', key: 'pack-search' });
    const config = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers[mcpPayload.key]).toBeTruthy();

    // instruction：撤销要摘的块与安装写进文件的块是同一个
    const instruction = plan!.actions.find((a) => a.op === 'instruction');
    expect(instruction).toBeTruthy();
    const blockPayload = actionUndoPayload(instruction!);
    expect(blockPayload?.undo).toBe('strip-block');
    if (blockPayload?.undo !== 'strip-block') throw new Error('instruction 的撤销负载应由表给出');
    expect(blockPayload).toEqual({ undo: 'strip-block', file: 'CLAUDE.md', blockId: 'demo/share' });
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain(
      `<!-- packhub:begin ${blockPayload.blockId} -->`,
    );

    // 卸载按同一份负载撤销：只摘自己的键与块，用户内容留下
    removePack(dir);
    const servers = (JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    }).mcpServers;
    expect(Object.keys(servers ?? {})).toEqual(['mine']);
    const claude = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('用户自己的说明');
    expect(claude).not.toContain('packhub:begin');
    rmSync(dir, { recursive: true, force: true });
  });
});
