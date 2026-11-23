import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, updateInstance } from '../src/index.ts';

/**
 * update 的旧产物清理：走 state 里的计划快照（runtime 的 pruneRemoved），
 * 共享配置文件按 key / 块摘，不再整份 rm——用户自己写在 `.mcp.json` 里的条目必须留下。
 * 没有计划快照的旧 state 只报 warning，一个共享文件都不删。
 */

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-update-mcp-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  process.env.PACKHUB_HOME = join(tmp, 'home');
});

afterEach(() => {
  delete process.env.PACKHUB_INSTANCES;
  delete process.env.PACKHUB_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

/** 一个 Pack：一条 knowledge（内容随版本变，保证计划变过）+ 可选的 stdio MCP。 */
function mcpPack(dir: string, version: string, withMcp: boolean): string {
  mkdirSync(dir, { recursive: true });
  const resources = [
    '  - id: guide',
    '    type: knowledge',
    '    source: ./guide.md',
    ...(withMcp
      ? ['  - id: pack-search', '    type: mcp', '    source: npm:@scope/x@1.0.0', '    transport: stdio']
      : []),
  ].join('\n');
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/upd-mcp, version: ${version} }
resources:
${resources}
`,
    'utf8',
  );
  writeFileSync(join(dir, 'guide.md'), `# guide ${version}\n`, 'utf8');
  return dir;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** workbody 的 attached home：MCP 落在 home 根的 mcp.json（JSON mcpServers）。 */
function workbodyHome(name: string): { home: string; config: string } {
  const home = join(tmp, name);
  mkdirSync(home, { recursive: true });
  const config = join(home, 'mcp.json');
  writeFileSync(
    config,
    `${JSON.stringify({ mcpServers: { mine: { command: 'mine-server', args: ['--user'] } } }, null, 2)}\n`,
    'utf8',
  );
  return { home, config };
}

describe('update 走计划快照清理共享配置', () => {
  it('新版本删掉一个 MCP：本包条目被摘、用户条目与文件都在、removedFiles 仍报这个文件', async () => {
    const v1 = mcpPack(join(tmp, 'pack-v1'), '0.1.0', true);
    const v2 = mcpPack(join(tmp, 'pack-v2'), '0.2.0', false);
    const { home, config } = workbodyHome('.wb-home');

    const rec = await createInstance({ name: 'wb', harness: 'workbody', packDir: v1, attachedHome: home });
    expect(rec.attached).toBe(true);
    const installed = readJson<{ mcpServers: Record<string, unknown> }>(config);
    expect(Object.keys(installed.mcpServers).sort()).toEqual(['mine', 'pack-search']);

    const result = await updateInstance('wb', { packDir: v2 });
    expect(result.changed).toBe(true);
    expect(result.to).toBe('demo/upd-mcp@0.2.0');

    // 共享配置没被整份删：文件在，用户自己的条目还在，本包的条目被摘掉
    expect(existsSync(config)).toBe(true);
    const after = readJson<{ mcpServers: Record<string, unknown> }>(config);
    expect(Object.keys(after.mcpServers)).toEqual(['mine']);
    expect(after.mcpServers['mine']).toEqual({ command: 'mine-server', args: ['--user'] });

    // removedFiles 照旧报告这个共享文件；没有失败就没有 warnings
    expect(result.removedFiles).toContain('mcp.json');
    expect(result.warnings).toEqual([]);
    // 知识文件跟着新版本
    expect(readFileSync(join(home, 'knowledge', 'guide.md'), 'utf8')).toBe('# guide 0.2.0\n');
    // 共享文件不再记成本包的产物（条目已摘、文件因为用户条目还在）；卸载不会再动它
    const state = readJson<{ packs: Record<string, { written: { path: string }[] }> }>(
      join(home, '.packhub', 'state.json'),
    );
    const written = Object.values(state.packs)[0]!.written.map((item) => item.path);
    expect(written).toContain('knowledge/guide.md');
    expect(written).not.toContain('mcp.json');
  });

  it('旧 state 没有计划快照：不删任何旧文件，共享配置逐字节不变，并给一条 warning', async () => {
    const v1 = mcpPack(join(tmp, 'pack-old-v1'), '0.1.0', true);
    const v2 = mcpPack(join(tmp, 'pack-old-v2'), '0.2.0', false);
    const { home, config } = workbodyHome('.wb-old-home');

    await createInstance({ name: 'wb-old', harness: 'workbody', packDir: v1, attachedHome: home });
    const before = readFileSync(config, 'utf8');

    // 模拟改造前的旧 state：记录里只有 planHash / actions / written，没有计划快照
    const stateFile = join(home, '.packhub', 'state.json');
    const state = readJson<{
      packs: Record<string, Record<string, unknown>>;
    }>(stateFile);
    for (const record of Object.values(state.packs)) delete record.plan;
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const result = await updateInstance('wb-old', { packDir: v2 });
    expect(result.changed).toBe(true);
    expect(result.removedFiles).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('没有计划快照');
    expect(result.warnings[0]).toContain('跳过旧文件清理');

    // 一个文件都不删：共享配置逐字节不变（本包旧条目也还在，等重装再清）
    expect(readFileSync(config, 'utf8')).toBe(before);
    // 新版本的内容照常装上
    expect(readFileSync(join(home, 'knowledge', 'guide.md'), 'utf8')).toBe('# guide 0.2.0\n');
  });
});
