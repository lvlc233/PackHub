import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 有几条用例串行跑近十个真 CLI（每个都起 node 并加载全部模块），全量并发时 20s 默认值不够
vi.setConfig({ testTimeout: 60_000 });

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'packages/launcher/src/bin.ts');
const FIXTURE = join(ROOT, 'test/fixtures/packs/team-conventions');

const HOME = mkdtempSync(join(tmpdir(), 'pal-cli-home-'));
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function pal(args: string[], cwd = ROOT): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PACKHUB_INDEX;
  const res = spawnSync(process.execPath, ['--experimental-strip-types', BIN, ...args], {
    cwd,
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

/** 临时目录里放一份 fixture 包，返回 { base, pack }。 */
function packFixture(): { base: string; pack: string } {
  const base = mkdtempSync(join(tmpdir(), 'pal-cli-'));
  const pack = join(base, 'pack');
  cpSync(FIXTURE, pack, { recursive: true });
  return { base, pack };
}

interface Baseline {
  files: { path: string; sha256: string }[];
}

function readBaseline(root: string): Baseline {
  return JSON.parse(readFileSync(join(root, 'baseline.json'), 'utf8')) as Baseline;
}

function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

describe('pal 命令面（CLI 级）', () => {
  it('pal create 已删：按未知命令拒绝', () => {
    const res = pal(['create']);
    expect(res.status).toBe(1);
    expect(res.out).toContain('Unknown command');
    expect(res.out).toContain('create');
  });

  it('install 旧参数仍退 2：--new / --environment / --harness / --kind', () => {
    const { base, pack } = packFixture();
    for (const [flag, hint] of [
      ['--new', '--new 已删除'],
      ['--environment', '用 --home'],
      ['--harness', '用 --host'],
      ['--kind', '用 --host'],
    ] as const) {
      const res = pal(['install', pack, flag, 'x']);
      expect(res.status, `${flag} 应被拒绝`).toBe(2);
      expect(res.out).toContain(`未知参数 ${flag}`);
      expect(res.out).toContain(hint);
    }
    rmSync(base, { recursive: true, force: true });
  });

  it('pal doctor 已并入 health --hosts：命令不存在', () => {
    const res = pal(['doctor']);
    expect(res.status).toBe(1);
    expect(res.out).toContain('Unknown command');
    expect(res.out).toContain('doctor');
  });

  it('被移除的命令按未知命令拒绝：status / recover / core / cache / leftovers / audit / scan / rebaseline / rename', () => {
    for (const removed of [
      'status',
      'recover',
      'core',
      'cache',
      'leftovers',
      'audit',
      'scan',
      'rebaseline',
      'rename',
    ]) {
      const res = pal([removed]);
      expect(res.status, `${removed} 应该被当未知命令`).toBe(1);
      expect(res.out).toContain('Unknown command');
      expect(res.out).toContain(removed);
    }
  });

  it('pal health --leftovers 只读列出隔离区 / 失败现场 / 归档区，不删也不搬', () => {
    const res = pal(['health', '--leftovers']);
    expect(res.status).toBe(0);
    expect(res.out).toContain('quarantine');
    expect(res.out).toContain('failed');
    expect(res.out).toContain('archive');
    expect(res.out).toContain('只读');

    // 遗留物是全局的：带实例目标 / --hosts 都是用法错（不是悄悄忽略）
    for (const mixed of [
      ['health', 'demo', '--leftovers'],
      ['health', '--leftovers', '--hosts'],
    ]) {
      const bad = pal(mixed);
      expect(bad.status).toBe(2);
      expect(bad.out).toContain('--leftovers 是全局的');
    }
  });

  it('pal health --leftovers --json：root + 三个区各一个数组', () => {
    const res = pal(['health', '--leftovers', '--json']);
    expect(res.status).toBe(0);
    const body = JSON.parse(res.out.slice(res.out.indexOf('{'), res.out.lastIndexOf('}') + 1)) as {
      root?: string;
      quarantine?: unknown[];
      failed?: unknown[];
      archive?: unknown[];
    };
    expect(typeof body.root).toBe('string');
    expect(body.quarantine).toEqual([]);
    expect(body.failed).toEqual([]);
    expect(body.archive).toEqual([]);
  });

  it('pal list --history 读安装审计：pal install 写、pal list --history 读', () => {
    const { base, pack } = packFixture();
    const project = join(base, 'project');

    expect(pal(['install', pack, '--project', project, '--host', 'dsh']).status).toBe(0);

    const json = pal(['list', '--history', '--json']);
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

    const text = pal(['list', '--history']);
    expect(text.status).toBe(0);
    expect(text.out).toContain('install');
    expect(text.out).toContain('lvlc233/team-conventions@0.0.2');

    // 不带 --history 时仍是实例列表，不是审计
    const plain = pal(['list', '--json']);
    const plainBody = JSON.parse(
      plain.out.slice(plain.out.indexOf('{'), plain.out.lastIndexOf('}') + 1),
    ) as { instances?: unknown[] };
    expect(Array.isArray(plainBody.instances)).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('pal adopt --scan 只读扫描：不需要目录位参，也不写记录', () => {
    const { base, pack } = packFixture();

    // 不给目录：扫当前目录
    const res = pal(['adopt', '--scan'], base);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('team-conventions');
    expect(res.out).toContain('只读扫描，没有写盘');

    // 给目录：扫那个目录
    const withDir = pal(['adopt', '--scan', base, '--json']);
    expect(withDir.status, withDir.out).toBe(0);
    const entries = JSON.parse(
      withDir.out.slice(withDir.out.indexOf('['), withDir.out.lastIndexOf(']') + 1),
    ) as { kind: string; dir: string }[];
    expect(entries.some((entry) => entry.dir === pack)).toBe(true);

    // 只读：没有接管出任何实例
    const list = pal(['list', '--json']);
    const body = JSON.parse(list.out.slice(list.out.indexOf('{'), list.out.lastIndexOf('}') + 1)) as {
      instances?: unknown[];
    };
    expect(body.instances).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });

  it('pal adopt 接管仍然只写记录：--host 必填，默认名用目录 basename', () => {
    const { base } = packFixture();
    const env = join(base, 'env');
    mkdirSync(env, { recursive: true });

    const noHost = pal(['adopt', env]);
    expect(noHost.status).toBe(2);
    expect(noHost.out).toContain('adopt 需要 --host');

    const ok = pal(['adopt', env, '--host', 'opencode']);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).toContain('接管 env（attached）');
    const shown = pal(['show', 'env']);
    expect(shown.status).toBe(0);
    const rec = JSON.parse(shown.out.slice(shown.out.indexOf('{'), shown.out.lastIndexOf('}') + 1)) as {
      attached?: boolean;
      root?: string;
    };
    expect(rec.attached).toBe(true);
    expect(rec.root).toBe(env);
    rmSync(base, { recursive: true, force: true });
  });

  it('pal verify --accept 把 home 当前磁盘状态认作基线；项目 target 退 2', () => {
    const { base, pack } = packFixture();
    expect(pal(['install', pack, '--host', 'dsh', '--name', 'accepted']).status).toBe(0);
    const shown = pal(['show', 'accepted']);
    const rec = JSON.parse(shown.out.slice(shown.out.indexOf('{'), shown.out.lastIndexOf('}') + 1)) as {
      root: string;
    };
    const root = rec.root;

    const edited = join(root, 'home/dsh/knowledge/style-guide.md');
    appendFileSync(edited, '\n本地改动\n', 'utf8');
    const before = readBaseline(root).files.find((file) => file.path === 'home/dsh/knowledge/style-guide.md')!;
    expect(before.sha256).not.toBe(sha256Of(edited));

    // 体检（health）能看见这处本地改动
    const healthBefore = pal(['health', 'accepted']);
    expect(healthBefore.status).toBe(0);
    expect(healthBefore.out).toContain('~ 改过：home/dsh/knowledge/style-guide.md');

    const accepted = pal(['verify', '--home', 'accepted', '--accept']);
    expect(accepted.status, accepted.out).toBe(0);
    expect(accepted.out).toContain('基线已更新：');
    expect(accepted.out).toContain('lvlc233/team-conventions@0.0.2');

    const after = readBaseline(root).files.find((file) => file.path === 'home/dsh/knowledge/style-guide.md')!;
    expect(after.sha256).toBe(sha256Of(edited));
    const healthAfter = pal(['health', 'accepted']);
    expect(healthAfter.out).not.toContain('~ 改过：home/dsh/knowledge/style-guide.md');

    // 项目没有基线：--accept 是用法错
    const project = pal(['verify', '--project', base, '--accept']);
    expect(project.status).toBe(2);
    expect(project.out).toContain('项目没有基线，--accept 只用于 home');
    rmSync(base, { recursive: true, force: true });
  });

  it('pal config <home> --name 改名：重名拒绝，不与全局配置混用', () => {
    const { base, pack } = packFixture();
    expect(pal(['install', pack, '--host', 'dsh', '--name', 'demo']).status).toBe(0);
    expect(pal(['install', pack, '--host', 'dsh', '--name', 'other']).status).toBe(0);

    const renamed = pal(['config', 'demo', '--name', 'demo-2']);
    expect(renamed.status, renamed.out).toBe(0);
    expect(renamed.out).toContain('demo-2');
    expect(pal(['show', 'demo-2']).status).toBe(0);

    // 重名：name-taken，退出 1
    const dup = pal(['config', 'other', '--name', 'demo-2']);
    expect(dup.status).toBe(1);
    expect(dup.out).toContain('实例名已存在');

    // 给环境名却没给 --name：用法错
    const missing = pal(['config', 'demo-2']);
    expect(missing.status).toBe(2);
    expect(missing.out).toContain('--name');

    // 改名与全局配置互斥
    const mixed = pal(['config', 'demo-2', '--name', 'demo-3', '--set-isolation', 'session=shared']);
    expect(mixed.status).toBe(2);
    expect(mixed.out).toContain('不能同时改全局配置');

    // 不带环境名：仍是全局配置视图
    const plain = pal(['config', '--json']);
    const body = JSON.parse(plain.out.slice(plain.out.indexOf('{'), plain.out.lastIndexOf('}') + 1)) as {
      home?: string;
      isolation?: unknown;
    };
    expect(typeof body.home).toBe('string');
    expect(body.isolation).toBeTruthy();
    rmSync(base, { recursive: true, force: true });
  });

  it('pal health --hosts 文本两段：宿主在前、实例在后', () => {
    const res = pal(['health', '--hosts']);
    expect(res.status).toBe(0);
    const lines = res.out.split(/\r?\n/);
    expect(lines[0]).toBe('宿主：');
    expect(res.out).toContain('实例：');
    expect(res.out.indexOf('宿主：')).toBeLessThan(res.out.indexOf('实例：'));
  });
});
