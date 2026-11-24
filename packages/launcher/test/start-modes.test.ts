import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * `pal start --mode` / `--list-modes` / `pal run` 的用法层：模式选择、可用性、参数与 kind 的匹配、
 * 三种执行路径（core / 前台 exec / app）。kernel 里模式表本身的断言在
 * packages/kernel/test/harness-modes.test.ts。
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'packages/launcher/src/bin.ts');
const FIXTURE = join(ROOT, 'test/fixtures/packs/doc-review');

const DSH_NAME = 'dsh-lvlc233-doc-review';
const OPENCODE_NAME = 'opencode-lvlc233-doc-review';
const CLAUDE_NAME = 'claude-code-lvlc233-doc-review';

/** 假 dsh 打印的地址：端口不真的监听，PAL 只从输出里认地址。 */
const FAKE_PORT = 51339;

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

function palIn(home: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): { status: number | null; out: string } {
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

function packCopy(base: string): string {
  const pack = join(base, 'pack');
  cpSync(FIXTURE, pack, { recursive: true });
  return pack;
}

function dshHome(base: string, profiles: string[]): string {
  const home = join(base, '.dsh');
  for (const name of profiles) {
    const dir = join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cordis.patch.yml'), '', 'utf8');
  }
  return home;
}

function jsonOut<T>(text: string): T {
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((index) => index >= 0);
  const start = Math.min(...starts);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  return JSON.parse(text.slice(start, end + 1)) as T;
}

function stopAll(home: string, name: string): void {
  palIn(home, ['stop', name]);
  palIn(home, ['__core', 'stop']);
}

function writeScript(dir: string, name: string, lines: string[]): string {
  mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const file = join(dir, `${name}.cmd`);
    writeFileSync(file, `${['@echo off', ...lines, ''].join('\r\n')}`, 'utf8');
    return file;
  }
  const file = join(dir, name);
  writeFileSync(file, `${['#!/bin/sh', ...lines, ''].join('\n')}`, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

/** 假 dsh：把真实 argv 写进 argsFile，再打一行地址后装死。 */
function fakeDsh(dir: string, argsFile: string): string {
  return writeScript(dir, 'dsh', [
    'if "%~1"=="--version" (',
    '  echo 1.0.0-fake',
    '  exit /b 0',
    ')',
    `echo %* > "${argsFile}"`,
    `echo dsh web: http://127.0.0.1:${FAKE_PORT}/`,
    'ping -n 60 127.0.0.1 >nul',
  ]);
}

/** 假前台宿主：把 argv 与环境写进 file，然后按给定的退出码退出。 */
function fakeTui(dir: string, name: string, file: string, exitCode: number): string {
  if (process.platform === 'win32') {
    return writeScript(dir, name, [
      `echo args=%* > "${file}"`,
      `echo CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR% >> "${file}"`,
      `echo cwd=%CD% >> "${file}"`,
      `exit /b ${exitCode}`,
    ]);
  }
  return writeScript(dir, name, [
    `printf 'args=%s\\n' "$*" > '${file}'`,
    `printf 'CLAUDE_CONFIG_DIR=%s\\n' "$CLAUDE_CONFIG_DIR" >> '${file}'`,
    `printf 'cwd=%s\\n' "$PWD" >> '${file}'`,
    `exit ${exitCode}`,
  ]);
}

describe('pal start --list-modes', () => {
  it('人读：id / kind / 可用性 / 默认；managed 的 app 报不可用原因', () => {
    const palHome = tmp('pal-modes-list-');
    const base = tmp('pal-modes-list-base-');
    const attached = dshHome(base, ['web', 'desktop']);
    expect(palIn(palHome, ['install', packCopy(base), '--host', 'dsh', '--home', attached]).status).toBe(0);

    const attachedOut = palIn(palHome, ['start', DSH_NAME, '--list-modes']);
    expect(attachedOut.status, attachedOut.out).toBe(0);
    expect(attachedOut.out).toContain('dsh 的启动模式（默认 web）');
    expect(attachedOut.out).toContain('web');
    expect(attachedOut.out).toContain('server');
    expect(attachedOut.out).toContain('app');
    expect(attachedOut.out).toContain('可用');
    expect(attachedOut.out).toContain('网页（web profile）');
    expect(attachedOut.out).toContain('桌面窗口（Electron app）');
    expect(attachedOut.out).not.toContain('不可用');

    // managed dsh：app 模式不可用，原因直接打出来
    const managedHome = tmp('pal-modes-list-managed-');
    const managedBase = tmp('pal-modes-list-managed-base-');
    expect(palIn(managedHome, ['install', packCopy(managedBase), '--host', 'dsh']).status).toBe(0);
    const managedOut = palIn(managedHome, ['start', DSH_NAME, '--list-modes']);
    expect(managedOut.status, managedOut.out).toBe(0);
    expect(managedOut.out).toContain('不可用：只支持 attached dsh');
  });

  it('--json：同一份事实的结构，带 default 与 reason', () => {
    const palHome = tmp('pal-modes-json-');
    const base = tmp('pal-modes-json-base-');
    expect(palIn(palHome, ['install', packCopy(base), '--host', 'opencode']).status).toBe(0);

    const res = palIn(palHome, ['start', OPENCODE_NAME, '--list-modes', '--json']);
    expect(res.status, res.out).toBe(0);
    const body = jsonOut<{
      harness: string;
      defaultMode: string;
      modes: { id: string; kind: string; default: boolean; available: boolean; reason?: string }[];
    }>(res.out);
    expect(body.harness).toBe('opencode');
    expect(body.defaultMode).toBe('tui');
    expect(body.modes).toEqual([
      { id: 'tui', label: '终端 TUI', kind: 'foreground', default: true, available: true },
      { id: 'web', label: '网页（本地 serve）', kind: 'server', default: false, available: true },
    ]);
  });
});

describe('pal start 的模式选择与参数匹配', () => {
  it('未知模式 / 模式不可用：退 2 并列出可选', () => {
    const palHome = tmp('pal-modes-unknown-');
    const base = tmp('pal-modes-unknown-base-');
    expect(palIn(palHome, ['install', packCopy(base), '--host', 'opencode']).status).toBe(0);

    const unknown = palIn(palHome, ['start', OPENCODE_NAME, '--mode', 'nope']);
    expect(unknown.status, unknown.out).toBe(2);
    expect(unknown.out).toContain('没有启动模式「nope」');
    expect(unknown.out).toContain('可选：tui / web');
  });

  it('--profile 配非 usesProfile 模式、--restart / --port 配非 server、--dir 配非前台：都退 2', () => {
    const palHome = tmp('pal-modes-args-');
    const base = tmp('pal-modes-args-base-');
    expect(palIn(palHome, ['install', packCopy(base), '--host', 'opencode']).status).toBe(0);

    const withProfile = palIn(palHome, ['start', OPENCODE_NAME, '--mode', 'web', '--profile', 'web']);
    expect(withProfile.status, withProfile.out).toBe(2);
    expect(withProfile.out).toContain('--profile 只对支持 profile 的模式有意义');

    const tuiRestart = palIn(palHome, ['start', OPENCODE_NAME, '--mode', 'tui', '--restart', 'never']);
    expect(tuiRestart.status, tuiRestart.out).toBe(2);
    expect(tuiRestart.out).toContain('--restart 只对 server 模式有意义');

    const tuiPort = palIn(palHome, ['start', OPENCODE_NAME, '--mode', 'tui', '--port', '5555']);
    expect(tuiPort.status, tuiPort.out).toBe(2);
    expect(tuiPort.out).toContain('--port 只对 server 模式有意义');

    // server 模式不接受 --dir
    const webDir = palIn(palHome, ['start', OPENCODE_NAME, '--mode', 'web', '--dir', tmp('pal-modes-dir-')]);
    expect(webDir.status, webDir.out).toBe(2);
    expect(webDir.out).toContain('--dir 只对前台模式有意义');
  });
});

describe('三种执行路径', () => {
  it('dsh --mode web 走 core：argv 带 --profile web，记录里有 port/url/launchMode', () => {
    const palHome = tmp('pal-modes-web-');
    const base = tmp('pal-modes-web-base-');
    const home = dshHome(base, ['web', 'desktop']);
    const argsFile = join(base, 'args.txt');
    const bin = fakeDsh(join(base, 'bin'), argsFile);
    expect(palIn(palHome, ['install', packCopy(base), '--host', 'dsh', '--home', home]).status).toBe(0);

    const started = palIn(palHome, ['start', DSH_NAME, '--mode', 'web'], { PAL_DSH_BIN: bin });
    try {
      expect(started.status, started.out).toBe(0);
      expect(started.out).toContain(`http://127.0.0.1:${FAKE_PORT}/`);
      expect(readFileSync(argsFile, 'utf8')).toMatch(/--profile\s+web\b/);
      expect(readFileSync(argsFile, 'utf8')).toContain('--no-open');
      expect(readFileSync(argsFile, 'utf8')).toContain('--port');

      const record = jsonOut<{ launchMode?: string; port?: number; url?: string; pid?: number }>(
        palIn(palHome, ['show', DSH_NAME]).out,
      );
      expect(record.launchMode).toBe('web');
      expect(record.port).toBe(FAKE_PORT);
      expect(record.url).toContain(`127.0.0.1:${FAKE_PORT}`);
    } finally {
      stopAll(palHome, DSH_NAME);
    }
  });

  it('claude --mode tui：前台 exec 原样透传退出码、注入 home 环境变量；--json 只打计划', () => {
    const palHome = tmp('pal-modes-tui-');
    const base = tmp('pal-modes-tui-base-');
    const seen = join(base, 'seen.txt');
    const binDir = join(base, 'bin');
    const bin = fakeTui(binDir, 'claude', seen, 7);
    expect(palIn(palHome, ['install', packCopy(base), '--host', 'claude-code']).status).toBe(0);

    const dry = palIn(palHome, ['start', CLAUDE_NAME, '--mode', 'tui', '--json'], { PATH: `${binDir};${process.env.PATH}` });
    expect(dry.status, dry.out).toBe(0);
    const plan = jsonOut<{ command: string; args: string[]; cwd: string; env: Record<string, string> }>(dry.out);
    expect(plan.command).toBe('claude');
    expect(plan.args).toEqual([]);
    expect(plan.env.CLAUDE_CONFIG_DIR).toContain('home');
    // --json 不启动：假 claude 没有写出任何东西
    expect(existsSync(seen)).toBe(false);

    const ran = palIn(palHome, ['start', CLAUDE_NAME, '--mode', 'tui'], { PATH: `${binDir};${process.env.PATH}` });
    expect(ran.status, ran.out).toBe(7);
    expect(existsSync(seen)).toBe(true);
    expect(readFileSync(seen, 'utf8')).toContain('CLAUDE_CONFIG_DIR=');
    // 前台模式不写运行记录：记录里没有 pid
    const record = jsonOut<{ pid?: number; status?: string }>(palIn(palHome, ['show', CLAUDE_NAME]).out);
    expect(record.pid).toBeUndefined();
  });

  it('run 是糖：等价于 start --mode <默认前台模式>；没有前台模式的宿主报错', () => {
    const palHome = tmp('pal-modes-run-');
    const base = tmp('pal-modes-run-base-');
    const seen = join(base, 'seen.txt');
    const binDir = join(base, 'bin');
    fakeTui(binDir, 'opencode', seen, 0);
    expect(palIn(palHome, ['install', packCopy(base), '--host', 'opencode']).status).toBe(0);

    const dry = palIn(palHome, ['run', OPENCODE_NAME, '--dry-run']);
    expect(dry.status, dry.out).toBe(0);
    const plan = jsonOut<{ command: string; args: string[] }>(dry.out);
    expect(plan.command).toBe('opencode');
    expect(plan.args).toEqual([]);

    // 默认前台模式就是 tui：run 与 start --mode tui 起同一条件
    const ran = palIn(palHome, ['run', OPENCODE_NAME], { PATH: `${binDir};${process.env.PATH}` });
    expect(ran.status, ran.out).toBe(0);
    expect(existsSync(seen)).toBe(true);

    // dsh 只有 web / app：run 退 2 并提示用 start --mode
    const dshPalHome = tmp('pal-modes-run-dsh-');
    const dshBase = tmp('pal-modes-run-dsh-base-');
    const home = dshHome(dshBase, ['web', 'desktop']);
    expect(palIn(dshPalHome, ['install', packCopy(dshBase), '--host', 'dsh', '--home', home]).status).toBe(0);
    const res = palIn(dshPalHome, ['run', DSH_NAME]);
    expect(res.status, res.out).toBe(2);
    expect(res.out).toContain('没有前台模式');
    expect(res.out).toContain('--mode');
    expect(res.out).toContain('web / app');
  });
});
