import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'packages/launcher/src/bin.ts');
const SKILL_FIXTURE = join(ROOT, 'test/fixtures/packs/doc-review');

const CLEANUP: string[] = [];
afterAll(() => {
  for (const dir of CLEANUP) rmSync(dir, { recursive: true, force: true });
});

const NAME = 'dsh-lvlc233-doc-review';

function newPalHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  CLEANUP.push(home);
  return home;
}

function palIn(home: string, args: string[]): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PACKHUB_INDEX;
  const res = spawnSync(process.execPath, ['--experimental-strip-types', BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...env,
      PACKHUB_HOME: home,
      PACKHUB_INSTANCES: join(home, 'instances'),
    },
  });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  CLEANUP.push(dir);
  return dir;
}

/** 一份 Pack 副本：update 会改它，所以不能直接用共享 fixture。 */
function packCopy(): { base: string; pack: string } {
  const base = tmp('pal-dsh-profile-pack-');
  const pack = join(base, 'pack');
  cpSync(SKILL_FIXTURE, pack, { recursive: true });
  return { base, pack };
}

const WEB_USER = '# 用户自己的 patch 层\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n';
const DESKTOP_USER = '- id: desktop-only\n  name: "@deepseek-ai/dsh-client-desktop-only"\n';

/** 一份 dsh home：给这些 profile 建 patch 文件（可带用户自己的内容）。 */
function dshHome(base: string, profiles: Record<string, string>): { home: string; patch: (name: string) => string } {
  const home = join(base, '.dsh');
  for (const [name, text] of Object.entries(profiles)) {
    const file = join(home, 'profiles', name, 'cordis.patch.yml');
    mkdirSync(join(home, 'profiles', name), { recursive: true });
    writeFileSync(file, text, 'utf8');
  }
  return { home, patch: (name: string) => join(home, 'profiles', name, 'cordis.patch.yml') };
}

function showJson(home: string, name: string): Record<string, unknown> {
  const res = palIn(home, ['show', name]);
  expect(res.status, res.out).toBe(0);
  return JSON.parse(res.out.slice(res.out.indexOf('{'), res.out.lastIndexOf('}') + 1)) as Record<string, unknown>;
}

describe('dsh attached 的 profile 选择', () => {
  it('默认不写 --profile：两个已有 profile 都装，记录不写 profile（= all）', () => {
    const palHome = newPalHome('pal-dsh-profile-all-');
    const { base, pack } = packCopy();
    const { home, patch } = dshHome(base, { web: WEB_USER, desktop: DESKTOP_USER });

    const res = palIn(palHome, ['install', pack, '--host', 'dsh', '--home', home]);
    expect(res.status, res.out).toBe(0);
    for (const name of ['web', 'desktop']) {
      expect(readFileSync(patch(name), 'utf8')).toContain('- id: pal-mcp-markdownlint');
    }
    expect(readFileSync(patch('web'), 'utf8')).toContain('ui-settings-general');
    expect(readFileSync(patch('desktop'), 'utf8')).toContain('desktop-only');
    expect(showJson(palHome, NAME).profile).toBeUndefined();
  }, 120_000);

  it('--profile web：只写 web，desktop 原样不动；记录记住 profile=web', () => {
    const palHome = newPalHome('pal-dsh-profile-one-');
    const { base, pack } = packCopy();
    const { home, patch } = dshHome(base, { web: WEB_USER, desktop: DESKTOP_USER });

    const res = palIn(palHome, ['install', pack, '--host', 'dsh', '--home', home, '--profile', 'web']);
    expect(res.status, res.out).toBe(0);
    expect(readFileSync(patch('web'), 'utf8')).toContain('- id: pal-mcp-markdownlint');
    expect(readFileSync(patch('web'), 'utf8')).toContain('ui-settings-general');
    // desktop 没被碰过：逐字节还是装之前那份
    expect(readFileSync(patch('desktop'), 'utf8')).toBe(DESKTOP_USER);
    // 内容落点与 all 一样（skills / 知识都在 home 层）
    expect(existsSync(join(home, 'skills/doc-review/SKILL.md'))).toBe(true);
    const rec = showJson(palHome, NAME);
    expect(rec.profile).toBe('web');
    expect(rec.attached).toBe(true);
  }, 120_000);

  it('--profile nope：退 2 并给出路径与下一步，不写盘、不创建 profile', () => {
    const palHome = newPalHome('pal-dsh-profile-missing-');
    const { base, pack } = packCopy();
    const { home } = dshHome(base, { web: WEB_USER });
    const missingDir = join(home, 'profiles', 'nope');

    const res = palIn(palHome, ['install', pack, '--host', 'dsh', '--home', home, '--profile', 'nope']);
    expect(res.status, res.out).toBe(2);
    expect(res.out).toContain('nope');
    expect(res.out).toContain('先启动一次 dsh');
    expect(existsSync(missingDir)).toBe(false);
    expect(existsSync(join(home, 'skills'))).toBe(false);
    expect(existsSync(join(home, '.packhub/state.json'))).toBe(false);
    expect(existsSync(join(home, 'instance.json'))).toBe(false);
  }, 120_000);

  it('零 profile：退 2 且不创建 profiles/web', () => {
    const palHome = newPalHome('pal-dsh-profile-none-');
    const { base, pack } = packCopy();
    const home = join(base, '.dsh');

    const res = palIn(palHome, ['install', pack, '--host', 'dsh', '--home', home]);
    expect(res.status, res.out).toBe(2);
    expect(res.out).toContain('没有任何 profile');
    expect(res.out).toContain('先启动一次 dsh');
    expect(res.out).toContain('--profile');
    expect(existsSync(join(home, 'profiles'))).toBe(false);
    expect(existsSync(join(home, '.packhub/state.json'))).toBe(false);
  }, 120_000);

  it('--profile 配 --project / 别的宿主 / managed home 都是用法错（退 2）', () => {
    const palHome = newPalHome('pal-dsh-profile-misuse-');
    const { base, pack } = packCopy();
    const project = join(base, 'proj');

    const byProject = palIn(palHome, ['install', pack, '--host', 'dsh', '--project', project, '--profile', 'web']);
    expect(byProject.status, byProject.out).toBe(2);
    expect(byProject.out).toContain('--profile 只对');
    expect(existsSync(project)).toBe(false);

    const otherHost = palIn(palHome, [
      'install', pack, '--host', 'opencode', '--home', join(base, 'oc'), '--profile', 'web',
    ]);
    expect(otherHost.status, otherHost.out).toBe(2);
    expect(otherHost.out).toContain('--profile 只对');
    expect(existsSync(join(base, 'oc'))).toBe(false);

    const managed = palIn(palHome, ['install', pack, '--host', 'dsh', '--profile', 'web']);
    expect(managed.status, managed.out).toBe(2);
    expect(managed.out).toContain('--profile 只对');

    const badName = palIn(palHome, ['install', pack, '--host', 'dsh', '--home', join(base, 'd'), '--profile', '../evil']);
    expect(badName.status, badName.out).toBe(2);
    expect(badName.out).toContain('不合法');
  }, 120_000);

  it('update 不带 --profile 时沿用记录：只更新那一个 profile', () => {
    const palHome = newPalHome('pal-dsh-profile-update-');
    const { base, pack } = packCopy();
    const { home, patch } = dshHome(base, { web: WEB_USER, desktop: DESKTOP_USER });
    expect(palIn(palHome, ['install', pack, '--host', 'dsh', '--home', home, '--profile', 'web']).status).toBe(0);
    const desktopBefore = readFileSync(patch('desktop'), 'utf8');

    // 改包：版本与知识内容都变
    writeFileSync(
      join(pack, 'packhub.yaml'),
      readFileSync(join(pack, 'packhub.yaml'), 'utf8').replace('version: 0.1.0', 'version: 0.1.1'),
      'utf8',
    );
    writeFileSync(join(pack, 'resources', 'review-rubric.md'), '# rubric v2\n', 'utf8');

    const updated = palIn(palHome, ['update', '--home', home]);
    expect(updated.status, updated.out).toBe(0);
    expect(readFileSync(join(home, 'knowledge', 'review-rubric.md'), 'utf8')).toBe('# rubric v2\n');
    // 沿用 profile=web：web 有条目，desktop 没被碰
    expect(readFileSync(patch('web'), 'utf8')).toContain('pal-mcp-markdownlint');
    expect(readFileSync(patch('desktop'), 'utf8')).toBe(desktopBefore);
    expect(showJson(palHome, NAME).profile).toBe('web');

    // 换 profile 不允许：update 会整份删掉别的 profile 的 patch（已知问题），先卸再装
    const switched = palIn(palHome, ['update', '--home', home, '--profile', 'desktop']);
    expect(switched.status, switched.out).toBe(2);
    expect(switched.out).toContain('不能改成');
    expect(switched.out).toContain('pal uninstall');

    // --project 上给 --profile 是用法错
    const byProject = palIn(palHome, ['update', '--project', join(base, 'proj'), '--profile', 'web']);
    expect(byProject.status, byProject.out).toBe(2);
    expect(byProject.out).toContain('--profile 只对');
  }, 120_000);

  it('verify 按 state 报 profile patch 里条目缺失；--profile 与记录不一致退 2', () => {
    const palHome = newPalHome('pal-dsh-profile-verify-');
    const { base, pack } = packCopy();
    const { home, patch } = dshHome(base, { web: WEB_USER, desktop: DESKTOP_USER });
    expect(palIn(palHome, ['install', pack, '--host', 'dsh', '--home', home, '--profile', 'web']).status).toBe(0);

    // 外部把 web 里的条目删掉：体检报配置漂移，指到那个 patch 文件
    writeFileSync(patch('web'), WEB_USER, 'utf8');
    const drifted = palIn(palHome, ['verify', '--home', home]);
    expect(drifted.status, drifted.out).not.toBe(0);
    expect(drifted.out).toContain('配置被改');
    expect(drifted.out).toContain('profiles/web/cordis.patch.yml');

    // 记录里是 web：拿 desktop 来核对是用法错（uninstall 同样只核对、不按 profile 收窄）
    const mismatch = palIn(palHome, ['verify', '--home', home, '--profile', 'desktop']);
    expect(mismatch.status, mismatch.out).toBe(2);
    expect(mismatch.out).toContain('profile「web」');
    const wrongUninstall = palIn(palHome, ['uninstall', '--home', home, '--profile', 'desktop']);
    expect(wrongUninstall.status, wrongUninstall.out).toBe(2);
    expect(wrongUninstall.out).toContain('profile「web」');
  }, 120_000);
});
