import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 真链路（CLI → core → spawn）在跑全量时会被拖慢：单文件基准 13s，满载可到 40s+
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * `pal start --profile` 的 CLI 行为：解析顺序与提示由命令层定，argv 由 kernel 的启动模式定。
 *
 * 这里走真链路（CLI → core → spawn），用一个假 dsh 把拿到的 argv 落盘：
 * 只看「传没传到宿主」，不启动真的 dsh。假宿主 `--version` 答一行版本，真启动时打印一行地址后装死，
 * 由测试用 `pal stop` 收掉。
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'packages/launcher/src/bin.ts');
const FIXTURE = join(ROOT, 'test/fixtures/packs/doc-review');

/** doc-review 包在 dsh 上的默认 home 名（与 dsh-profile.test.ts 同一份）。 */
const NAME = 'dsh-lvlc233-doc-review';
const OPENCODE_NAME = 'opencode-lvlc233-doc-review';

/** 假宿主打印的地址：端口不真的监听，PAL 只从输出里认地址。 */
const FAKE_PORT = 51337;

const CLEANUP: string[] = [];
afterAll(() => {
  for (const dir of CLEANUP) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 假宿主的 cwd 可能还在里面：进程已被 stop，留给系统清理 */
    }
  }
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  CLEANUP.push(dir);
  return dir;
}

function palIn(
  home: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number | null; out: string } {
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
      ...extraEnv,
    },
  });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** 一份 Pack 副本；遇到会改包的场景也不影响共享 fixture。 */
function packCopy(base: string): string {
  const pack = join(base, 'pack');
  cpSync(FIXTURE, pack, { recursive: true });
  return pack;
}

/** 一份 dsh home：给这些 profile 建好 patch 文件（attached 安装要求文件已存在）。 */
function dshHome(base: string, profiles: string[]): string {
  const home = join(base, '.dsh');
  for (const name of profiles) {
    const dir = join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cordis.patch.yml'), '', 'utf8');
  }
  return home;
}

/**
 * 假 dsh：把真实 argv 写进 `argsFile`，再打一行地址。
 * Windows 走 .cmd 垫片（PAL 会经 cmd /s /c 起它），其它平台走带 shebang 的 .sh。
 */
function fakeDsh(dir: string, argsFile: string): string {
  mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const file = join(dir, 'dsh.cmd');
    writeFileSync(
      file,
      [
        '@echo off',
        'if "%~1"=="--version" (',
        '  echo 1.0.0-fake',
        '  exit /b 0',
        ')',
        `echo %* > "${argsFile}"`,
        `echo dsh web: http://127.0.0.1:${FAKE_PORT}/`,
        'ping -n 60 127.0.0.1 >nul',
        '',
      ].join('\r\n'),
      'utf8',
    );
    return file;
  }
  const file = join(dir, 'dsh-fake.sh');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  echo 1.0.0-fake',
      '  exit 0',
      'fi',
      `printf '%s\\n' "$@" > '${argsFile}'`,
      `echo 'dsh web: http://127.0.0.1:${FAKE_PORT}/'`,
      'sleep 60',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(file, 0o755);
  return file;
}

/** 记录里的根（show 不拉起 core）。 */
function rootOf(home: string, name: string): string {
  const res = palIn(home, ['show', name]);
  expect(res.status, res.out).toBe(0);
  const body = JSON.parse(res.out.slice(res.out.indexOf('{'), res.out.lastIndexOf('}') + 1)) as {
    root?: string;
  };
  return String(body.root);
}

/** 收掉实例与 core；假宿主不真的监听，stop 只杀 spawnPid。 */
function stopAll(home: string, name: string): void {
  palIn(home, ['stop', name]);
  palIn(home, ['__core', 'stop']);
}

describe('pal start 的 profile（CLI）', () => {
  it('attached dsh 记录 profile=desktop：spawn 的 argv 带 --profile desktop', () => {
    const palHome = tmp('pal-start-profile-desktop-');
    const base = tmp('pal-start-profile-desktop-base-');
    const home = dshHome(base, ['web', 'desktop']);
    const argsFile = join(base, 'args.txt');
    const bin = fakeDsh(join(base, 'bin'), argsFile);

    const installed = palIn(palHome, [
      'install',
      packCopy(base),
      '--host',
      'dsh',
      '--home',
      home,
      '--profile',
      'desktop',
    ]);
    expect(installed.status, installed.out).toBe(0);

    const started = palIn(palHome, ['start', NAME], { PAL_DSH_BIN: bin });
    try {
      expect(started.status, started.out).toBe(0);
      expect(readFileSync(argsFile, 'utf8')).toMatch(/--profile\s+desktop\b/);
    } finally {
      stopAll(palHome, NAME);
    }
  });

  it('记录是 all 且没给 --profile：用 web（argv 可证），人读输出提示一行；--json 不提示', () => {
    const palHome = tmp('pal-start-profile-all-');
    const base = tmp('pal-start-profile-all-base-');
    const home = dshHome(base, ['web', 'desktop']);
    const argsFile = join(base, 'args.txt');
    const bin = fakeDsh(join(base, 'bin'), argsFile);

    // 不带 --profile：记录不写 profile（= all）
    expect(palIn(palHome, ['install', packCopy(base), '--host', 'dsh', '--home', home]).status).toBe(0);

    const json = palIn(palHome, ['start', NAME, '--json'], { PAL_DSH_BIN: bin });
    expect(json.status, json.out).toBe(0);
    expect(json.out).not.toContain('记录是 all');
    expect(readFileSync(argsFile, 'utf8')).toMatch(/--profile\s+web\b/);
    expect(palIn(palHome, ['stop', NAME]).status).toBe(0);

    const human = palIn(palHome, ['start', NAME], { PAL_DSH_BIN: bin });
    try {
      expect(human.status, human.out).toBe(0);
      expect(human.out).toContain('记录是 all，本次用 profile=web；要指定用 pal start --profile <名字>');
    } finally {
      stopAll(palHome, NAME);
    }
  });

  it('attached 指定不存在的 profile：退 2 且不 spawn（没有 core、没有启动日志）', () => {
    const palHome = tmp('pal-start-profile-missing-');
    const base = tmp('pal-start-profile-missing-base-');
    const home = dshHome(base, ['web', 'desktop']);
    expect(
      palIn(palHome, ['install', packCopy(base), '--host', 'dsh', '--home', home, '--profile', 'desktop']).status,
    ).toBe(0);

    const res = palIn(palHome, ['start', NAME, '--profile', 'nope']);
    expect(res.status, res.out).toBe(2);
    expect(res.out).toContain('profile「nope」不存在');
    expect(res.out).toContain('先启动一次 dsh');
    // 校验在 CLI 侧：既没拉起 core，也没写到实例的启动日志
    expect(existsSync(join(palHome, 'core.json'))).toBe(false);
    expect(existsSync(join(rootOf(palHome, NAME), 'logs'))).toBe(false);
  }, 120_000);

  it('--profile 配不支持 profile 的模式：退 2，不静默忽略', () => {
    const palHome = tmp('pal-start-profile-nondsh-');
    const base = tmp('pal-start-profile-nondsh-base-');
    expect(palIn(palHome, ['install', packCopy(base), '--host', 'opencode']).status).toBe(0);

    // opencode 默认模式是 tui（前台），只有 dsh 的 web 模式开 usesProfile
    const res = palIn(palHome, ['start', OPENCODE_NAME, '--profile', 'web']);
    expect(res.status, res.out).toBe(2);
    expect(res.out).toContain('--profile 只对支持 profile 的模式有意义');
  }, 120_000);
});
