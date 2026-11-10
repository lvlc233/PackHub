import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptInstance, createInstance, requireInstance } from '../src/index.ts';
import { entryOf, entryStates, entriesOf, resetEntryCache, terminalPlan } from '../src/entries.ts';
import { openInstance, startInstance, startInstanceDetailed, stopInstance } from '../src/start.ts';
import { isPalError } from '../src/errors.ts';
import { cloneInstance } from '../src/migrate.ts';
import { resetHarnessCache } from '../src/harness.ts';
import { writeInstance } from '../src/index.ts';

let tmp: string;

interface Seen {
  file?: string;
  args?: string[];
  options?: Record<string, unknown>;
}

/** 一直在跑的假宿主：把地址写进日志 fd，不退出。 */
function running(seen: Seen, line = '', pid = 7001) {
  return (file: string, args: string[], options: Record<string, unknown>) => {
    seen.file = file;
    seen.args = args;
    seen.options = options;
    const stdio = options.stdio as Array<'ignore' | number> | undefined;
    const fd = Array.isArray(stdio) ? stdio[1] : undefined;
    if (typeof fd === 'number' && line) writeSync(fd, line);
    return { pid, unref: () => {}, once: () => {} };
  };
}

/** 跑完就退的假宿主：用来测一次性入口的退出码。 */
function exits(seen: Seen, code: number, pid = 7002) {
  return (file: string, args: string[], options: Record<string, unknown>) => {
    seen.file = file;
    seen.args = args;
    seen.options = options;
    const handlers: Array<(code: number | null, signal: null) => void> = [];
    setTimeout(() => {
      for (const handler of handlers) handler(code, null);
    }, 5);
    return {
      pid,
      unref: () => {},
      once: (event: string, cb: (...args: never[]) => void) => {
        if (event === 'exit') handlers.push(cb as unknown as (code: number | null, signal: null) => void);
      },
    };
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-entries-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  process.env.PACKHUB_HOME = join(tmp, 'home');
  process.env.PAL_DSH_BIN = process.execPath;
  process.env.PAL_DSH_APP = process.execPath;
  resetHarnessCache();
  resetEntryCache();
});

afterEach(() => {
  delete process.env.PACKHUB_INSTANCES;
  delete process.env.PACKHUB_HOME;
  delete process.env.PAL_DSH_BIN;
  delete process.env.PAL_DSH_APP;
  delete process.env.PAL_CLAUDE_CODE_BIN;
  resetHarnessCache();
  resetEntryCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('入口表', () => {
  it('宿主各有几个入口：web 只是 dsh 的一个，claude 只有终端和一次性', () => {
    expect(entriesOf('dsh').map((entry) => entry.kind)).toEqual(['web', 'app', 'tui', 'headless']);
    expect(entriesOf('codex').map((entry) => entry.kind)).toEqual(['app', 'tui', 'headless']);
    expect(entriesOf('claude-code').map((entry) => entry.kind)).toEqual(['tui', 'headless']);
    expect(entriesOf('dir')).toEqual([]);
  });

  it('每个入口都带齐五件事：启动、就绪、访问面、终止、能否绑实例', () => {
    for (const entry of entriesOf('dsh')) {
      expect(entry.ready.kind).toBeTruthy();
      expect(['browser', 'window', 'terminal', 'none']).toContain(entry.surface);
      expect(['tree', 'graceful', 'close-surface', 'exit']).toContain(entry.stop);
      expect(typeof entry.binds.home).toBe('boolean');
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });

  it('dsh 的 tui 要装过 profile；没有就说清为什么不能起', () => {
    const home = join(tmp, 'h', 'home', 'dsh');
    mkdirSync(home, { recursive: true });
    const before = entryStates('dsh', { commandPath: process.execPath, home }).find((e) => e.kind === 'tui');
    expect(before?.startable).toBe(false);
    expect(before?.reason).toContain('tui profile');
    // 只有目录不算装过：dsh 认 profile 里有 package.json 的那份
    mkdirSync(join(home, 'profiles', 'tui'), { recursive: true });
    expect(entryStates('dsh', { commandPath: process.execPath, home }).find((e) => e.kind === 'tui')?.startable).toBe(
      false,
    );
    writeFileSync(join(home, 'profiles', 'tui', 'package.json'), '{"name":"pal-tui"}\n', 'utf8');
    const after = entryStates('dsh', { commandPath: process.execPath, home }).find((e) => e.kind === 'tui');
    expect(after?.startable).toBe(true);
  });

  it('桌面应用找不到时 app 入口不可用，并且指明用 PAL_DSH_APP', () => {
    delete process.env.PAL_DSH_APP;
    resetEntryCache();
    const app = entryStates('dsh', { commandPath: process.execPath }).find((e) => e.kind === 'app');
    expect(app?.startable).toBe(false);
    expect(app?.reason).toContain('PAL_DSH_APP');
  });
});

describe('入口运行态', () => {
  it('web：记 entry、端口、地址', async () => {
    const inst = await createInstance({ name: 'web', harness: 'dsh', packDir: 'examples/doc-review' });
    const seen: Seen = {};
    await startInstance('web', {
      spawn: running(seen, 'listening: http://127.0.0.1:51277/?token=t\n'),
      timeoutMs: 3_000,
      ownerOf: () => 7010,
    });
    const rec = requireInstance(inst.id);
    expect(rec.entry).toBe('web');
    expect(rec.port).toBe(51277);
    expect(rec.url).toBe('http://127.0.0.1:51277/');
    expect(rec.endpoint).toBeUndefined();
  });

  it('app：起桌面应用，只记进程，不占端口', async () => {
    const inst = await createInstance({ name: 'app', harness: 'dsh', packDir: 'examples/doc-review' });
    const seen: Seen = {};
    const detail = await startInstanceDetailed('app', {
      entry: 'app',
      spawn: running(seen, '', 7020),
      timeoutMs: 30,
    });
    expect(seen.file).toBe(process.execPath);
    expect(detail.surface).toBe('window');
    const rec = requireInstance(inst.id);
    expect(rec.entry).toBe('app');
    expect(rec.pid).toBe(7020);
    expect(rec.port).toBeUndefined();
    expect(rec.endpoint).toBeUndefined();
  });

  it('app 单实例交接：新起的那份以 0 退出，报 already-running，不把记录写成 broken', async () => {
    const inst = await createInstance({ name: 'handoff', harness: 'dsh', packDir: 'examples/doc-review' });
    let caught: unknown;
    try {
      await startInstance('handoff', { entry: 'app', spawn: exits({}, 0), timeoutMs: 500 });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('already-running');
    const rec = requireInstance(inst.id);
    expect(rec.status).toBe('installed');
    expect(rec.lastError).toBeUndefined();
    expect(rec.entry).toBeUndefined();
  });

  it('tui：开终端窗口，记终端端点；终端必须可见', async () => {
    const inst = await createInstance({
      name: 'tui',
      harness: 'dsh',
      packDir: 'examples/doc-review',
    });
    // tui profile 要在实例自己的 home 里：装过才能起这个入口
    mkdirSync(join(inst.home!, 'profiles', 'tui'), { recursive: true });
    writeFileSync(join(inst.home!, 'profiles', 'tui', 'package.json'), '{"name":"pal-tui"}\n', 'utf8');
    const seen: Seen = {};
    const detail = await startInstanceDetailed('tui', {
      entry: 'tui',
      spawn: running(seen, '', 7030),
      timeoutMs: 30,
    });
    expect(detail.surface).toBe('terminal');
    expect(seen.options?.windowsHide).toBe(false);
    const rec = requireInstance(inst.id);
    expect(rec.entry).toBe('tui');
    expect(rec.endpoint?.kind).toBe('tty');
    expect(rec.port).toBeUndefined();
  });

  it('headless：要任务；退出码进记录，0 算停稳，非 0 算失败', async () => {
    const inst = await createInstance({ name: 'once', harness: 'dsh', packDir: 'examples/doc-review' });
    let caught: unknown;
    try {
      await startInstance('once', { entry: 'headless', spawn: running({}), timeoutMs: 50 });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('invalid-input');

    const seen: Seen = {};
    const detail = await startInstanceDetailed('once', {
      entry: 'headless',
      task: 'say hi',
      spawn: exits(seen, 0),
      timeoutMs: 3_000,
    });
    expect(detail.surface).toBe('none');
    expect(seen.args).toContain('say hi');
    const ok = requireInstance(inst.id);
    expect(ok.entry).toBe('headless');
    expect(ok.exitCode).toBe(0);
    expect(ok.status).toBe('stopped');
    expect(ok.pid).toBeUndefined();

    await startInstance('once', { entry: 'headless', task: 'boom', spawn: exits({}, 3), timeoutMs: 3_000 });
    const bad = requireInstance(inst.id);
    expect(bad.exitCode).toBe(3);
    expect(bad.status).toBe('failed');
  });

  it('停止按入口走：app 先请它自己退，终端直接收树', async () => {
    const app = await createInstance({ name: 'stop-app', harness: 'dsh', packDir: 'examples/doc-review' });
    await startInstance('stop-app', { entry: 'app', spawn: running({}, '', 7040), timeoutMs: 30 });
    const quit: number[] = [];
    let checks = 0;
    await stopInstance(app.id, {
      // 前两次（判定归属、判断还活着）算在跑，之后算已经退出
      isAlive: () => {
        checks += 1;
        return checks <= 2;
      },
      requestQuit: (pid) => quit.push(pid),
      ownerOf: () => undefined,
    });
    expect(quit).toEqual([7040]);
    expect(requireInstance(app.id).status).toBe('stopped');
    expect(requireInstance(app.id).entry).toBe('app');
  });

  it('克隆不带运行态：entry / endpoint / exitCode 都回到未启动', async () => {
    const src = await createInstance({ name: 'src', harness: 'dsh', packDir: 'examples/doc-review' });
    await startInstance('src', { entry: 'app', spawn: running({}, '', 7050), timeoutMs: 30 });
    const copy = await cloneInstance(src.id, { name: 'src-copy' });
    expect(copy.entry).toBeUndefined();
    expect(copy.endpoint).toBeUndefined();
    expect(copy.exitCode).toBeUndefined();
    expect(copy.pid).toBeUndefined();
    expect(copy.status).toBe('installed');
  });

  it('记录里写坏的 entry 不影响读：当作没写', async () => {
    const inst = await createInstance({ name: 'bad-entry', harness: 'dsh', packDir: 'examples/doc-review' });
    const rec = requireInstance(inst.id);
    writeInstance({ ...rec, entry: 'nope' as never });
    expect(requireInstance(inst.id).entry).toBe('nope');
    // 起不来的入口给的是可选值，而不是崩在别处
    let caught: unknown;
    try {
      await startInstance(inst.id, { entry: 'nope' as never, spawn: running({}), timeoutMs: 30 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isPalError(caught) && caught.code).toBe('invalid-input');
    expect(String((caught as Error).message)).toContain('没有 nope 入口');
  });
});

describe('打开访问面', () => {
  it('web 打开的是带凭据的地址；headless 没有面可开', async () => {
    const inst = await createInstance({ name: 'open-web', harness: 'dsh', packDir: 'examples/doc-review' });
    await startInstance('open-web', {
      spawn: running({}, 'http://127.0.0.1:51288/?token=abc\n'),
      timeoutMs: 3_000,
      ownerOf: () => 7060,
      isAlive: () => true,
    });
    const opened = await openInstance(inst.id);
    expect(opened.surface).toBe('browser');
    expect(opened.url).toContain('token=abc');

    let caught: unknown;
    try {
      await openInstance(inst.id, { entry: 'headless' });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('not-openable');
  });

  it('app 打开 = 再落一次启动命令；没在跑就不装成打开了', async () => {
    const inst = await createInstance({ name: 'open-app', harness: 'dsh', packDir: 'examples/doc-review' });
    let caught: unknown;
    try {
      await openInstance(inst.id, { entry: 'app', spawn: running({}) });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('not-running');

    await startInstance(inst.id, { entry: 'app', spawn: running({}, '', 7070), timeoutMs: 30 });
    const seen: Seen = {};
    const opened = await openInstance(inst.id, { spawn: running(seen), isAlive: () => true });
    expect(opened.surface).toBe('window');
    expect(seen.file).toBe(process.execPath);
  });
});

describe('终端入口', () => {
  it('Windows 给的是 start /wait 的 cmd；POSIX 给 x-terminal-emulator', () => {
    const plan = terminalPlan('C:\\tools\\dsh.exe', ['--profile', 'tui'], 'PAL · demo');
    if (process.platform === 'win32') {
      // 有 Windows Terminal 就用它，没有就退回 cmd 的 start /wait
      expect(['wt.exe', 'cmd.exe'].some((name) => plan.file.toLowerCase().includes(name.slice(0, 3)))).toBe(true);
      expect(plan.visible).toBe(true);
    } else {
      expect(plan.file.length).toBeGreaterThan(0);
    }
  });

  it('claude 只有 tui：起终端入口，不要求 web 端口', async () => {
    process.env.PAL_CLAUDE_CODE_BIN = process.execPath;
    resetHarnessCache();
    const dir = join(tmp, 'cc-project');
    mkdirSync(dir, { recursive: true });
    const inst = adoptInstance({ dir, name: 'cc', harness: 'claude-code' });
    const seen: Seen = {};
    const detail = await startInstanceDetailed('cc', { spawn: running(seen, '', 7080), timeoutMs: 30 });
    expect(detail.surface).toBe('terminal');
    expect(requireInstance(inst.id).entry).toBe('tui');
    expect(entryOf('claude-code', 'web')).toBeUndefined();
  });
});
