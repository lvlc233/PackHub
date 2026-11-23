import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  actionUndoPayload,
  actionWrittenOwned,
  loadPack,
  mcpActionPaths,
  planFor,
  planOutputsOf,
} from '../src/index.ts';

/**
 * dsh 的 attached 落点：MCP 是 per-profile 的，plan 期把 `profiles/<名字>/cordis.patch.yml`
 * 枚举出来；只有一个文件时不写 `paths`（保持单文件形状），两个以上才带完整列表。
 *
 * 落点与条目形状由 `harness/dsh.ts` 的 destination 回答；这里只看计划。
 */
const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/mcp, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: repo-search
    type: mcp
    source: npm:@scope/srv@1.0.0
    transport: stdio
  - id: repo-search-two
    type: mcp
    source: npm:@scope/srv2@1.0.0
    transport: stdio
  - id: guide
    type: knowledge
    source: ./guide.md
`;

function packDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-dsh-attached-'));
  writeFileSync(join(dir, 'packhub.yaml'), MANIFEST, 'utf8');
  writeFileSync(join(dir, 'guide.md'), '# guide\n', 'utf8');
  return dir;
}

/** 一份 dsh home：给哪些 profile 建 patch 文件。 */
function dshHome(profiles: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'packhub-dsh-home-'));
  for (const profile of profiles) {
    mkdirSync(join(home, 'profiles', profile), { recursive: true });
    writeFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), '[]\n', 'utf8');
  }
  return home;
}

function planAt(scope: 'project' | 'home' | 'attached', root: string, home?: string) {
  const dir = packDir();
  const built = planFor(loadPack(dir), {
    harness: 'dsh',
    scope,
    root,
    ...(home ? { home } : {}),
    platform: 'linux-x64',
  });
  rmSync(dir, { recursive: true, force: true });
  expect(built.issues.filter((i) => i.severity === 'error')).toEqual([]);
  return built.plan!;
}

const patches = (plan: ReturnType<typeof planAt>) =>
  plan.actions.filter((a) => a.op === 'register.mcp');

describe('dsh attached 的 MCP：写所有已有 profile 的 patch 文件', () => {
  it('两个 profile：动作带完整 paths（字典序）、条目 id 与 list 规则；撤销记录每个 path+key', () => {
    const home = dshHome(['web', 'desktop']);
    const plan = planAt('attached', home, home);
    const [first, second] = patches(plan);
    if (first?.op !== 'register.mcp') throw new Error('计划里应有 register.mcp');
    expect(first.path).toBe('profiles/desktop/cordis.patch.yml');
    expect(first.toBase).toBe('home');
    expect(first.paths).toEqual([
      { path: 'profiles/desktop/cordis.patch.yml', base: 'home' },
      { path: 'profiles/web/cordis.patch.yml', base: 'home' },
    ]);
    expect(first.format).toBe('yaml');
    // 数组文件：条目不挂在对象路径下，按 `id` 认领
    expect(first.configPath).toBeUndefined();
    expect(first.list).toEqual({ field: 'insert', ownerPrefix: 'pal-mcp-' });
    // 条目形状就是 dsh 的 loader 行，id 由 serverName 派生
    expect(first.entryId).toBe('pal-mcp-repo-search');
    expect(first.spec).toEqual({
      id: 'pal-mcp-repo-search',
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'repo-search',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@scope/srv@1.0.0'],
      },
    });

    if (second?.op !== 'register.mcp') throw new Error('两条 mcp 都应进计划');
    expect(second.entryId).toBe('pal-mcp-repo-search-two');
    expect(second.spec).toMatchObject({ config: { serverName: 'repo-search-two' } });

    // 撤销：每个文件一条（path+key），state.written 也记两个文件
    expect(actionUndoPayload(first)).toEqual({
      undo: 'restore-shared',
      path: 'profiles/desktop/cordis.patch.yml',
      key: 'pal-mcp-repo-search',
      base: 'home',
      paths: [
        { path: 'profiles/desktop/cordis.patch.yml', base: 'home' },
        { path: 'profiles/web/cordis.patch.yml', base: 'home' },
      ],
      format: 'yaml',
      list: { field: 'insert', ownerPrefix: 'pal-mcp-' },
    });
    expect(mcpActionPaths(first)).toEqual([
      { path: 'profiles/desktop/cordis.patch.yml', base: 'home' },
      { path: 'profiles/web/cordis.patch.yml', base: 'home' },
    ]);
    expect(
      actionWrittenOwned(first, plan, 'linux-x64').map((item) => `${item.base}:${item.path}`),
    ).toEqual(['home:profiles/desktop/cordis.patch.yml', 'home:profiles/web/cordis.patch.yml']);
    // 计划产物里两个 patch 文件都在
    const outputs = planOutputsOf(plan).map((item) => `${item.base}:${item.path}`);
    expect(outputs).toContain('home:profiles/desktop/cordis.patch.yml');
    expect(outputs).toContain('home:profiles/web/cordis.patch.yml');
    rmSync(home, { recursive: true, force: true });
  });

  it('只有一个 profile：不写 paths（动作保持单文件形状）', () => {
    const home = dshHome(['web']);
    const plan = planAt('attached', home, home);
    const [only] = patches(plan);
    if (only?.op !== 'register.mcp') throw new Error('计划里应有 register.mcp');
    expect('paths' in only).toBe(false);
    expect(only.path).toBe('profiles/web/cordis.patch.yml');
    expect(actionUndoPayload(only)).not.toHaveProperty('paths');
    expect(mcpActionPaths(only)).toEqual([{ path: 'profiles/web/cordis.patch.yml', base: 'home' }]);
    rmSync(home, { recursive: true, force: true });
  });

  it('一个 profile 都没有：退回 profiles/web（让安装把它建出来）', () => {
    const home = dshHome([]);
    const plan = planAt('attached', home, home);
    const [only] = patches(plan);
    if (only?.op !== 'register.mcp') throw new Error('计划里应有 register.mcp');
    expect('paths' in only).toBe(false);
    expect(only.path).toBe('profiles/web/cordis.patch.yml');
    rmSync(home, { recursive: true, force: true });
  });

  it('attached 的其余落点：知识落 home，指令是 <home>/AGENTS.md', () => {
    const home = dshHome(['web']);
    const plan = planAt('attached', home, home);
    const paths = plan.actions.map((a) => {
      const record = a as { to?: string; file?: string; path?: string };
      return `${record.to ?? record.file ?? record.path ?? a.op}:${
        (a as { toBase?: string }).toBase ?? 'root'
      }`;
    });
    expect(paths.sort()).toEqual([
      'AGENTS.md:home',
      'knowledge/guide.md:home',
      'profiles/web/cordis.patch.yml:home',
      'profiles/web/cordis.patch.yml:home',
    ]);
    rmSync(home, { recursive: true, force: true });
  });

  it('managed 的 dsh 不变：MCP 仍登记在 .packhub/config.json，用默认方言', () => {
    const plan = planAt('home', '/inst', '/inst/home/dsh');
    for (const action of patches(plan)) {
      if (action.op !== 'register.mcp') throw new Error('计划里应有 register.mcp');
      expect(action.path).toBe('.packhub/config.json');
      expect('paths' in action).toBe(false);
      expect('toBase' in action).toBe(false);
      expect('entryId' in action).toBe(false);
      expect('list' in action).toBe(false);
      expect('format' in action).toBe(false);
      expect('configPath' in action).toBe(false);
      expect(action.spec).toMatchObject({ transport: 'stdio', command: 'npx' });
    }
  });
});
