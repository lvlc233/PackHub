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
    expect(none.out).toContain('--into');
    expect(none.out).toContain('--instance');
    expect(none.out).toContain('--new');

    const both = pal(['install', pack, '--into', join(base, 'p1'), '--instance', 'x', '--harness', 'dsh']);
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

  it('--new --kind dir 退 2：dir 不是宿主，指向 adopt / install --into', () => {
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
    for (const flag of ['--into', '--instance', '--new']) expect(res.out).toContain(flag);
    expect(res.out).toContain('--kind');
    expect(res.out).toContain('--name');
  });

  it('非法 --harness / --kind 的可选值列出六个宿主', () => {
    const base = tmp('pal-target-choices-');
    const pack = join(base, 'pack');
    cpSync(FIXTURE, pack, { recursive: true });

    const badHarness = pal(['install', pack, '--into', join(base, 'p'), '--harness', 'nope']);
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

describe('实例 target：install --new / verify / update / rollback / uninstall', () => {
  it('本地包装进新实例 → verify --instance → 重复装退 2 → uninstall --instance', () => {
    const base = tmp('pal-inst-target-');
    const pack = join(base, 'pack');
    const root = join(base, 'inst');
    cpSync(FIXTURE, pack, { recursive: true });

    const installed = pal([
      'install', pack, '--new', '--kind', 'dsh', '--name', 'demo', '--root', root,
    ]);
    expect(installed.status, installed.out).toBe(0);
    expect(existsSync(join(root, 'home/dsh/knowledge/style-guide.md'))).toBe(true);

    const verified = pal(['verify', '--instance', 'demo']);
    expect(verified.status).toBe(0);
    expect(verified.out).toContain('漂移：已装记录 vs 磁盘');
    expect(verified.out).toContain('1 个包全部在位');

    // 已经装过包：不允许重复装，指向 update / uninstall
    const dup = pal(['install', pack, '--instance', 'demo']);
    expect(dup.status).toBe(2);
    expect(dup.out).toContain('实例里已经有包');
    expect(dup.out).toContain('pal update --instance');
    expect(dup.out).toContain('pal uninstall --instance');

    const removed = pal(['uninstall', '--instance', 'demo']);
    expect(removed.status).toBe(0);
    expect(existsSync(join(root, 'home/dsh/knowledge/style-guide.md'))).toBe(false);
    expect(existsSync(join(root, '.packhub/state.json'))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  it('registry 包装进新实例 → update --instance 到新版 → rollback --instance 回旧版', async () => {
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

    const updated = pal(['update', '--instance', 'demo', '--index', index]);
    expect(updated.status, updated.out).toBe(0);
    expect(updated.out).toContain('demo/upd@0.1.0 → demo/upd@0.2.0');
    expect(readFileSync(rules, 'utf8')).toBe('# v2\n');

    const rolled = pal(['rollback', '--instance', 'demo']);
    expect(rolled.status, rolled.out).toBe(0);
    expect(rolled.out).toContain('回退');
    expect(rolled.out).toContain('↩ home/dsh/knowledge/rules.md');
    expect(readFileSync(rules, 'utf8')).toBe('# v1\n');
    rmSync(base, { recursive: true, force: true });
  });
});
