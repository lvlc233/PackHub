import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstance, requireInstance, writeInstance, type InstanceRecord } from '../src/index.ts';
import { isPalError, type PalError } from '../src/errors.ts';
import { isPidAlive, killTree } from '../src/process.ts';
import { psReport } from '../src/ps.ts';
import { checkInstance } from '../src/health.ts';
import { stopInstance, type SpawnFn } from '../src/start.ts';
import {
  DSH_APP_ENV,
  DSH_APP_NAME,
  assertAppStartable,
  dshAppCandidates,
  resolveDshAppBin,
  startAppInstance,
} from '../src/startApp.ts';
import { readEvents } from '../src/logs.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'packages/launcher/src/bin.ts');
const FIXTURE = join(ROOT, 'test/fixtures/packs/doc-review');
/** doc-review 在 dsh 上的默认 home 名（与 dsh-profile.test.ts 同一份）。 */
const NAME = 'dsh-lvlc233-doc-review';
const OPENCODE_NAME = 'opencode-lvlc233-doc-review';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-app-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  process.env.PACKHUB_HOME = join(tmp, 'home');
});

afterEach(() => {
  delete process.env.PACKHUB_INSTANCES;
  delete process.env.PACKHUB_HOME;
  delete process.env.PAL_DSH_APP_BIN;
  delete process.env.LOCALAPPDATA;
  delete process.env.ProgramFiles;
  delete process.env['ProgramFiles(x86)'];
  rmSync(tmp, { recursive: true, force: true });
});

/** 一份 attached dsh home：建好这些 profile 的 patch 文件（attached 安装要求它们已存在）。 */
function dshHome(base: string, profiles: string[]): string {
  const home = join(base, '.dsh');
  for (const name of profiles) {
    const dir = join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cordis.patch.yml'), '', 'utf8');
  }
  return home;
}

async function attachedDsh(name: string): Promise<InstanceRecord> {
  const home = dshHome(join(tmp, name), ['web', 'desktop']);
  return createInstance({ name, harness: 'dsh', packDir: FIXTURE, attachedHome: home });
}

interface Seen {
  file?: string;
  args?: string[];
  options?: Record<string, unknown>;
}

/** 假 app：只记下 spawn 参数，返回一个固定 pid。 */
function fakeSpawn(seen: Seen, pid: number | undefined = 4545): SpawnFn {
  return (file, args, options) => {
    seen.file = file;
    seen.args = args;
    seen.options = options as Record<string, unknown>;
    return { ...(pid === undefined ? {} : { pid }), unref: () => {}, once: () => {} };
  };
}

function codeOf(err: unknown): PalError | undefined {
  return isPalError(err) ? err : undefined;
}

describe('app 可执行文件解析', () => {
  const appAt = (root: string): string => join(root, 'DeepSeek Harness', DSH_APP_NAME);

  it('PAL_DSH_APP_BIN 优先：装了常见路径也不用它', () => {
    const local = join(tmp, 'local');
    const explicit = join(tmp, 'custom', 'custom.exe');
    const found = resolveDshAppBin({
      env: { [DSH_APP_ENV]: explicit, LOCALAPPDATA: local, ProgramFiles: join(tmp, 'pf') },
      platform: 'win32',
      exists: (file) => file === explicit || file === join(local, 'Programs', 'DeepSeek Harness', DSH_APP_NAME),
    });
    expect(found).toBe(explicit);
  });

  it('没有变量时按 Windows 常见路径顺序找：Programs → ProgramFiles → ProgramFiles(x86) → LOCALAPPDATA', () => {
    const env = {
      LOCALAPPDATA: join(tmp, 'local'),
      ProgramFiles: join(tmp, 'pf'),
      'ProgramFiles(x86)': join(tmp, 'pf86'),
    };
    expect(dshAppCandidates(env)).toEqual([
      join(tmp, 'local', 'Programs', 'DeepSeek Harness', DSH_APP_NAME),
      appAt(join(tmp, 'pf')),
      appAt(join(tmp, 'pf86')),
      appAt(join(tmp, 'local')),
    ]);

    const wanted = appAt(join(tmp, 'pf'));
    expect(
      resolveDshAppBin({
        env,
        platform: 'win32',
        exists: (file) => file === wanted,
      }),
    ).toBe(wanted);
  });

  it('常见路径都找不到：退 2 的 invalid-input，文案提示 PAL_DSH_APP_BIN', () => {
    let caught: unknown;
    try {
      resolveDshAppBin({ env: { LOCALAPPDATA: join(tmp, 'local') }, platform: 'win32', exists: () => false });
    } catch (err) {
      caught = err;
    }
    const pal = codeOf(caught);
    expect(pal?.code).toBe('invalid-input');
    expect(pal?.message).toContain('找不到 dsh 桌面 app');
    expect(pal?.hint).toContain(DSH_APP_ENV);
  });

  it('PAL_DSH_APP_BIN 指向不存在的文件：不静默回退常见路径，直接报错', () => {
    const missing = join(tmp, 'nope', 'DeepSeek Harness.exe');
    let caught: unknown;
    try {
      resolveDshAppBin({
        env: { [DSH_APP_ENV]: missing, LOCALAPPDATA: join(tmp, 'local') },
        platform: 'win32',
        exists: () => false,
      });
    } catch (err) {
      caught = err;
    }
    const pal = codeOf(caught);
    expect(pal?.code).toBe('invalid-input');
    expect(pal?.message).toContain(missing);
  });
});

describe('--app 的用法检查', () => {
  it('非 dsh 宿主：退 2 的 invalid-input', () => {
    const rec = { harness: 'opencode', attached: true } as unknown as InstanceRecord;
    let caught: unknown;
    try {
      assertAppStartable(rec);
    } catch (err) {
      caught = err;
    }
    expect(codeOf(caught)?.code).toBe('invalid-input');
    expect(codeOf(caught)?.message).toContain('--app 只对 dsh');
  });

  it('managed dsh：退 2，文案指向 attached dsh 或先起 web', () => {
    const rec = { harness: 'dsh', attached: false } as unknown as InstanceRecord;
    let caught: unknown;
    try {
      assertAppStartable(rec);
    } catch (err) {
      caught = err;
    }
    expect(codeOf(caught)?.code).toBe('invalid-input');
    expect(codeOf(caught)?.message).toContain(
      'managed 的 app 启动要先确认它能用 DSH_HOME 指到实例；目前用 --home 的 attached dsh，或先 pal start 起 web',
    );
  });

  it('与 --profile 互斥：退 2，不走到 spawn', () => {
    const rec = { harness: 'dsh', attached: true } as unknown as InstanceRecord;
    let caught: unknown;
    try {
      assertAppStartable(rec, { profile: 'desktop' });
    } catch (err) {
      caught = err;
    }
    expect(codeOf(caught)?.code).toBe('invalid-input');
    expect(codeOf(caught)?.message).toContain('--app 与 --profile 互斥');
  });
});

describe('app 启动与运行态', () => {
  it('成功启动：pid=spawnPid、status/startedAt 落盘，没有 port/url/listenPid', async () => {
    const rec = await attachedDsh('app-run');
    const app = join(tmp, 'bin', 'DeepSeek Harness.exe');
    const seen: Seen = {};
    const before = Date.now();

    const started = startAppInstance(rec.id, { appBin: app, spawn: fakeSpawn(seen, 4545), isAlive: () => false });

    // 直起可执行文件、不带参数；cwd 是实例根，DSH_HOME 指到记录里的 home
    expect(seen.file).toBe(app);
    expect(seen.args).toEqual([]);
    const options = seen.options!;
    expect(options.cwd).toBe(rec.root);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
    expect((options.env as NodeJS.ProcessEnv).DSH_HOME).toBe(rec.home);

    expect(started.status).toBe('running');
    expect(started.pid).toBe(4545);
    expect(started.spawnPid).toBe(4545);
    expect(started.listenPid).toBeUndefined();
    expect(started.port).toBeUndefined();
    expect(started.url).toBeUndefined();
    expect(Date.parse(started.startedAt!)).toBeGreaterThanOrEqual(before);

    const persisted = requireInstance(rec.id);
    expect(persisted.pid).toBe(4545);
    expect(persisted.spawnPid).toBe(4545);
    expect(persisted.port).toBeUndefined();
    expect(persisted.url).toBeUndefined();
    expect(readEvents(rec.root, 20).some((event) => event.event === 'app-start' && event.pid === 4545)).toBe(true);
  });

  it('已经在运行：already-running，不再 spawn', async () => {
    const rec = await attachedDsh('app-twice');
    writeInstance({ ...requireInstance(rec.id), status: 'running', pid: process.pid, spawnPid: process.pid });
    let spawned = false;

    let caught: unknown;
    try {
      startAppInstance(rec.id, {
        appBin: join(tmp, 'bin', 'DeepSeek Harness.exe'),
        isAlive: () => true,
        spawn: (file, args, options) => {
          spawned = true;
          return fakeSpawn({}, 1111)(file, args, options);
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(codeOf(caught)?.code).toBe('already-running');
    expect(spawned).toBe(false);
  });

  it('上一轮 pid 已死：先标 broken、收回运行态，再起新的 app', async () => {
    const rec = await attachedDsh('app-stale');
    writeInstance({ ...requireInstance(rec.id), status: 'running', pid: 987654, port: 51234, url: 'http://127.0.0.1:51234/' });

    const started = startAppInstance(rec.id, {
      appBin: join(tmp, 'bin', 'DeepSeek Harness.exe'),
      spawn: fakeSpawn({}, 4546),
      isAlive: () => false,
    });

    expect(started.pid).toBe(4546);
    expect(started.port).toBeUndefined();
    expect(started.url).toBeUndefined();
    expect(readEvents(rec.root, 20).some((event) => event.event === 'stale-pid' && event.pid === 987654)).toBe(true);
  });

  it('stop 对 app 记录用 spawnPid 杀（没有端口也能杀），停完 pid 清空', async () => {
    const rec = await attachedDsh('app-stop');
    let alive = true;
    startAppInstance(rec.id, {
      appBin: join(tmp, 'bin', 'DeepSeek Harness.exe'),
      spawn: fakeSpawn({}, 4711),
      isAlive: () => false,
    });

    const killed: number[] = [];
    const stopped = await stopInstance(rec.id, {
      kill: (pid) => {
        killed.push(pid);
        alive = false;
      },
      isAlive: (pid) => pid === 4711 && alive,
    });

    expect(killed).toEqual([4711]);
    expect(stopped.status).toBe('stopped');
    expect(stopped.pid).toBeUndefined();
    expect(stopped.spawnPid).toBeUndefined();
  });

  it('ps 对 app 记录：显示 pid，port/url 为空', async () => {
    const rec = await attachedDsh('app-ps');
    startAppInstance(rec.id, {
      appBin: join(tmp, 'bin', 'DeepSeek Harness.exe'),
      spawn: fakeSpawn({}, process.pid),
      isAlive: () => false,
    });

    const row = psReport({ isAlive: () => true, now: Date.now() }).instances.find((item) => item.id === rec.id);
    expect(row).toMatchObject({ pid: process.pid, port: null, url: null, stale: false, status: 'running' });
  });

  it('health 对 app 记录：进程在就 ok，没有端口就不做端口检查', async () => {
    const rec = await attachedDsh('app-health');
    startAppInstance(rec.id, {
      appBin: join(tmp, 'bin', 'DeepSeek Harness.exe'),
      spawn: fakeSpawn({}, process.pid),
      isAlive: () => false,
    });

    const report = await checkInstance(rec.id);
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === 'process')?.status).toBe('ok');
    expect(report.checks.some((check) => check.name === 'port')).toBe(false);
  });
});

describe('pal start --app（CLI）', () => {
  const CLEANUP: number[] = [];
  const DIRS: string[] = [];

  afterAll(() => {
    for (const pid of CLEANUP) {
      try {
        if (isPidAlive(pid)) killTree(pid);
      } catch {
        /* 已经退出 */
      }
    }
    for (const dir of DIRS) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 还在被占用就留给系统 */
      }
    }
  });

  function tmpDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    DIRS.push(dir);
    return dir;
  }

  function palIn(home: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): { status: number | null; out: string } {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.PACKHUB_INDEX;
    delete env.PAL_DSH_APP_BIN;
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

  function showJson(home: string, name: string): InstanceRecord {
    const res = palIn(home, ['show', name]);
    expect(res.status, res.out).toBe(0);
    return jsonOut<InstanceRecord>(res.out);
  }

  /** 从命令输出里取 JSON：stderr 的 node 警告会跟 stdout 混在一起，只截第一对括号到最后一对。 */
  function jsonOut<T>(text: string): T {
    const starts = [text.indexOf('{'), text.indexOf('[')].filter((index) => index >= 0);
    const start = Math.min(...starts);
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    return JSON.parse(text.slice(start, end + 1)) as T;
  }

  /** 假 app：Windows 用 .cmd（sleep 住），其它平台用 .sh。返回可执行文件路径。 */
  function fakeApp(dir: string): string {
    mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32') {
      const file = join(dir, 'DeepSeek Harness.cmd');
      writeFileSync(file, ['@echo off', 'ping -n 60 127.0.0.1 >nul', ''].join('\r\n'), 'utf8');
      return file;
    }
    const file = join(dir, 'deepseek-harness.sh');
    writeFileSync(file, ['#!/bin/sh', 'sleep 60', ''].join('\n'), 'utf8');
    chmodSync(file, 0o755);
    return file;
  }

  it(
    'attached dsh：启动窗口并记 pid，ps/health 正常，stop 收掉；再启动报 already-running',
    () => {
      const palHome = tmpDir('pal-app-cli-');
      const base = tmpDir('pal-app-cli-base-');
      const home = dshHome(base, ['web', 'desktop']);
      const app = fakeApp(join(base, 'app'));
      const installed = palIn(palHome, ['install', packCopy(base), '--host', 'dsh', '--home', home]);
      expect(installed.status, installed.out).toBe(0);

      const started = palIn(palHome, ['start', NAME, '--app'], { PAL_DSH_APP_BIN: app });
      try {
        expect(started.status, started.out).toBe(0);
        expect(started.out).toContain('app running');
        expect(started.out).toContain('窗口已启动');
        expect(started.out).not.toContain('http://');

        const record = showJson(palHome, NAME);
        expect(record.status).toBe('running');
        expect(typeof record.pid).toBe('number');
        expect(record.spawnPid).toBe(record.pid);
        expect(record.port).toBeUndefined();
        expect(record.url).toBeUndefined();
        const pid = record.pid!;
        CLEANUP.push(pid);
        expect(isPidAlive(pid)).toBe(true);

        // ps：pid 在，port/url 为空
        const ps = jsonOut<{ instances: { id: string; pid: number | null; port: number | null; url: string | null }[] }>(
          palIn(palHome, ['ps', '--json']).out,
        );
        const row = ps.instances.find((item) => item.id === record.id)!;
        expect(row).toMatchObject({ pid, port: null, url: null });

        // health：进程在 → ok，没有端口检查
        const health = jsonOut<{ ok: boolean; checks: { name: string; status: string }[] }[]>(
          palIn(palHome, ['health', NAME, '--json']).out,
        );
        expect(health[0]?.ok).toBe(true);
        expect(health[0]?.checks.some((check) => check.name === 'port')).toBe(false);

        // 已在运行：现有 already-running 逻辑，不再起第二个
        const again = palIn(palHome, ['start', NAME, '--app'], { PAL_DSH_APP_BIN: app });
        expect(again.status, again.out).toBe(1);
        expect(again.out).toContain('已在运行');

        const stopped = palIn(palHome, ['stop', NAME]);
        expect(stopped.status, stopped.out).toBe(0);
        const after = showJson(palHome, NAME);
        expect(after.status).toBe('stopped');
        expect(after.pid).toBeUndefined();
        expect(isPidAlive(pid)).toBe(false);
      } finally {
        palIn(palHome, ['stop', NAME]);
      }
    },
    120_000,
  );

  it(
    'managed dsh / 非 dsh / 与 --profile 同给：都退 2，不 spawn',
    () => {
      // managed dsh
      const managedHome = tmpDir('pal-app-cli-managed-');
      const managedBase = tmpDir('pal-app-cli-managed-base-');
      expect(palIn(managedHome, ['install', packCopy(managedBase), '--host', 'dsh']).status).toBe(0);
      const managed = palIn(managedHome, ['start', NAME, '--app']);
      expect(managed.status, managed.out).toBe(2);
      expect(managed.out).toContain('managed 的 app 启动要先确认它能用 DSH_HOME 指到实例');

      // 非 dsh
      const otherHome = tmpDir('pal-app-cli-other-');
      const otherBase = tmpDir('pal-app-cli-other-base-');
      expect(palIn(otherHome, ['install', packCopy(otherBase), '--host', 'opencode']).status).toBe(0);
      const other = palIn(otherHome, ['start', OPENCODE_NAME, '--app']);
      expect(other.status, other.out).toBe(2);
      expect(other.out).toContain('--app 只对 dsh');

      // attached dsh + --profile：互斥
      const profileHome = tmpDir('pal-app-cli-profile-');
      const profileBase = tmpDir('pal-app-cli-profile-base-');
      const attached = dshHome(profileBase, ['web', 'desktop']);
      expect(
        palIn(profileHome, ['install', packCopy(profileBase), '--host', 'dsh', '--home', attached]).status,
      ).toBe(0);
      const both = palIn(profileHome, ['start', NAME, '--app', '--profile', 'web']);
      expect(both.status, both.out).toBe(2);
      expect(both.out).toContain('--app 与 --profile 互斥');
      // 没有拿到 pid：没起进程
      expect(showJson(profileHome, NAME).pid).toBeUndefined();
    },
    120_000,
  );
});
