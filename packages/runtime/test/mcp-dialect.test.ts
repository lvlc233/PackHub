import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFor } from '@packhub/kernel';
import {
  doctorPack,
  installFromSource,
  installPack,
  loadPack,
  removePack,
} from '../src/index.ts';

/** 带 MCP 的包：一个知识文件 + 一个 stdio MCP。 */
function stdioWork(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-dialect-'));
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/dialect, version: 0.1.0 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: style-guide
    type: knowledge
    source: ./guide.md
  - id: pack-search
    type: mcp
    source: npm:@scope/x@1.0.0
    transport: stdio
`,
    'utf8',
  );
  writeFileSync(join(dir, 'guide.md'), '# guide\n', 'utf8');
  return dir;
}

/** 带远程 MCP 的包：用来验证 opencode 的 remote 条目形状。 */
function remoteWork(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-dialect-remote-'));
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/remote, version: 0.1.0 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: remote-mcp
    type: mcp
    source: https://mcp.example.com/mcp
    transport: http
    integrity: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
`,
    'utf8',
  );
  return dir;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

describe('MCP 方言：opencode 的 JSON 嵌套路径', () => {
  it('计划里的 register.mcp 带 mcp.servers 路径，条目转成 local', () => {
    const dir = stdioWork();
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx, { harness: 'opencode' });
    const mcp = plan!.actions.find((a) => a.op === 'register.mcp');
    expect(mcp).toBeTruthy();
    if (mcp?.op !== 'register.mcp') throw new Error('计划里应有 register.mcp');
    expect(mcp.path).toBe('opencode.json');
    expect(mcp.configPath).toEqual(['mcp', 'servers']);
    expect(mcp.format).toBeUndefined(); // 默认 json
    expect(mcp.spec).toEqual({ type: 'local', command: ['npx', '-y', '@scope/x@1.0.0'] });
    rmSync(dir, { recursive: true, force: true });
  });

  it('安装写进 mcp.servers；卸载把自己的条目摘掉，用户条目保留', async () => {
    const dir = stdioWork();
    // 用户自己的同文件配置：嵌套路径 + 别人的条目
    writeFileSync(
      join(dir, 'opencode.json'),
      `${JSON.stringify({ mcp: { servers: { mine: { type: 'local', command: ['mine'] } } } }, null, 2)}\n`,
      'utf8',
    );

    const ctx = loadPack(dir);
    const { plan } = planFor(ctx, { harness: 'opencode' });
    await installPack(ctx, plan!);

    const installed = readJson<{ mcp: { servers: Record<string, unknown> } }>(
      join(dir, 'opencode.json'),
    );
    expect(Object.keys(installed.mcp.servers).sort()).toEqual(['mine', 'pack-search']);
    expect(installed.mcp.servers['pack-search']).toEqual({
      type: 'local',
      command: ['npx', '-y', '@scope/x@1.0.0'],
    });
    // 知识文件按项目落点写
    expect(existsSync(join(dir, '.packhub/knowledge/guide.md'))).toBe(true);

    removePack(dir);
    const after = readJson<{ mcp: { servers: Record<string, unknown> } }>(
      join(dir, 'opencode.json'),
    );
    expect(Object.keys(after.mcp.servers)).toEqual(['mine']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('只有自己的条目时卸载：配置成空壳就把文件删掉', async () => {
    const dir = stdioWork();
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx, { harness: 'opencode' });
    await installPack(ctx, plan!);
    expect(existsSync(join(dir, 'opencode.json'))).toBe(true);

    removePack(dir);
    expect(existsSync(join(dir, 'opencode.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('远程 MCP 转成 { type: remote, url }', async () => {
    const dir = remoteWork();
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx, { harness: 'opencode' });
    await installPack(ctx, plan!);
    const config = readJson<{ mcp: { servers: Record<string, unknown> } }>(
      join(dir, 'opencode.json'),
    );
    expect(config.mcp.servers['remote-mcp']).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com/mcp',
    });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('MCP 方言：workbody 用默认 JSON mcpServers', () => {
  it('计划落点 .mcp.json，条目保持通用 spec；安装/卸载同样按 key 合并', async () => {
    const dir = stdioWork();
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx, { harness: 'workbody' });
    const mcp = plan!.actions.find((a) => a.op === 'register.mcp');
    if (mcp?.op !== 'register.mcp') throw new Error('计划里应有 register.mcp');
    expect(mcp.path).toBe('.mcp.json');
    expect(mcp.configPath).toBeUndefined();
    expect(mcp.format).toBeUndefined();

    await installPack(ctx, plan!);
    const config = readJson<{ mcpServers: Record<string, unknown> }>(join(dir, '.mcp.json'));
    expect(Object.keys(config.mcpServers)).toEqual(['pack-search']);
    expect(config.mcpServers['pack-search']).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@scope/x@1.0.0'],
    });

    removePack(dir);
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('MCP 方言：hermes 的 YAML mcp_servers', () => {
  it('计划带 format=yaml 与 mcp_servers 路径；安装写 YAML；卸载摘条目', async () => {
    const dir = stdioWork();
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx, { harness: 'hermes' });
    const mcp = plan!.actions.find((a) => a.op === 'register.mcp');
    if (mcp?.op !== 'register.mcp') throw new Error('计划里应有 register.mcp');
    expect(mcp.path).toBe('config.yaml');
    expect(mcp.configPath).toEqual(['mcp_servers']);
    expect(mcp.format).toBe('yaml');
    expect(mcp.spec).toEqual({ command: 'npx', args: ['-y', '@scope/x@1.0.0'] });

    await installPack(ctx, plan!);
    const text = readFileSync(join(dir, 'config.yaml'), 'utf8');
    expect(text).toContain('mcp_servers:');
    expect(text).toContain('pack-search:');
    expect(text).toContain('command: npx');

    removePack(dir);
    expect(existsSync(join(dir, 'config.yaml'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('同一 YAML 里用户自己的键保留，摘完只删自己的条目', async () => {
    const dir = stdioWork();
    writeFileSync(
      join(dir, 'config.yaml'),
      `theme: dark
mcp_servers:
  mine:
    command: mine-server
`,
      'utf8',
    );
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx, { harness: 'hermes' });
    await installPack(ctx, plan!);

    const installed = readFileSync(join(dir, 'config.yaml'), 'utf8');
    expect(installed).toContain('theme: dark');
    expect(installed).toContain('mine:');
    expect(installed).toContain('pack-search:');

    removePack(dir);
    const after = readFileSync(join(dir, 'config.yaml'), 'utf8');
    expect(after).toContain('theme: dark');
    expect(after).toContain('mine:');
    expect(after).not.toContain('pack-search');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('doctor 按方言检查 MCP 条目', () => {
  it('opencode：条目被改名 → configDrift 指出 mcp.servers.pack-search', async () => {
    const dir = stdioWork();
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx, { harness: 'opencode' });
    await installPack(ctx, plan!);

    const file = join(dir, 'opencode.json');
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, text.replace('pack-search', 'renamed'), 'utf8');

    const report = doctorPack(dir);
    expect(report.ok).toBe(false);
    expect(report.findings.flatMap((f) => f.configDrift)).toContain(
      'opencode.json:mcp.servers.pack-search',
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('hermes：YAML 条目被删 → configDrift 指出 mcp_servers.pack-search', async () => {
    const dir = stdioWork();
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx, { harness: 'hermes' });
    await installPack(ctx, plan!);

    const file = join(dir, 'config.yaml');
    writeFileSync(file, 'mcp_servers: {}\n', 'utf8');

    const report = doctorPack(dir);
    expect(report.ok).toBe(false);
    expect(report.findings.flatMap((f) => f.configDrift)).toContain(
      'config.yaml:mcp_servers.pack-search',
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('没有项目级落点的宿主：安装被拒', () => {
  it('hermes 装进项目 → usage 错误（没有项目级落点），且不落盘', async () => {
    const dir = stdioWork();
    const project = join(dir, 'project');

    await expect(
      installFromSource({ source: dir, projectDir: project, harness: 'hermes' }),
    ).rejects.toThrow(/没有项目级安装落点/);

    let caught: unknown;
    try {
      await installFromSource({ source: dir, projectDir: project, harness: 'hermes' });
    } catch (err) {
      caught = err;
    }
    const error = caught as { name?: string; failure?: string; message?: string };
    expect(error.name).toBe('InstallSourceError');
    expect(error.failure).toBe('usage');
    expect(error.message).toContain('没有项目级安装落点');
    // 拒绝发生在建目录之前
    expect(existsSync(project)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
