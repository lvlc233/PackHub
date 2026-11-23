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

/** 一个只带知识 + 可选 stdio MCP 的 Pack（内容随版本变，保证计划真的变过）。 */
function mcpPack(dir: string, version: string, withMcp: boolean): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rubric.md'), `# rubric ${version}\n`, 'utf8');
  const mcp = withMcp
    ? ['  - id: markdownlint', '    type: mcp', '    source: npm:@dougis/markdown-lint-mcp@1.0.5', '    transport: stdio']
    : [];
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/dsh-mcp, version: ${version} }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
${[...mcp, '  - id: review-rubric', '    type: knowledge', '    source: ./rubric.md'].join('\n')}
`,
    'utf8',
  );
  return dir;
}

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
    // 文本级编辑：用户原文逐字节在前，我们的块追加在末尾
    expect(readFileSync(patch('web'), 'utf8').startsWith(WEB_USER)).toBe(true);
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

    // --project 上给 --profile 是用法错
    const byProject = palIn(palHome, ['update', '--project', join(base, 'proj'), '--profile', 'web']);
    expect(byProject.status, byProject.out).toBe(2);
    expect(byProject.out).toContain('--profile 只对');
  }, 120_000);

  it('update --profile 换范围：web → desktop，旧条目摘掉、用户条目保留、记录与 health 一起换', () => {
    const palHome = newPalHome('pal-dsh-profile-switch-');
    const { base, pack } = packCopy();
    const { home, patch } = dshHome(base, { web: WEB_USER, desktop: DESKTOP_USER });
    expect(palIn(palHome, ['install', pack, '--host', 'dsh', '--home', home, '--profile', 'web']).status).toBe(0);
    expect(readFileSync(patch('web'), 'utf8')).toContain('pal-mcp-markdownlint');

    const switched = palIn(palHome, ['update', '--home', home, '--profile', 'desktop']);
    expect(switched.status, switched.out).toBe(0);
    expect(switched.out).toContain('profile：web → desktop');
    // 旧 profile：本包条目摘掉，用户自己的内容逐字节不动
    expect(readFileSync(patch('web'), 'utf8')).toBe(WEB_USER);
    expect(readFileSync(patch('web'), 'utf8')).not.toContain('pal-mcp-');
    // 新 profile：条目写进去，用户条目保留
    const desktopText = readFileSync(patch('desktop'), 'utf8');
    expect(desktopText).toContain('- id: pal-mcp-markdownlint');
    expect(desktopText).toContain('desktop-only');
    expect(desktopText.startsWith(DESKTOP_USER)).toBe(true);
    expect(showJson(palHome, NAME).profile).toBe('desktop');

    // verify 按新记录核对：desktop 有条目、web 不在 scope 里，不报漂移
    const verified = palIn(palHome, ['verify', '--home', home]);
    expect(verified.status, verified.out).toBe(0);

    // health：desktop 正常，web 是 scope 外「未安装」而不是 mcpMissing
    const text = palIn(palHome, ['health', NAME]);
    expect(text.status, text.out).toBe(0);
    expect(text.out).toContain('未安装（scope=desktop）：web');
    expect(text.out).toContain('pal update --profile');
    const json = palIn(palHome, ['health', NAME, '--json']);
    expect(json.status, json.out).toBe(0);
    const report = JSON.parse(json.out.slice(json.out.indexOf('{'), json.out.lastIndexOf('}') + 1)) as {
      mcp?: { scope?: string; wired?: boolean; outOfScope?: string[] };
      mcpMissing?: string[];
    };
    expect(report.mcp).toMatchObject({ scope: 'desktop', wired: true, outOfScope: ['web'] });
    expect(report.mcpMissing).toBeUndefined();
  }, 120_000);

  it('update --profile 换范围：all → web，其它 profile 的条目摘掉', () => {
    const palHome = newPalHome('pal-dsh-profile-all-to-web-');
    const { base, pack } = packCopy();
    const { home, patch } = dshHome(base, { web: WEB_USER, desktop: DESKTOP_USER });
    expect(palIn(palHome, ['install', pack, '--host', 'dsh', '--home', home]).status).toBe(0);
    for (const name of ['web', 'desktop']) {
      expect(readFileSync(patch(name), 'utf8')).toContain('pal-mcp-markdownlint');
    }

    const switched = palIn(palHome, ['update', '--home', home, '--profile', 'web']);
    expect(switched.status, switched.out).toBe(0);
    expect(switched.out).toContain('profile：all → web');
    expect(readFileSync(patch('desktop'), 'utf8')).toBe(DESKTOP_USER);
    expect(readFileSync(patch('web'), 'utf8')).toContain('pal-mcp-markdownlint');
    expect(showJson(palHome, NAME).profile).toBe('web');

    const json = palIn(palHome, ['health', NAME, '--json']);
    expect(json.status, json.out).toBe(0);
    const report = JSON.parse(json.out.slice(json.out.indexOf('{'), json.out.lastIndexOf('}') + 1)) as {
      mcp?: { scope?: string; outOfScope?: string[] };
    };
    expect(report.mcp).toMatchObject({ scope: 'web', outOfScope: ['desktop'] });
  }, 120_000);

  it('update --profile all：从单个 profile 切回全部已有 profile', () => {
    const palHome = newPalHome('pal-dsh-profile-web-to-all-');
    const { base, pack } = packCopy();
    const { home, patch } = dshHome(base, { web: WEB_USER, desktop: DESKTOP_USER });
    expect(palIn(palHome, ['install', pack, '--host', 'dsh', '--home', home, '--profile', 'web']).status).toBe(0);
    expect(readFileSync(patch('desktop'), 'utf8')).toBe(DESKTOP_USER);

    const switched = palIn(palHome, ['update', '--home', home, '--profile', 'all']);
    expect(switched.status, switched.out).toBe(0);
    expect(switched.out).toContain('profile：web → all');
    expect(readFileSync(patch('web'), 'utf8')).toContain('pal-mcp-markdownlint');
    expect(readFileSync(patch('desktop'), 'utf8')).toContain('pal-mcp-markdownlint');
    expect(readFileSync(patch('desktop'), 'utf8')).toContain('desktop-only');
    expect(showJson(palHome, NAME).profile).toBeUndefined();

    const json = palIn(palHome, ['health', NAME, '--json']);
    const report = JSON.parse(json.out.slice(json.out.indexOf('{'), json.out.lastIndexOf('}') + 1)) as {
      mcp?: { scope?: string; outOfScope?: string[] };
    };
    expect(report.mcp).toMatchObject({ scope: 'all' });
    expect(report.mcp?.outOfScope).toBeUndefined();
  }, 120_000);

  it('update --profile 指向不存在的 profile：退 2，记录与 patch 都不动', () => {
    const palHome = newPalHome('pal-dsh-profile-switch-missing-');
    const { base, pack } = packCopy();
    const { home, patch } = dshHome(base, { web: WEB_USER, desktop: DESKTOP_USER });
    expect(palIn(palHome, ['install', pack, '--host', 'dsh', '--home', home, '--profile', 'web']).status).toBe(0);
    const webBefore = readFileSync(patch('web'), 'utf8');
    const desktopBefore = readFileSync(patch('desktop'), 'utf8');

    const res = palIn(palHome, ['update', '--home', home, '--profile', 'nope']);
    expect(res.status, res.out).toBe(2);
    expect(res.out).toContain('nope');
    expect(res.out).toContain('先启动一次 dsh');
    expect(showJson(palHome, NAME).profile).toBe('web');
    expect(readFileSync(patch('web'), 'utf8')).toBe(webBefore);
    expect(readFileSync(patch('desktop'), 'utf8')).toBe(desktopBefore);
    expect(existsSync(join(home, 'profiles', 'nope'))).toBe(false);
  }, 120_000);

  it('update --profile 配 --project / 别的 target 仍是用法错（退 2）', () => {
    const palHome = newPalHome('pal-dsh-profile-update-misuse-');
    const { base, pack } = packCopy();
    const byProject = palIn(palHome, ['update', '--project', join(base, 'proj'), '--profile', 'web']);
    expect(byProject.status, byProject.out).toBe(2);
    expect(byProject.out).toContain('--profile 只对');
    // managed home / 别的宿主同样拒：--profile 没有 per-profile 语义
    const host = palIn(palHome, ['install', pack, '--host', 'dsh', '--name', 'managed-dsh']);
    expect(host.status, host.out).toBe(0);
    const managed = palIn(palHome, ['update', '--home', 'managed-dsh', '--profile', 'web']);
    expect(managed.status, managed.out).toBe(2);
    expect(managed.out).toContain('--profile 只对');
  }, 120_000);


  it('update 去掉一个 MCP 资源：两个 profile 的条目摘掉，用户内容逐字节不变', () => {
    const palHome = newPalHome('pal-dsh-profile-update-mcp-');
    const base = tmp('pal-dsh-update-mcp-');
    const pack = mcpPack(join(base, 'pack'), '0.1.0', true);
    const { home, patch } = dshHome(base, { web: WEB_USER, desktop: DESKTOP_USER });
    expect(palIn(palHome, ['install', pack, '--host', 'dsh', '--home', home]).status).toBe(0);
    for (const name of ['web', 'desktop']) {
      expect(readFileSync(patch(name), 'utf8')).toContain('- id: pal-mcp-markdownlint');
    }

    mcpPack(pack, '0.2.0', false);
    const updated = palIn(palHome, ['update', '--home', home]);
    expect(updated.status, updated.out).toBe(0);
    expect(updated.out).toContain('旧文件已清掉');
    expect(updated.out).toContain('profiles/web/cordis.patch.yml');
    // 共享文件没被整份删：用户写的那段回来了，只在末尾加过/摘过我们自己的块
    expect(readFileSync(patch('web'), 'utf8')).toBe(WEB_USER);
    expect(readFileSync(patch('desktop'), 'utf8')).toBe(DESKTOP_USER);
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
