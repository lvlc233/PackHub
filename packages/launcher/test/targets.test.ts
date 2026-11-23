import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packArchive } from '@packhub/runtime';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'packages/launcher/src/bin.ts');
const FIXTURE = join(ROOT, 'test/fixtures/packs/team-conventions');
const SKILL_FIXTURE = join(ROOT, 'test/fixtures/packs/doc-review');

const HOMES: string[] = [];
afterAll(() => {
  for (const home of HOMES) rmSync(home, { recursive: true, force: true });
});

/** 每个用例一份隔离的 PAL 数据目录：默认名相同也不会互相撞。 */
function newPalHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  HOMES.push(home);
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
  return mkdtempSync(join(tmpdir(), prefix));
}

function packFixture(fixture = FIXTURE): { base: string; pack: string } {
  const base = tmp('pal-pack-');
  const pack = join(base, 'pack');
  cpSync(fixture, pack, { recursive: true });
  return { base, pack };
}

function showJson(home: string, name: string): Record<string, unknown> {
  const res = palIn(home, ['show', name]);
  expect(res.status, res.out).toBe(0);
  return JSON.parse(res.out.slice(res.out.indexOf('{'), res.out.lastIndexOf('}') + 1)) as Record<string, unknown>;
}

function listJson(home: string): { instances: Record<string, unknown>[] } {
  const res = palIn(home, ['list', '--json']);
  expect(res.status, res.out).toBe(0);
  return JSON.parse(res.out.slice(res.out.indexOf('{'), res.out.lastIndexOf('}') + 1)) as {
    instances: Record<string, unknown>[];
  };
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

describe('install 的 target', () => {
  it('--host 必填；--home 与 --project 互斥；--name 只配 home', () => {
    const palHome = newPalHome('pal-target-args-');
    const { base, pack } = packFixture();

    const noHost = palIn(palHome, ['install', pack]);
    expect(noHost.status).toBe(2);
    expect(noHost.out).toContain('install 需要 --host');
    expect(noHost.out).toContain('opencode');

    const both = palIn(palHome, ['install', pack, '--host', 'dsh', '--project', join(base, 'p1'), '--home', join(base, 'h1')]);
    expect(both.status).toBe(2);
    expect(both.out).toContain('target 只能给一个');
    expect(both.out).toContain('--home');

    const named = palIn(palHome, ['install', pack, '--host', 'dsh', '--project', join(base, 'p2'), '--name', 'x']);
    expect(named.status).toBe(2);
    expect(named.out).toContain('--name 只用于 managed / attached home');

    const badHost = palIn(palHome, ['install', pack, '--host', 'nope']);
    expect(badHost.status).toBe(2);
    expect(badHost.out).toContain('未知宿主');
    for (const id of ['dsh', 'claude-code', 'codex', 'opencode', 'workbody', 'hermes']) {
      expect(badHost.out).toContain(id);
    }
    rmSync(base, { recursive: true, force: true });
  });

  it('旧参数 --new / --environment / --harness / --kind 都退 2 并指向新名', () => {
    const palHome = newPalHome('pal-target-old-');
    for (const [flag, hint] of [
      ['--new', '--new 已删除'],
      ['--environment', '用 --home'],
      ['--harness', '用 --host'],
      ['--kind', '用 --host'],
    ] as const) {
      const res = palIn(palHome, ['install', 'x', flag]);
      expect(res.status, `${flag} 应被拒绝`).toBe(2);
      expect(res.out).toContain(`未知参数 ${flag}`);
      expect(res.out).toContain(hint);
    }
  });
});

describe('默认 target：managed 命名 home', () => {
  it('在 PAL 数据目录建 home，默认名 <host>-<packSlug>，输出 next: pal run <name>', () => {
    const palHome = newPalHome('pal-managed-');
    const { base, pack } = packFixture();

    const res = palIn(palHome, ['install', pack, '--host', 'opencode']);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('✓ opencode-lvlc233-team-conventions');
    expect(res.out).toContain('next: pal run opencode-lvlc233-team-conventions');

    const rec = showJson(palHome, 'opencode-lvlc233-team-conventions');
    expect(rec.attached).toBe(false);
    expect(rec.managed).toBe(true);
    const root = String(rec.root);
    expect(root.startsWith(join(palHome, 'instances'))).toBe(true);
    expect(existsSync(join(root, 'home/opencode/opencode/knowledge/style-guide.md'))).toBe(true);

    const list = palIn(palHome, ['list']);
    expect(list.status, list.out).toBe(0);
    expect(list.out).toContain('opencode-lvlc233-team-conventions');
    expect(list.out).toContain('managed');

    const run = palIn(palHome, ['run', 'opencode-lvlc233-team-conventions', '--dry-run']);
    expect(run.status, run.out).toBe(0);
    const plan = JSON.parse(run.out.slice(run.out.indexOf('{'), run.out.lastIndexOf('}') + 1)) as {
      command: string;
      env: Record<string, string>;
    };
    expect(plan.command).toBe('opencode');
    // managed home 仍注入宿主的 home 环境变量
    expect(plan.env.XDG_CONFIG_HOME).toBe(join(root, 'home/opencode'));

    rmSync(base, { recursive: true, force: true });
  });

  it('同名已存在 → 用法错，提示 update / run / --name', () => {
    const palHome = newPalHome('pal-managed-dup-');
    const { base, pack } = packFixture();

    expect(palIn(palHome, ['install', pack, '--host', 'opencode']).status).toBe(0);
    const dup = palIn(palHome, ['install', pack, '--host', 'opencode']);
    expect(dup.status).toBe(2);
    expect(dup.out).toContain('同名 home 已存在：opencode-lvlc233-team-conventions');
    expect(dup.out).toContain('pal update opencode-lvlc233-team-conventions');
    expect(dup.out).toContain('pal run opencode-lvlc233-team-conventions');
    expect(dup.out).toContain('--name');

    const named = palIn(palHome, ['install', pack, '--host', 'opencode', '--name', 'second']);
    expect(named.status, named.out).toBe(0);
    expect(showJson(palHome, 'second').name).toBe('second');
    rmSync(base, { recursive: true, force: true });
  });

  it('registry 包按名字 update / rollback 到新旧版本', async () => {
    const palHome = newPalHome('pal-managed-upd-');
    const base = tmp('pal-reg-');
    const index = await makeRegistry(base, [
      { version: '0.1.0', body: '# v1\n' },
      { version: '0.2.0', body: '# v2\n' },
    ]);

    const installed = palIn(palHome, [
      'install', 'demo/upd', '--version', '0.1.0', '--host', 'dsh', '--index', index,
    ]);
    expect(installed.status, installed.out).toBe(0);
    // server 型宿主（dsh）的下一步是 start，不是 run
    expect(installed.out).toContain('next: pal start dsh-demo-upd');
    const rec = showJson(palHome, 'dsh-demo-upd');
    const rules = join(String(rec.root), 'home/dsh/knowledge/rules.md');
    expect(readFileSync(rules, 'utf8')).toBe('# v1\n');

    const updated = palIn(palHome, ['update', '--home', 'dsh-demo-upd', '--index', index]);
    expect(updated.status, updated.out).toBe(0);
    expect(updated.out).toContain('demo/upd@0.1.0 → demo/upd@0.2.0');
    expect(readFileSync(rules, 'utf8')).toBe('# v2\n');

    const rolled = palIn(palHome, ['rollback', '--home', 'dsh-demo-upd']);
    expect(rolled.status, rolled.out).toBe(0);
    expect(rolled.out).toContain('回退');
    expect(readFileSync(rules, 'utf8')).toBe('# v1\n');
    rmSync(base, { recursive: true, force: true });
  });
});

describe('--home：attached home', () => {
  it('opencode：落 <home>/skills 与 <home>/opencode.json；list/show 标 attached；run 不注入 home 环境变量', () => {
    const palHome = newPalHome('pal-attached-');
    const { base, pack } = packFixture(SKILL_FIXTURE);
    const attachedHome = join(base, 'opencode-home');

    const res = palIn(palHome, ['install', pack, '--host', 'opencode', '--home', attachedHome]);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('next: pal run opencode-lvlc233-doc-review');
    expect(existsSync(join(attachedHome, 'skills/doc-review/SKILL.md'))).toBe(true);
    const config = JSON.parse(readFileSync(join(attachedHome, 'opencode.json'), 'utf8')) as {
      mcp: { servers: Record<string, unknown> };
    };
    expect(Object.keys(config.mcp.servers)).toContain('markdownlint');

    const rec = showJson(palHome, 'opencode-lvlc233-doc-review');
    expect(rec.attached).toBe(true);
    expect(rec.managed).toBe(false);
    expect(rec.root).toBe(attachedHome);

    const list = palIn(palHome, ['list']);
    expect(list.out).toContain('opencode-lvlc233-doc-review');
    expect(list.out).toContain('attached');

    // attached home 不注入 XDG_CONFIG_HOME：宿主本来就用它的全局位置
    const run = palIn(palHome, ['run', 'opencode-lvlc233-doc-review', '--dry-run']);
    expect(run.status, run.out).toBe(0);
    const plan = JSON.parse(run.out.slice(run.out.indexOf('{'), run.out.lastIndexOf('}') + 1)) as {
      env: Record<string, string>;
      cwd: string;
    };
    expect(plan.env.XDG_CONFIG_HOME).toBeUndefined();
    // 全局配置目录不当工作目录：没有 launch.json / --dir 就沿用当前目录
    expect(plan.cwd).toBe(resolve(ROOT));

    // verify 允许运行
    const verified = palIn(palHome, ['verify', '--home', attachedHome]);
    expect(verified.status, verified.out).toBe(0);
    rmSync(base, { recursive: true, force: true });
  }, 60_000);

  it('attached home：remove 只摘记录（目录保留）；clone / migrate / backup 仍拒绝', () => {
    const palHome = newPalHome('pal-attached-guard-');
    const { base, pack } = packFixture(SKILL_FIXTURE);
    const attachedHome = join(base, 'opencode-home');
    expect(palIn(palHome, ['install', pack, '--host', 'opencode', '--home', attachedHome]).status).toBe(0);
    // 用户自己的文件：摘记录后必须还在
    writeFileSync(join(attachedHome, 'mine.txt'), 'keep', 'utf8');

    for (const args of [
      ['clone', 'opencode-lvlc233-doc-review', '--name', 'copy'],
      ['migrate', 'opencode-lvlc233-doc-review', join(base, 'moved')],
      ['backup', 'opencode-lvlc233-doc-review'],
    ]) {
      const bad = palIn(palHome, args);
      expect(bad.status, `${args[0]} 应拒绝 attached home`).toBe(2);
      expect(bad.out).toContain('attached home 不归 PAL');
      expect(bad.out).toContain('remove 只摘记录');
    }

    const removed = palIn(palHome, ['remove', 'opencode-lvlc233-doc-review', '--yes']);
    expect(removed.status, removed.out).toBe(0);
    expect(removed.out).toContain('detached opencode-lvlc233-doc-review（目录保留）');
    // 卸包：PAL 装进去的 skill 没了；目录与用户文件都在
    expect(existsSync(join(attachedHome, 'skills/doc-review/SKILL.md'))).toBe(false);
    expect(readFileSync(join(attachedHome, 'mine.txt'), 'utf8')).toBe('keep');
    expect(existsSync(attachedHome)).toBe(true);
    expect(existsSync(join(attachedHome, 'instance.json'))).toBe(false);
    expect(existsSync(join(attachedHome, 'runtime.json'))).toBe(false);
    const list = listJson(palHome);
    expect(list.instances.map((row) => row.name)).not.toContain('opencode-lvlc233-doc-review');
    rmSync(base, { recursive: true, force: true });
  }, 60_000);

  it('attached remove：还在运行就退 2 提示 pal stop，目录与记录不动', () => {
    const palHome = newPalHome('pal-attached-running-');
    const { base, pack } = packFixture(SKILL_FIXTURE);
    const attachedHome = join(base, 'opencode-home');
    expect(palIn(palHome, ['install', pack, '--host', 'opencode', '--home', attachedHome]).status).toBe(0);

    const root = String(showJson(palHome, 'opencode-lvlc233-doc-review').root);
    const runtime = readFileSync(join(root, 'runtime.json'), 'utf8');
    writeFileSync(
      join(root, 'runtime.json'),
      JSON.stringify({ ...(JSON.parse(runtime) as object), status: 'running', pid: process.pid, spawnPid: process.pid }),
      'utf8',
    );

    const refused = palIn(palHome, ['remove', 'opencode-lvlc233-doc-review', '--yes']);
    expect(refused.status, refused.out).toBe(2);
    expect(refused.out).toContain('还在运行');
    expect(refused.out).toContain('pal stop');
    expect(existsSync(join(attachedHome, 'skills/doc-review/SKILL.md'))).toBe(true);
    expect(existsSync(join(attachedHome, 'instance.json'))).toBe(true);
    rmSync(base, { recursive: true, force: true });
  }, 60_000);

  it('attached 默认名冲突自动改用 <base>-attached；再冲突才退 2；显式 --name 冲突不退让', () => {
    const palHome = newPalHome('pal-attached-name-');
    const { base, pack } = packFixture(SKILL_FIXTURE);

    const first = palIn(palHome, ['install', pack, '--host', 'opencode', '--home', join(base, 'home-1')]);
    expect(first.status, first.out).toBe(0);
    expect(first.out).toContain('✓ opencode-lvlc233-doc-review');

    // 默认名已存在：自动区分成 -attached，并在输出里打印最终用的名字
    const second = palIn(palHome, ['install', pack, '--host', 'opencode', '--home', join(base, 'home-2')]);
    expect(second.status, second.out).toBe(0);
    expect(second.out).toContain('✓ opencode-lvlc233-doc-review-attached');
    expect(second.out).toContain('默认名 opencode-lvlc233-doc-review 已存在');
    const names = listJson(palHome).instances.map((row) => row.name);
    expect(names).toContain('opencode-lvlc233-doc-review');
    expect(names).toContain('opencode-lvlc233-doc-review-attached');

    // 两个候选都被占用：退 2，提示 --name，不写目录
    const thirdHome = join(base, 'home-3');
    const third = palIn(palHome, ['install', pack, '--host', 'opencode', '--home', thirdHome]);
    expect(third.status, third.out).toBe(2);
    expect(third.out).toContain('同名 home 已存在：opencode-lvlc233-doc-review');
    expect(third.out).toContain('也被占用');
    expect(third.out).toContain('--name');
    expect(existsSync(thirdHome)).toBe(false);

    // 显式 --name 冲突：不退让、不自动改名
    const explicit = palIn(palHome, [
      'install', pack, '--host', 'opencode', '--home', join(base, 'home-4'), '--name', 'opencode-lvlc233-doc-review',
    ]);
    expect(explicit.status, explicit.out).toBe(2);
    expect(explicit.out).toContain('同名 home 已存在：opencode-lvlc233-doc-review');
    rmSync(base, { recursive: true, force: true });
  }, 60_000);

  it('dsh：MCP 写进所有已有 profile 的 cordis.patch.yml，用户条目保留；卸载摘干净', () => {
    const palHome = newPalHome('pal-attached-dsh-');
    const { base, pack } = packFixture(SKILL_FIXTURE);
    const attachedHome = join(base, '.dsh');
    mkdirSync(join(attachedHome, 'profiles', 'web'), { recursive: true });
    mkdirSync(join(attachedHome, 'profiles', 'desktop'), { recursive: true });
    const webPatch = join(attachedHome, 'profiles', 'web', 'cordis.patch.yml');
    const desktopPatch = join(attachedHome, 'profiles', 'desktop', 'cordis.patch.yml');
    const webUser = [
      '# 用户自己的 patch 层（这段注释不该丢）',
      '- id: ui-settings-general',
      '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
      '  config:',
      '    welcomeNoticeVersion: 2026-09-28.1',
      '',
    ].join('\n');
    const desktopUser = [
      '- id: desktop-only',
      '  name: "@deepseek-ai/dsh-client-desktop-only"',
      '',
    ].join('\n');
    writeFileSync(webPatch, webUser, 'utf8');
    writeFileSync(desktopPatch, desktopUser, 'utf8');

    const res = palIn(palHome, ['install', pack, '--host', 'dsh', '--home', attachedHome]);
    expect(res.status, res.out).toBe(0);

    // 内容落点：技能 / 知识 / 提示词相对 home，指令是 <home>/AGENTS.md
    expect(existsSync(join(attachedHome, 'skills/doc-review/SKILL.md'))).toBe(true);
    expect(existsSync(join(attachedHome, 'knowledge/review-rubric.md'))).toBe(true);
    expect(existsSync(join(attachedHome, 'prompts/reader-brief.md'))).toBe(true);
    expect(readFileSync(join(attachedHome, 'AGENTS.md'), 'utf8')).toContain(
      '<!-- packhub:begin lvlc233/doc-review -->',
    );

    // 两个 profile 都拿到同一条 loader 条目；用户条目原样保留
    for (const file of [webPatch, desktopPatch]) {
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('- id: pal-mcp-markdownlint');
      expect(text).toContain('@deepseek-ai/dsh-mcp-client');
      expect(text).toContain('serverName: markdownlint');
      expect(text).toContain('transport: stdio');
      expect(text).toContain('command: npx');
    }
    const webAfter = readFileSync(webPatch, 'utf8');
    expect(webAfter).toContain('# 用户自己的 patch 层（这段注释不该丢）');
    expect(webAfter).toContain('ui-settings-general');
    expect(webAfter).toContain('welcomeNoticeVersion: 2026-09-28.1');
    expect(readFileSync(desktopPatch, 'utf8')).toContain('desktop-only');

    const verified = palIn(palHome, ['verify', '--home', attachedHome]);
    expect(verified.status, verified.out).toBe(0);

    // 外部把 desktop 里的条目删掉：体检报配置漂移
    writeFileSync(desktopPatch, desktopUser, 'utf8');
    const drifted = palIn(palHome, ['verify', '--home', attachedHome]);
    expect(drifted.status, drifted.out).not.toBe(0);
    expect(drifted.out).toContain('配置被改');
    expect(drifted.out).toContain('profiles/desktop/cordis.patch.yml');

    // 卸载：两处条目都消失，用户条目保留
    const removed = palIn(palHome, ['uninstall', '--home', attachedHome]);
    expect(removed.status, removed.out).toBe(0);
    for (const file of [webPatch, desktopPatch]) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('pal-mcp-markdownlint');
    }
    expect(readFileSync(webPatch, 'utf8')).toContain('ui-settings-general');
    expect(readFileSync(desktopPatch, 'utf8')).toContain('desktop-only');
    rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it('hermes / workbody 的 attached 落点：skills + 各自的配置文件', () => {
    const palHome = newPalHome('pal-attached-more-');
    const { base, pack } = packFixture(SKILL_FIXTURE);

    const hermesHome = join(base, 'hermes');
    const hermes = palIn(palHome, ['install', pack, '--host', 'hermes', '--home', hermesHome, '--name', 'hm']);
    expect(hermes.status, hermes.out).toBe(0);
    expect(existsSync(join(hermesHome, 'skills/doc-review/SKILL.md'))).toBe(true);
    expect(readFileSync(join(hermesHome, 'config.yaml'), 'utf8')).toContain('mcp_servers:');

    const workbodyHome = join(base, 'codebuddy');
    const workbody = palIn(palHome, ['install', pack, '--host', 'workbody', '--home', workbodyHome]);
    expect(workbody.status, workbody.out).toBe(0);
    expect(existsSync(join(workbodyHome, 'skills/doc-review/SKILL.md'))).toBe(true);
    const config = JSON.parse(readFileSync(join(workbodyHome, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(config.mcpServers)).toContain('markdownlint');
    rmSync(base, { recursive: true, force: true });
  });
});

describe('--home：claude-code / codex 的 attached 落点', () => {
  it('claude-code：skills / CLAUDE.md 落 home，MCP 落 home 旁的 .claude.json；卸载只摘自己的键', () => {
    const palHome = newPalHome('pal-attached-claude-');
    const { base, pack } = packFixture(SKILL_FIXTURE);
    const attachedHome = join(base, '.claude');
    const claudeJson = join(base, '.claude.json');
    // 用户已有的全局配置：装 / 卸都必须原样保留
    writeFileSync(
      claudeJson,
      JSON.stringify({ theme: 'dark', mcpServers: { mine: { command: 'user-server' } } }, null, 2) + '\n',
      'utf8',
    );

    const res = palIn(palHome, [
      'install', pack, '--host', 'claude-code', '--home', attachedHome,
    ]);
    expect(res.status, res.out).toBe(0);
    expect(existsSync(join(attachedHome, 'skills/doc-review/SKILL.md'))).toBe(true);
    expect(existsSync(join(attachedHome, 'knowledge/review-rubric.md'))).toBe(true);
    expect(existsSync(join(attachedHome, 'prompts/reader-brief.md'))).toBe(true);
    expect(readFileSync(join(attachedHome, 'CLAUDE.md'), 'utf8')).toContain(
      '<!-- packhub:begin lvlc233/doc-review -->',
    );

    const installed = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
      theme: string;
      mcpServers: Record<string, unknown>;
    };
    expect(installed.theme).toBe('dark');
    expect(Object.keys(installed.mcpServers).sort()).toEqual(['markdownlint', 'mine']);

    const removed = palIn(palHome, ['uninstall', '--home', attachedHome]);
    expect(removed.status, removed.out).toBe(0);
    expect(removed.out).toContain('.claude.json');
    const after = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
      theme: string;
      mcpServers?: Record<string, unknown>;
    };
    expect(after.theme).toBe('dark');
    expect(Object.keys(after.mcpServers ?? {})).toEqual(['mine']);
    expect(existsSync(join(attachedHome, 'skills/doc-review'))).toBe(false);
    // 指令文件里只剩我们那块、块外没有用户内容：按现有规则删掉空壳
    expect(existsSync(join(attachedHome, 'CLAUDE.md'))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  }, 60_000);

  it('claude-code：rollback 恢复安装前的 .claude.json（绝对路径快照）', () => {
    const palHome = newPalHome('pal-attached-claude-rb-');
    const { base, pack } = packFixture(SKILL_FIXTURE);
    const attachedHome = join(base, '.claude');
    const claudeJson = join(base, '.claude.json');
    const original = '{"theme":"dark"}';
    writeFileSync(claudeJson, original, 'utf8');

    expect(
      palIn(palHome, ['install', pack, '--host', 'claude-code', '--home', attachedHome]).status,
    ).toBe(0);
    const rolled = palIn(palHome, ['rollback', '--home', attachedHome]);
    expect(rolled.status, rolled.out).toBe(0);
    // 逐字节回到装之前（不是重新序列化）
    expect(readFileSync(claudeJson, 'utf8')).toBe(original);
    expect(existsSync(join(attachedHome, 'skills/doc-review'))).toBe(false);
    expect(existsSync(join(attachedHome, 'CLAUDE.md'))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  }, 60_000);

  it('codex：skills / AGENTS.md / config.toml 落 home；卸载按 key 摘块，用户配置保留', () => {
    const palHome = newPalHome('pal-attached-codex-');
    const { base, pack } = packFixture(SKILL_FIXTURE);
    const attachedHome = join(base, '.codex');
    mkdirSync(attachedHome, { recursive: true });
    writeFileSync(join(attachedHome, 'config.toml'), 'model = "gpt-test"\n', 'utf8');

    const res = palIn(palHome, ['install', pack, '--host', 'codex', '--home', attachedHome]);
    expect(res.status, res.out).toBe(0);
    expect(existsSync(join(attachedHome, 'skills/doc-review/SKILL.md'))).toBe(true);
    expect(existsSync(join(attachedHome, 'skills/doc-review/agents/openai.yaml'))).toBe(true);
    expect(existsSync(join(attachedHome, 'AGENTS.md'))).toBe(true);
    const config = readFileSync(join(attachedHome, 'config.toml'), 'utf8');
    expect(config).toContain('model = "gpt-test"');
    expect(config).toContain('[mcp_servers.markdownlint]');

    const removed = palIn(palHome, ['uninstall', '--home', attachedHome]);
    expect(removed.status, removed.out).toBe(0);
    expect(readFileSync(join(attachedHome, 'config.toml'), 'utf8')).toBe('model = "gpt-test"\n');
    expect(existsSync(join(attachedHome, 'skills/doc-review'))).toBe(false);
    expect(existsSync(join(attachedHome, 'AGENTS.md'))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  }, 60_000);

  it('dsh attached：一个 profile 都没有时退回 profiles/web，卸载后文件也不留', () => {
    const palHome = newPalHome('pal-attached-dsh-list-');
    const { base, pack } = packFixture(SKILL_FIXTURE);
    const attachedHome = join(base, '.dsh');

    const res = palIn(palHome, ['install', pack, '--host', 'dsh', '--home', attachedHome]);
    expect(res.status, res.out).toBe(0);
    const patch = join(attachedHome, 'profiles', 'web', 'cordis.patch.yml');
    expect(readFileSync(patch, 'utf8')).toContain('- id: pal-mcp-markdownlint');

    const removed = palIn(palHome, ['uninstall', '--home', attachedHome]);
    expect(removed.status, removed.out).toBe(0);
    // 这个 patch 文件是安装为「没有 profile」建出来的：摘完条目就不留空壳
    expect(existsSync(patch)).toBe(false);
    rmSync(base, { recursive: true, force: true });
  }, 120_000);
});

describe('--from-home：managed home 沿用全局凭据', () => {
  it('与 --home / --project 冲突：退 2，不写任何东西', () => {
    const palHome = newPalHome('pal-from-home-conflict-');
    const { base, pack } = packFixture();
    const fromHome = join(base, 'opencode-global');
    mkdirSync(fromHome, { recursive: true });

    const withHome = palIn(palHome, [
      'install', pack, '--host', 'opencode', '--home', join(base, 'attached'), '--from-home', fromHome,
    ]);
    expect(withHome.status, withHome.out).toBe(2);
    expect(withHome.out).toContain('--from-home 只能配默认 target');
    expect(withHome.out).toContain('attached');
    expect(existsSync(join(base, 'attached'))).toBe(false);

    const withProject = palIn(palHome, [
      'install', pack, '--host', 'dsh', '--project', join(base, 'proj'), '--from-home', fromHome,
    ]);
    expect(withProject.status, withProject.out).toBe(2);
    expect(withProject.out).toContain('--from-home 只能配默认 target');
    expect(existsSync(join(base, 'proj'))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  it('opencode 没有登记凭据文件：不复制任何东西，并明确提示', () => {
    const palHome = newPalHome('pal-from-home-empty-');
    const { base, pack } = packFixture();
    const fromHome = join(base, 'opencode-global');
    mkdirSync(fromHome, { recursive: true });
    writeFileSync(join(fromHome, 'auth.json'), '{"token":"x"}\n', 'utf8');

    const res = palIn(palHome, ['install', pack, '--host', 'opencode', '--from-home', fromHome]);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('宿主没有登记凭据文件');
    const root = String(showJson(palHome, 'opencode-lvlc233-team-conventions').root);
    expect(existsSync(join(root, 'home/opencode/auth.json'))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  it('dsh：按 credentialFiles 把凭据复制进新 home，源不存在的跳过并提示', () => {
    const palHome = newPalHome('pal-from-home-copy-');
    const { base, pack } = packFixture();
    const fromHome = join(base, 'dsh-global');
    mkdirSync(fromHome, { recursive: true });
    writeFileSync(join(fromHome, 'auth.json'), '{"token":"global"}\n', 'utf8');
    // .credentials.yaml 故意不建：源不存在应当跳过并提示

    const res = palIn(palHome, ['install', pack, '--host', 'dsh', '--from-home', fromHome]);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('--from-home 复制凭据：auth.json');
    expect(res.out).toContain('--from-home 跳过 .credentials.yaml');
    const root = String(showJson(palHome, 'dsh-lvlc233-team-conventions').root);
    expect(readFileSync(join(root, 'home/dsh/auth.json'), 'utf8')).toBe('{"token":"global"}\n');
    expect(existsSync(join(root, 'home/dsh/.credentials.yaml'))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('adopt：登记 attached home', () => {
  it('默认名用目录 basename；重名报错；list 标 attached', () => {
    const palHome = newPalHome('pal-adopt-');
    const base = tmp('pal-adopt-dir-');
    const dir = join(base, 'legacy-home');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{}\n', 'utf8');

    const missingHost = palIn(palHome, ['adopt', dir]);
    expect(missingHost.status).toBe(2);
    expect(missingHost.out).toContain('adopt 需要 --host');

    const ok = palIn(palHome, ['adopt', dir, '--host', 'opencode']);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).toContain('接管 legacy-home（attached）');
    const rec = showJson(palHome, 'legacy-home');
    expect(rec.attached).toBe(true);
    expect(rec.managed).toBe(false);
    expect(rec.root).toBe(dir);
    // 不动目录里的文件
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{}\n');

    const dup = palIn(palHome, ['adopt', dir, '--host', 'opencode']);
    expect(dup.status).toBe(2);
    expect(dup.out).toContain('同名 home 已存在');

    const list = palIn(palHome, ['list']);
    expect(list.out).toContain('legacy-home');
    expect(list.out).toContain('attached');
    rmSync(base, { recursive: true, force: true });
  });
});

describe('--project：项目 target 不变', () => {
  it('install --project --host dsh 只写项目；输出打开项目的下一步', () => {
    const palHome = newPalHome('pal-project-');
    const { base, pack } = packFixture();
    const project = join(base, 'proj');

    const res = palIn(palHome, ['install', pack, '--project', project, '--host', 'dsh']);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('warn');
    expect(res.out).toContain('项目内只写指路块');
    expect(res.out).toContain(`next: 在宿主里打开 ${project}`);
    expect(existsSync(join(project, '.packhub/knowledge/style-guide.md'))).toBe(true);
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(true);

    const verified = palIn(palHome, ['verify', '--project', project]);
    expect(verified.status, verified.out).toBe(0);
    rmSync(base, { recursive: true, force: true });
  });

  it('hermes（无项目级落点）：退 2，指向默认命名 home', () => {
    const palHome = newPalHome('pal-project-hermes-');
    const { base, pack } = packFixture();
    const project = join(base, 'proj');

    const res = palIn(palHome, ['install', pack, '--project', project, '--host', 'hermes']);
    expect(res.status).toBe(2);
    expect(res.out).toContain('没有项目级安装落点');
    expect(res.out).toContain('默认命名 home');
    expect(existsSync(project)).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('帮助与命令面', () => {
  it('install --help 只有新 target；旧参数不出现', () => {
    const palHome = newPalHome('pal-help-install-');
    const res = palIn(palHome, ['install', '--help']);
    expect(res.status).toBe(0);
    for (const flag of ['--host', '--home', '--project', '--name', '--from-home']) expect(res.out).toContain(flag);
    for (const old of ['--new', '--environment', '--harness', '--kind']) {
      expect(res.out, `help 不该再提 ${old}`).not.toContain(old);
    }
  });

  it('根帮助仍是 25 条，首组标题改成 home / 项目', () => {
    const palHome = newPalHome('pal-help-root-');
    const res = palIn(palHome, ['--help']);
    expect(res.status).toBe(0);
    expect(res.out).toContain('安装（target = home / 项目）：');
    const commandLines = res.out.split(/\r?\n/).filter((line) => /^ {2}\S/.test(line));
    expect(commandLines).toHaveLength(25);
    for (const old of ['--new', '--environment', '--harness', '--kind']) {
      expect(res.out).not.toContain(old);
    }
  });
});
