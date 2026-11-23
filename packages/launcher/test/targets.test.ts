import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packArchive } from '@packhub/runtime';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'packages/launcher/src/bin.ts');
const FIXTURE = join(ROOT, 'test/fixtures/packs/team-conventions');

const HOME = mkdtempSync(join(tmpdir(), 'pal-targets-home-'));
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

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 造一个本地 registry：索引 + 每个版本一个 .phub。 */
async function makeRegistry(
  base: string,
  versions: { version: string; body: string }[],
): Promise<string> {
  const reg = join(base, 'reg');
  mkdirSync(join(reg, 'packs/demo/upd'), { recursive: true });
  for (const { version, body } of versions) {
    const src = join(base, `src-${version}`);
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/upd, version: ${version} }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`,
      'utf8',
    );
    writeFileSync(join(src, 'rules.md'), body, 'utf8');
    await packArchive(src, { vendored: true, out: join(reg, `packs/demo/upd/${version}.phub`) });
  }
  writeFileSync(
    join(reg, 'index.json'),
    JSON.stringify({
      apiVersion: 'packhub.dev/index/v0',
      packs: [
        {
          name: 'demo/upd',
          latest: versions[versions.length - 1]!.version,
          versions: versions.map((v) => v.version),
        },
      ],
    }),
    'utf8',
  );
  return join(reg, 'index.json');
}

describe('install 的 target 三选一', () => {
  it('缺 target / 多 target 都退 2，并列出三选一', () => {
    const base = tmp('pal-target-args-');
    const pack = join(base, 'pack');
    cpSync(FIXTURE, pack, { recursive: true });

    const none = pal(['install', pack]);
    expect(none.status).toBe(2);
    expect(none.out).toContain('要指定 target 才能继续');
    expect(none.out).toContain('--project');
    expect(none.out).toContain('--environment');
    expect(none.out).toContain('--new');

    const both = pal(['install', pack, '--project', join(base, 'p1'), '--environment', 'x', '--harness', 'dsh']);
    expect(both.status).toBe(2);
    expect(both.out).toContain('target 只能给一个');
    rmSync(base, { recursive: true, force: true });
  });

  it('--new 缺 --kind / --name 都退 2', () => {
    const base = tmp('pal-target-new-');
    const pack = join(base, 'pack');
    cpSync(FIXTURE, pack, { recursive: true });

    const noKind = pal(['install', pack, '--new', '--name', 'n1']);
    expect(noKind.status).toBe(2);
    expect(noKind.out).toContain('使用 --new 需要 --kind');

    const noName = pal(['install', pack, '--new', '--kind', 'dsh']);
    expect(noName.status).toBe(2);
    expect(noName.out).toContain('使用 --new 需要 --name');
    rmSync(base, { recursive: true, force: true });
  });

  it('--new --kind dir 退 2：dir 不是宿主，指向 adopt / install --project', () => {
    const base = tmp('pal-target-new-dir-');
    const pack = join(base, 'pack');
    cpSync(FIXTURE, pack, { recursive: true });

    const res = pal(['install', pack, '--new', '--kind', 'dir', '--name', 'n2']);
    expect(res.status).toBe(2);
    expect(res.out).toContain('--kind 不收 dir');
    expect(res.out).toContain('pal adopt');
    rmSync(base, { recursive: true, force: true });
  });

  it('pal create 已删：按未知命令拒绝', () => {
    const res = pal(['create']);
    expect(res.status).toBe(1);
    expect(res.out).toContain('Unknown command');
    expect(res.out).toContain('create');
  });

  it('install --help 写明 target 三选一', () => {
    const res = pal(['install', '--help']);
    expect(res.status).toBe(0);
    expect(res.out).toContain('三选一');
    for (const flag of ['--project', '--environment', '--new']) expect(res.out).toContain(flag);
    expect(res.out).toContain('--kind');
    expect(res.out).toContain('--name');
  });

  it('非法 --harness / --kind 的可选值列出六个宿主', () => {
    const base = tmp('pal-target-choices-');
    const pack = join(base, 'pack');
    cpSync(FIXTURE, pack, { recursive: true });

    const badHarness = pal(['install', pack, '--project', join(base, 'p'), '--harness', 'nope']);
    expect(badHarness.status).toBe(2);
    expect(badHarness.out).toContain('未知宿主');
    for (const id of ['dsh', 'claude-code', 'codex', 'opencode', 'workbody', 'hermes']) {
      expect(badHarness.out).toContain(id);
    }

    const badKind = pal(['install', pack, '--new', '--kind', 'nope', '--name', 'n3']);
    expect(badKind.status).toBe(2);
    for (const id of ['dsh', 'claude-code', 'codex', 'opencode', 'workbody', 'hermes']) {
      expect(badKind.out).toContain(id);
    }
    rmSync(base, { recursive: true, force: true });
  });
});

describe('改写后的 flag：旧名退 2 并提示改名', () => {
  it('--into → --project、--instance → --environment', () => {
    for (const [oldFlag, newFlag] of [
      ['--into', '--project'],
      ['--instance', '--environment'],
    ] as const) {
      const res = pal(['install', 'x', oldFlag, 'y']);
      expect(res.status, `${oldFlag} 应被拒绝`).toBe(2);
      expect(res.out).toContain(`未知参数 ${oldFlag}`);
      expect(res.out).toContain(`已改名：用 ${newFlag}`);
      expect(res.out).toContain('旧名不保留');
    }
  });

  it('旧 flag 在任何命令前都被拦（不是静默忽略）', () => {
    const res = pal(['verify', '--into', '.']);
    expect(res.status).toBe(2);
    expect(res.out).toContain('未知参数 --into');
    expect(res.out).toContain('--project');
  });
});

describe('帮助分组', () => {
  it('根帮助首组是「安装（target = 项目 / 环境）」，并有「环境」分组', () => {
    const res = pal(['--help']);
    expect(res.status).toBe(0);
    expect(res.out).toContain('安装（target = 项目 / 环境）：');
    expect(res.out).toContain('环境：');
    // create 已并入 install --new：根帮助里不该再有 create 命令行（描述文案里提到不算）
    expect(res.out).not.toMatch(/^ {2}create\s/m);
    // 安装类五条都在首组里
    const installGroup = res.out.slice(
      res.out.indexOf('安装（target = 项目 / 环境）：'),
      res.out.indexOf('环境：'),
    );
    for (const name of ['install', 'uninstall', 'verify', 'rollback', 'update']) {
      expect(installGroup).toContain(name);
    }
  });

  it('根帮助恰好 25 条命令：没有 core / cache 与被并进 flag 的旧命令，也没有「其它」分组', () => {
    const res = pal(['--help']);
    expect(res.status).toBe(0);
    const commandLines = res.out.split(/\r?\n/).filter((line) => /^ {2}\S/.test(line));
    expect(commandLines).toHaveLength(25);
    for (const removed of ['core', 'cache', 'leftovers', 'audit', 'scan', 'rebaseline', 'rename']) {
      expect(res.out, `根帮助不该再列 ${removed}`).not.toMatch(new RegExp(`^ {2}${removed}\\s`, 'm'));
    }
    expect(res.out).not.toContain('其它：');
    // 搬运组只剩搬运：scan / rename 已并进 adopt --scan / config --name
    const carryGroup = res.out.slice(res.out.indexOf('搬运：'));
    for (const name of ['clone', 'migrate', 'export', 'import', 'backup', 'restore']) {
      expect(carryGroup).toContain(name);
    }
    expect(carryGroup).not.toContain('scan');
    expect(carryGroup).not.toContain('rename');
  });
});

describe('宿主 project 三态', () => {
  it('--project + dsh（pointer）：打一行 warning 说明只写指路块', () => {
    const base = tmp('pal-pointer-');
    const pack = join(base, 'pack');
    const project = join(base, 'proj');
    cpSync(FIXTURE, pack, { recursive: true });

    const res = pal(['install', pack, '--project', project, '--harness', 'dsh']);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('warn');
    expect(res.out).toContain('项目内只写指路块');
    expect(res.out).toContain('--new 建环境');
    // 项目里照常落知识 / 指令
    expect(existsSync(join(project, '.packhub/knowledge/style-guide.md'))).toBe(true);
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('--json 时不打 pointer warning（只留结构化输出）', () => {
    const base = tmp('pal-pointer-json-');
    const pack = join(base, 'pack');
    const project = join(base, 'proj');
    cpSync(FIXTURE, pack, { recursive: true });

    const res = pal(['install', pack, '--project', project, '--harness', 'dsh', '--json']);
    expect(res.status, res.out).toBe(0);
    expect(res.out).not.toContain('项目内只写指路块');
    rmSync(base, { recursive: true, force: true });
  });

  it('--project + hermes（project=false）：退 2，提示用 --new 建环境', () => {
    const base = tmp('pal-hermes-project-');
    const pack = join(base, 'pack');
    const project = join(base, 'proj');
    cpSync(FIXTURE, pack, { recursive: true });

    const res = pal(['install', pack, '--project', project, '--harness', 'hermes']);
    expect(res.status).toBe(2);
    expect(res.out).toContain('没有项目级安装落点');
    expect(res.out).toContain('--new');
    expect(res.out).toContain('建环境');
    expect(existsSync(project)).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('实例 target：install --new / verify / update / rollback / uninstall', () => {
  it('本地包装进新实例 → verify --environment → 重复装退 2 → uninstall --environment', () => {
    const base = tmp('pal-inst-target-');
    const pack = join(base, 'pack');
    const root = join(base, 'inst');
    cpSync(FIXTURE, pack, { recursive: true });

    const installed = pal([
      'install', pack, '--new', '--kind', 'dsh', '--name', 'demo', '--root', root,
    ]);
    expect(installed.status, installed.out).toBe(0);
    expect(existsSync(join(root, 'home/dsh/knowledge/style-guide.md'))).toBe(true);

    const verified = pal(['verify', '--environment', 'demo']);
    expect(verified.status).toBe(0);
    expect(verified.out).toContain('漂移：已装记录 vs 磁盘');
    expect(verified.out).toContain('1 个包全部在位');

    // 已经装过包：不允许重复装，指向 update / uninstall
    const dup = pal(['install', pack, '--environment', 'demo']);
    expect(dup.status).toBe(2);
    expect(dup.out).toContain('实例里已经有包');
    expect(dup.out).toContain('pal update --environment');
    expect(dup.out).toContain('pal uninstall --environment');

    const removed = pal(['uninstall', '--environment', 'demo']);
    expect(removed.status).toBe(0);
    expect(existsSync(join(root, 'home/dsh/knowledge/style-guide.md'))).toBe(false);
    expect(existsSync(join(root, '.packhub/state.json'))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  it('registry 包装进新实例 → update --environment 到新版 → rollback --environment 回旧版', async () => {
    const base = tmp('pal-inst-update-');
    const index = await makeRegistry(base, [
      { version: '0.1.0', body: '# v1\n' },
      { version: '0.2.0', body: '# v2\n' },
    ]);
    const root = join(base, 'inst');
    const rules = join(root, 'home/dsh/knowledge/rules.md');

    const installed = pal([
      'install', 'demo/upd', '--version', '0.1.0', '--new', '--kind', 'dsh', '--name', 'demo',
      '--index', index, '--root', root,
    ]);
    expect(installed.status, installed.out).toBe(0);
    expect(readFileSync(rules, 'utf8')).toBe('# v1\n');

    const updated = pal(['update', '--environment', 'demo', '--index', index]);
    expect(updated.status, updated.out).toBe(0);
    expect(updated.out).toContain('demo/upd@0.1.0 → demo/upd@0.2.0');
    expect(readFileSync(rules, 'utf8')).toBe('# v2\n');

    const rolled = pal(['rollback', '--environment', 'demo']);
    expect(rolled.status, rolled.out).toBe(0);
    expect(rolled.out).toContain('回退');
    expect(rolled.out).toContain('↩ home/dsh/knowledge/rules.md');
    expect(readFileSync(rules, 'utf8')).toBe('# v1\n');
    rmSync(base, { recursive: true, force: true });
  });
});
