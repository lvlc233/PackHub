import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLock, loadPack, planFor } from '@packhub/kernel';
import { packArchive } from '@packhub/runtime';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'apps/local/src/bin.ts');

function run(args: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
  const res = spawnSync(process.execPath, ['--experimental-strip-types', BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PACKHUB_HOME: join(tmpdir(), 'packhub-cli-home'), ...env },
  });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

describe('cli 端到端：add → verify → uninstall', () => {
  it('没有索引时明确报错；配了 PACKHUB_INDEX 就能装、能验、能卸', () => {
    const project = mkdtempSync(join(tmpdir(), 'packhub-cli-'));
    mkdirSync(project, { recursive: true });

    const noIndex = run(['add', 'lvlc233/team-conventions', '--dir', project]);
    expect(noIndex.status).toBe(2);
    expect(noIndex.out).toContain('需要一个索引');

    const index = join(ROOT, 'registry/index.json');
    const added = run(['add', 'lvlc233/team-conventions', '--dir', project], { PACKHUB_INDEX: index });
    expect(added.status).toBe(0);
    expect(added.out).toContain('装上');
    expect(existsSync(join(project, '.packhub/knowledge/style-guide.md'))).toBe(true);

    const verified = run(['verify', project]);
    expect(verified.status).toBe(0);
    expect(verified.out).toContain('1 个包');
    expect(verified.out).toContain('0 项失败');

    expect(existsSync(join(project, '.packhub/packs/lvlc233/team-conventions/packhub.yaml'))).toBe(true);
    const removed = run(['uninstall', project]);
    expect(removed.status).toBe(0);
    expect(existsSync(join(project, '.packhub/knowledge/style-guide.md'))).toBe(false);
    expect(existsSync(join(project, '.packhub/packs/lvlc233/team-conventions'))).toBe(false);

    rmSync(project, { recursive: true, force: true });
  });

  it('search 能读索引并按关键词过滤', () => {
    const index = join(ROOT, 'registry/index.json');
    const res = run(['search', 'conventions', '--index', index]);
    expect(res.status).toBe(0);
    expect(res.out).toContain('lvlc233/team-conventions');
  });

  it('sync 能把 skill 同步到两个 harness，并可移除', () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-cli-sync-'));
    const packDir = join(base, 'pack');
    const dsh = join(base, 'dsh');
    const codex = join(base, 'codex');
    mkdirSync(join(packDir, 'skills/hello'), { recursive: true });
    mkdirSync(dsh, { recursive: true });
    mkdirSync(codex, { recursive: true });
    writeFileSync(
      join(packDir, 'skills/hello/SKILL.md'),
      '---\nname: hello\ndescription: Hello.\n---\n\n# Hello\n',
      'utf8',
    );
    writeFileSync(
      join(packDir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/cli-sync
  version: 0.1.0
  targets: [dsh, codex]
requires:
  packhub: ">=0.0.1 <0.1"
resources:
  - id: hello
    type: skill
    source: ./skills/hello
`,
      'utf8',
    );
    const env = { PACKHUB_DSH_HOME: dsh, PACKHUB_CODEX_HOME: codex };

    const synced = run(['sync', packDir, '--to', 'dsh,codex'], env);
    expect(synced.status).toBe(0);
    expect(existsSync(join(dsh, 'skills/hello/SKILL.md'))).toBe(true);
    expect(existsSync(join(codex, 'skills/hello/SKILL.md'))).toBe(true);

    const checked = run(['doctor', '--global'], env);
    expect(checked.status).toBe(0);
    expect(checked.out).toContain('全部在位');

    const removed = run(['sync', packDir, '--to', 'dsh,codex', '--remove'], env);
    expect(removed.status).toBe(0);
    expect(existsSync(join(dsh, 'skills/hello'))).toBe(false);
    expect(existsSync(join(codex, 'skills/hello'))).toBe(false);

    rmSync(base, { recursive: true, force: true });
  });

  it('add --dry-run 不往项目里写任何东西', () => {
    const project = mkdtempSync(join(tmpdir(), 'packhub-cli-dry-'));
    const res = run(['add', 'lvlc233/team-conventions', '--dir', project, '--dry-run'], {
      PACKHUB_INDEX: join(ROOT, 'registry/index.json'),
    });
    expect(res.status).toBe(0);
    expect(res.out).toContain('planHash');
    expect(existsSync(join(project, '.packhub'))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it('安装到未声明的 target 会被拒绝', () => {
    const project = mkdtempSync(join(tmpdir(), 'packhub-cli-target-'));
    const res = run(['add', 'lvlc233/team-conventions', '--dir', project, '--target', 'claude-code'], {
      PACKHUB_INDEX: join(ROOT, 'registry/index.json'),
    });
    expect(res.status).toBe(2);
    expect(res.out).toContain('没有声明 target claude-code');
    expect(existsSync(join(project, '.packhub/knowledge'))).toBe(false);
    expect(existsSync(join(project, '.packhub/state.json'))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it('清单在锁定后被改过的 .phub 会被拒绝安装', async () => {
    const src = mkdtempSync(join(tmpdir(), 'packhub-cli-lock-'));
    writeFileSync(join(src, 'rules.md'), '# one\n', 'utf8');
    writeFileSync(
      join(src, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/locked, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`,
      'utf8',
    );
    const ctx = loadPack(src);
    writeFileSync(
      join(src, 'packhub.lock.json'),
      JSON.stringify(buildLock(ctx.manifest!, planFor(ctx).plan!), null, 2),
      'utf8',
    );
    // 锁生成后再往清单里加一个资源：锁与计划就对不上了
    writeFileSync(join(src, 'more.md'), '# more\n', 'utf8');
    writeFileSync(
      join(src, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/locked, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
  - id: more
    type: knowledge
    source: ./more.md
`,
      'utf8',
    );
    const archive = join(src, 'pack.phub');
    await packArchive(src, { vendored: true, out: archive });

    const project = mkdtempSync(join(tmpdir(), 'packhub-cli-lock-proj-'));
    const res = run(['add', archive, '--dir', project]);
    expect(res.status).toBe(2);
    expect(res.out).toContain('lock-mismatch');
    expect(existsSync(join(project, '.packhub/knowledge/rules.md'))).toBe(false);

    rmSync(src, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
});
