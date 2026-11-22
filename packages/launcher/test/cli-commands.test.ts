import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'packages/launcher/src/bin.ts');
const FIXTURE = join(ROOT, 'test/fixtures/packs/team-conventions');

const HOME = mkdtempSync(join(tmpdir(), 'pal-cli-home-'));
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

describe('pal 命令面（CLI 级）', () => {
  it('pal create 不建目录形态实例：--kind dir 退 2 并指向 adopt / install', () => {
    const base = mkdtempSync(join(tmpdir(), 'pal-cli-create-'));
    const pack = join(base, 'pack');
    cpSync(FIXTURE, pack, { recursive: true });

    const res = pal(['create', pack, '--name', 'c1', '--kind', 'dir']);
    expect(res.status).toBe(2);
    expect(res.out).toContain('不建目录形态实例');
    expect(res.out).toContain('pal adopt');
    expect(res.out).toContain('pal install');
    rmSync(base, { recursive: true, force: true });
  });

  it('pal doctor 已并入 health --hosts：命令不存在', () => {
    const res = pal(['doctor']);
    expect(res.status).toBe(1);
    expect(res.out).toContain('Unknown command');
    expect(res.out).toContain('doctor');
  });

  it('pal audit 读安装审计：pal install 写、pal audit 读', () => {
    const base = mkdtempSync(join(tmpdir(), 'pal-cli-audit-'));
    const pack = join(base, 'pack');
    const project = join(base, 'project');
    cpSync(FIXTURE, pack, { recursive: true });

    expect(pal(['install', pack, '--into', project, '--harness', 'dsh']).status).toBe(0);

    const json = pal(['audit', '--json']);
    expect(json.status).toBe(0);
    const body = JSON.parse(json.out.slice(json.out.indexOf('['), json.out.lastIndexOf(']') + 1)) as {
      action: string;
      pack: string;
      version: string;
      ok: boolean;
      root: string;
    }[];
    expect(body.length).toBeGreaterThan(0);
    const entry = body.find((e) => e.pack === 'lvlc233/team-conventions')!;
    expect(entry).toMatchObject({
      action: 'install',
      version: '0.0.2',
      ok: true,
    });
    expect(entry.root).toBe(project);

    const text = pal(['audit']);
    expect(text.status).toBe(0);
    expect(text.out).toContain('install');
    expect(text.out).toContain('lvlc233/team-conventions@0.0.2');
    rmSync(base, { recursive: true, force: true });
  });

  it('pal health --hosts 文本两段：宿主在前、实例在后', () => {
    const res = pal(['health', '--hosts']);
    expect(res.status).toBe(0);
    const lines = res.out.split(/\r?\n/);
    expect(lines[0]).toBe('宿主：');
    expect(res.out).toContain('实例：');
    expect(res.out).toContain('没有实例');
  });
});
