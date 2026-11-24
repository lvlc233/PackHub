import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'packages/launcher/src/bin.ts');

const HOME = mkdtempSync(join(tmpdir(), 'pal-new-harness-home-'));
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function pal(args: string[]): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PACKHUB_INDEX;
  const res = spawnSync(process.execPath, ['--experimental-strip-types', BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...env,
      PACKHUB_HOME: HOME,
      PACKHUB_INSTANCES: join(HOME, 'instances'),
    },
  });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** 带 MCP 的包：知识文件 + 一个 stdio MCP。 */
function makeMcpPack(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/harness, version: 0.1.0 }
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

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** 装完用 show 拿 managed home 的根（默认 target 的根由系统分配）。 */
function installedRoot(name: string): string {
  const res = pal(['show', name]);
  expect(res.status, res.out).toBe(0);
  const rec = JSON.parse(res.out.slice(res.out.indexOf('{'), res.out.lastIndexOf('}') + 1)) as {
    root: string;
    attached?: boolean;
  };
  expect(rec.attached).toBe(false);
  return rec.root;
}

describe('默认 target：三个新宿主的 managed home 布局', () => {
  it('opencode：XDG 落点多一层 opencode/，MCP 写进 opencode.json', () => {
    const base = mkdtempSync(join(tmpdir(), 'pal-create-oc-'));
    const pack = makeMcpPack(base, 'pack');

    const res = pal(['install', pack, '--host', 'opencode', '--name', 'oc']);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('next: pal run oc');
    const root = installedRoot('oc');
    // 技能/知识落进 home/opencode/opencode/…（XDG_CONFIG_HOME 那一层）
    expect(existsSync(join(root, 'home/opencode/opencode/knowledge/guide.md'))).toBe(true);
    const config = readJson<{ mcp: { servers: Record<string, unknown> } }>(
      join(root, 'home/opencode/opencode/opencode.json'),
    );
    expect(config.mcp.servers['pack-search']).toMatchObject({ type: 'local' });
    expect(config.mcp.servers['pack-search']).toHaveProperty('command');
    // 指令文件在全局配置 home（XDG 那层）里，和 opencode 自己读的位置一致
    expect(existsSync(join(root, 'home/opencode/opencode/AGENTS.md'))).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('workbody：MCP 落在 home/codebuddy/mcp.json，指令是 CODEBUDDY.md', () => {
    const base = mkdtempSync(join(tmpdir(), 'pal-create-wb-'));
    const pack = makeMcpPack(base, 'pack');

    const res = pal(['install', pack, '--host', 'workbody', '--name', 'wb']);
    expect(res.status, res.out).toBe(0);
    const root = installedRoot('wb');
    expect(existsSync(join(root, 'home/codebuddy/knowledge/guide.md'))).toBe(true);
    const config = readJson<{ mcpServers: Record<string, unknown> }>(
      join(root, 'home/codebuddy/mcp.json'),
    );
    expect(Object.keys(config.mcpServers)).toContain('pack-search');
    expect(existsSync(join(root, 'home/codebuddy/CODEBUDDY.md'))).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('hermes：只有全局目录，MCP 是 home/hermes/config.yaml（YAML）', () => {
    const base = mkdtempSync(join(tmpdir(), 'pal-create-hermes-'));
    const pack = makeMcpPack(base, 'pack');

    const res = pal(['install', pack, '--host', 'hermes', '--name', 'hm']);
    expect(res.status, res.out).toBe(0);
    const root = installedRoot('hm');
    expect(existsSync(join(root, 'home/hermes/knowledge/guide.md'))).toBe(true);
    const yaml = readFileSync(join(root, 'home/hermes/config.yaml'), 'utf8');
    expect(yaml).toContain('mcp_servers:');
    expect(yaml).toContain('pack-search:');
    expect(yaml).toContain('command: npx');
    rmSync(base, { recursive: true, force: true });
  });
});

describe('--project：项目级落点按方言', () => {
  it('opencode：opencode.json 的 mcp.servers + .packhub 知识目录', () => {
    const base = mkdtempSync(join(tmpdir(), 'pal-ins-oc-'));
    const pack = makeMcpPack(base, 'pack');
    const project = join(base, 'project');

    const res = pal(['install', pack, '--project', project, '--host', 'opencode']);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain(`next: 在宿主里打开 ${project}`);
    const config = readJson<{ mcp: { servers: Record<string, unknown> } }>(
      join(project, 'opencode.json'),
    );
    expect(config.mcp.servers['pack-search']).toMatchObject({ type: 'local' });
    expect(existsSync(join(project, '.packhub/knowledge/guide.md'))).toBe(true);
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('workbody：.mcp.json 的 mcpServers + CODEBUDDY.md', () => {
    const base = mkdtempSync(join(tmpdir(), 'pal-ins-wb-'));
    const pack = makeMcpPack(base, 'pack');
    const project = join(base, 'project');

    const res = pal(['install', pack, '--project', project, '--host', 'workbody']);
    expect(res.status, res.out).toBe(0);
    const config = readJson<{ mcpServers: Record<string, unknown> }>(
      join(project, '.mcp.json'),
    );
    expect(Object.keys(config.mcpServers)).toContain('pack-search');
    expect(existsSync(join(project, '.packhub/knowledge/guide.md'))).toBe(true);
    expect(existsSync(join(project, 'CODEBUDDY.md'))).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('hermes 没有项目级落点：--project 退 2，指向默认命名 home', () => {
    const base = mkdtempSync(join(tmpdir(), 'pal-ins-hermes-'));
    const pack = makeMcpPack(base, 'pack');
    const project = join(base, 'project');

    const res = pal(['install', pack, '--project', project, '--host', 'hermes']);
    expect(res.status).toBe(2);
    expect(res.out).toContain('没有项目级安装落点');
    expect(res.out).toContain('默认命名 home');
    // 拒绝在建目录之前：没有半套安装
    expect(existsSync(project)).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
});
