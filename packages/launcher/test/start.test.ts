import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/index.ts';
import { requireInstance, writeInstance, type InstanceRecord } from '../src/index.ts';
import {
  attachSupervisor,
  hostEnv,
  HOST_ENV_KEEP,
  HOST_ENV_KEEP_AS_IS,
  isStopping,
  markStopping,
  spawnPlanFor,
  startInstance,
  startInstanceDetailed,
  stopInstance,
  stoppingMarkFile,
  statusView,
  refreshStatuses,
  trackExit,
  type SpawnFn,
} from '../src/start.ts';
import { isPalError } from '../src/errors.ts';
import { readSecrets } from '../src/secrets.ts';
import { readEvents } from '../src/logs.ts';
import { resetHarnessCache } from '../src/harness.ts';

let tmp: string;

/** 用例会往 process.env 里塞这些键（模拟 PAL 进程里的密钥/代理）：跑完恢复，别串出去。 */
const AMBIENT_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HTTPS_PROXY'] as const;
const ambientSaved = new Map<string, string | undefined>(AMBIENT_KEYS.map((key) => [key, process.env[key]]));

const MCP_PACK = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/mcp, version: 0.2.0, targets: [dsh] }
resources:
  - id: everything
    type: mcp
    source: npm:@modelcontextprotocol/server-everything@0.6.2
    transport: stdio
    config:
      command: npx
      args: ['-y', '@modelcontextprotocol/server-everything@0.6.2']
      env:
        ROOT: /srv/repo
`,
    'utf8',
  );
  return dir;
};

interface Seen {
  file?: string;
  args?: string[];
  options?: Record<string, unknown>;
}

/** 假宿主：把地址写进 PAL 交给它的日志 fd，然后假装一直在跑。 */
function fakeSpawn(seen: Seen, line: string, spawnPid = 9999): SpawnFn {
  return (file, args, options) => {
    seen.file = file;
    seen.args = args;
    seen.options = options as Record<string, unknown>;
    const stdio = options.stdio as Array<'ignore' | number> | undefined;
    const fd = Array.isArray(stdio) ? stdio[1] : undefined;
    if (typeof fd === 'number') writeSync(fd, line);
    return { pid: spawnPid, unref: () => {}, once: () => {} };
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-start-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  process.env.PACKHUB_HOME = join(tmp, 'home');
  // 用一个一定存在的命令当宿主，避开机器上装没装 dsh
  process.env.PAL_DSH_BIN = process.execPath;
  resetHarnessCache();
});

afterEach(() => {
  delete process.env.PACKHUB_INSTANCES;
  delete process.env.PACKHUB_HOME;
  delete process.env.PAL_DSH_BIN;
  for (const key of AMBIENT_KEYS) {
    const saved = ambientSaved.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  resetHarnessCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('宿主环境（纯函数）', () => {
  const HOME = join('C:\\instances', 'demo', 'home', 'dsh');

  it('保留运行必需项与代理，剔除密钥、PACKHUB_*', () => {
    const base: Record<string, string> = {
      // 保留项
      PATH: 'C:\\Windows\\system32;C:\\Program Files\\nodejs',
      PATHEXT: '.COM;.EXE;.CMD',
      SystemRoot: 'C:\\WINDOWS',
      ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe',
      TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp',
      USERPROFILE: 'C:\\Users\\me',
      // 代理是网络出口，不是凭据：照传
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      no_proxy: 'localhost',
      // 不该过去的
      OPENAI_API_KEY: 'sk-launcher',
      ANTHROPIC_API_KEY: 'sk-ant',
      DEEPSEEK_API_KEY: 'sk-ds',
      AWS_SECRET_ACCESS_KEY: 'aws',
      GITHUB_TOKEN: 'ghp_x',
      MY_SERVICE_PASSWORD: 'pw',
      PACKHUB_HOME: 'C:\\pal\\home',
      PACKHUB_INSTANCES: 'C:\\pal\\instances',
      PAL_DSH_BIN: 'C:\\pal\\dsh.exe',
      UNRELATED_THING: 'nope',
    };

    const env = hostEnv(base, { homeEnv: 'DSH_HOME' }, HOME);

    expect(env.PATH).toBe(base.PATH);
    expect(env.SystemRoot).toBe('C:\\WINDOWS');
    expect(env.ComSpec).toBe(base.ComSpec);
    expect(env.TEMP).toBe(base.TEMP);
    expect(env.USERPROFILE).toBe(base.USERPROFILE);
    expect(env.HTTPS_PROXY).toBe(base.HTTPS_PROXY);
    expect(env.no_proxy).toBe('localhost');
    // home 指到实例自己的那段，而不是 PAL 的
    expect(env.DSH_HOME).toBe(HOME);

    for (const name of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'DEEPSEEK_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'MY_SERVICE_PASSWORD',
      'PACKHUB_HOME',
      'PACKHUB_INSTANCES',
      'PAL_DSH_BIN',
      'UNRELATED_THING',
    ]) {
      expect(env[name], `${name} 不该传给宿主`).toBeUndefined();
    }
  });

  it('代理大小写都保留，同一份 base 里的密钥仍然不传', () => {
    const env = hostEnv(
      {
        HTTPS_PROXY: 'http://proxy:8080',
        https_proxy: 'http://lower:8080',
        NO_PROXY: 'localhost',
        no_proxy: '.internal',
        OPENAI_API_KEY: 'sk-launcher',
      },
      undefined,
      undefined,
    );
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080');
    expect(env.https_proxy).toBe('http://lower:8080');
    expect(env.NO_PROXY).toBe('localhost');
    expect(env.no_proxy).toBe('.internal');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('Windows 上大小写不同的 Path 也按 PATH 保留', () => {
    const env = hostEnv({ Path: 'C:\\bin' }, undefined, undefined);
    expect(env.PATH).toBe('C:\\bin');
    expect(Object.keys(env)).toEqual(['PATH']);
  });

  it('LC_* 与 LANG 保留，LOCALE 之类不猜', () => {
    const env = hostEnv({ LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', LC_CTYPE: 'UTF-8', LOCALE: 'x' }, undefined, undefined);
    expect(env.LANG).toBe('zh_CN.UTF-8');
    expect(env.LC_ALL).toBe('zh_CN.UTF-8');
    expect(env.LC_CTYPE).toBe('UTF-8');
    expect(env.LOCALE).toBeUndefined();
  });

  it('没有 home 就不写 homeEnv，不凭空造一个空路径', () => {
    const env = hostEnv({ PATH: 'C:\\bin' }, { homeEnv: 'DSH_HOME' }, undefined);
    expect(env.DSH_HOME).toBeUndefined();
    expect(env.PATH).toBe('C:\\bin');
  });

  it('extra 覆盖保留项，也能把显式给的项补回去', () => {
    const env = hostEnv({ PATH: 'C:\\bin', TERM: 'xterm-256color', HTTPS_PROXY: 'http://old:8080' }, { homeEnv: 'DSH_HOME' }, HOME, {
      TERM: 'dumb',
      PATH: 'D:\\extra',
      HTTPS_PROXY: 'http://new:8080',
      EXTRA_ONLY: 'yes',
    });
    expect(env.TERM).toBe('dumb');
    expect(env.PATH).toBe('D:\\extra');
    expect(env.HTTPS_PROXY).toBe('http://new:8080');
    expect(env.EXTRA_ONLY).toBe('yes');
    expect(env.DSH_HOME).toBe(HOME);
  });

  it('保留清单与代理清单里每个名字都真的能过去（不会被敏感规则误伤）', () => {
    for (const name of [...HOST_ENV_KEEP, ...HOST_ENV_KEEP_AS_IS]) {
      const env = hostEnv({ [name]: 'v' }, undefined, undefined);
      expect(env[name], `${name} 被敏感规则挡掉了`).toBe('v');
    }
  });
});

describe('实例启动', () => {
  it('dsh 实例的技能装进实例自己的 home', async () => {
    const rec = await createInstance({ name: 'dsh-home', harness: 'dsh', packDir: 'examples/doc-review' });
    expect(rec.home).toBe(join(rec.root, 'home', 'dsh'));
    expect(existsSync(join(rec.root, 'home', 'dsh', 'skills', 'doc-review', 'SKILL.md'))).toBe(true);
  });

  it('直接 spawn：不拼 shell、日志走 fd、地址与端口落记录、凭据进 secrets.json', async () => {
    // PAL 进程里故意放几个密钥/代理：密钥不该过去，代理要过去（否则宿主联网就坏）
    process.env.OPENAI_API_KEY = 'sk-pal-should-not-leak';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
    process.env.HTTPS_PROXY = 'http://pal-proxy:7890';
    const inst = await createInstance({ name: 'dsh-run', harness: 'dsh', packDir: 'examples/doc-review' });
    const seen: Seen = {};
    const spawn = fakeSpawn(seen, 'dsh web: http://127.0.0.1:51234/?token=abc\n');

    const result = await startInstanceDetailed('dsh-run', {
      spawn,
      timeoutMs: 3000,
      isAlive: () => false,
      ownerOf: () => 4321,
    });

    // 不是 "命令 + 参数拼成一个字符串再交给 shell"
    expect(seen.args).not.toBe(seen.file);
    expect(Array.isArray(seen.args)).toBe(true);
    expect(seen.options?.cwd).toBe(inst.root);
    const env = seen.options?.env as NodeJS.ProcessEnv;
    expect(env.DSH_HOME).toBe(inst.home);
    // 不再整份继承 process.env：PATH 这类运行必需在，密钥与 PACKHUB_* 不进去
    expect(env.PATH).toBe(process.env.PATH);
    // Windows 缺 SystemRoot 会起不来，这条对真实 process.env 也要成立
    if (process.platform === 'win32') expect(env.SystemRoot).toBeTruthy();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PACKHUB_HOME).toBeUndefined();
    // 代理按原名带过去（Windows 上大小写可能不同于这里写的）
    const proxy = Object.entries(env).find(([name]) => name.toUpperCase() === 'HTTPS_PROXY');
    expect(proxy?.[1]).toBe('http://pal-proxy:7890');
    expect(Array.isArray(seen.options?.stdio)).toBe(true);
    expect(typeof (seen.options?.stdio as unknown[])[1]).toBe('number');

    const record = result.record;
    expect(record.status).toBe('running');
    // pid 记的是真正在监听的那个，不是垫片进程
    expect(record.pid).toBe(4321);
    expect(record.port).toBe(51234);
    expect(record.ports).toEqual([51234]);
    // 记录与 API 里都不出现 token
    expect(record.url).toBe('http://127.0.0.1:51234/');
    expect(readFileSync(join(record.root, 'instance.json'), 'utf8')).not.toContain('abc');
    expect(readSecrets(record.root)).toEqual({ token: 'abc' });

    const stopped = await stopInstance('dsh-run', { kill: () => {}, isAlive: () => false });
    expect(stopped.status).toBe('stopped');
    expect(stopped.pid).toBeUndefined();
    expect(stopped.url).toBeUndefined();
    expect(readSecrets(record.root)).toEqual({});
  });

  it('调用方显式给的 env 会到宿主，仍不含 PAL 的密钥', async () => {
    process.env.OPENAI_API_KEY = 'sk-pal-should-not-leak';
    await createInstance({ name: 'dsh-extra-env', harness: 'dsh', packDir: 'examples/doc-review' });
    const seen: Seen = {};

    await startInstanceDetailed('dsh-extra-env', {
      spawn: fakeSpawn(seen, 'dsh web: http://127.0.0.1:51241/\n'),
      timeoutMs: 3000,
      isAlive: () => false,
      ownerOf: () => 4323,
      env: { CUSTOM_FLAG: 'on', HTTPS_PROXY: 'http://proxy:8080' },
    });

    const env = seen.options?.env as NodeJS.ProcessEnv;
    expect(env.CUSTOM_FLAG).toBe('on');
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('dsh 的 MCP 资源写成 --patch 层，参数在启动前就带上', async () => {
    const inst = await createInstance({ name: 'with-mcp', harness: 'dsh', packDir: MCP_PACK(join(tmp, 'mcp-pack')) });
    const seen: Seen = {};
    const spawn = fakeSpawn(seen, 'listening on http://127.0.0.1:51235/\n');

    await startInstanceDetailed('with-mcp', {
      spawn,
      timeoutMs: 3000,
      isAlive: () => false,
      ownerOf: () => 4322,
    });

    const patch = join(inst.home!, 'pal-mcp.patch.yml');
    expect(existsSync(patch)).toBe(true);
    const text = readFileSync(patch, 'utf8');
    expect(text).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(text).toContain('serverName: "everything"');
    expect(text).toContain('command: "npx"');
    expect(text).toContain('ROOT: "/srv/repo"');
    expect(seen.args).toContain('--patch');
    expect(seen.args?.[seen.args.indexOf('--patch') + 1]).toBe(patch);
    // --patch 必须排在 web 子命令的参数之前
    expect(seen.args!.indexOf('--patch')).toBeLessThan(seen.args!.indexOf('--no-open'));
  });

  it('已经在跑就不再起第二个', async () => {
    const rec = await createInstance({ name: 'twice', harness: 'dsh', packDir: 'examples/doc-review' });
    const seen: Seen = {};
    await startInstance('twice', {
      spawn: fakeSpawn(seen, 'http://127.0.0.1:51236/\n'),
      timeoutMs: 3000,
      isAlive: () => false,
      ownerOf: () => 555,
    });
    expect(requireInstance('twice').pid).toBe(555);

    let caught: unknown;
    try {
      await startInstance(rec.id, { spawn: fakeSpawn(seen, ''), isAlive: () => true });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('already-running');
  });

  it('没有常驻服务的宿主直接给能力说明，不是让它起不来', async () => {
    const rec = await createInstance({
      name: 'claude-home',
      harness: 'claude-code',
      packDir: (() => {
        const dir = join(tmp, 'cc-pack');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'packhub.yaml'),
          `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/cc, version: 0.1.0, targets: [claude-code] }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`,
          'utf8',
        );
        writeFileSync(join(dir, 'rules.md'), '# r\n', 'utf8');
        return dir;
      })(),
    });
    let caught: unknown;
    try {
      await startInstance(rec.id, { spawn: fakeSpawn({}, ''), isAlive: () => false });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('not-startable');
    expect((caught as Error).message).toContain('Claude Code');
  });

  it('等不到地址时把日志尾部贴进错误，并把实例标成异常', async () => {
    const inst = await createInstance({ name: 'slow', harness: 'dsh', packDir: 'examples/doc-review' });
    const spawn = fakeSpawn({}, 'booting the harness...\n');
    let caught: unknown;
    try {
      await startInstance('slow', { spawn, timeoutMs: 250, isAlive: () => false, pollMs: 20 });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('start-failed');
    expect((caught as { hint?: string }).hint).toContain('booting the harness');
    const after = requireInstance(inst.id);
    expect(after.status).toBe('broken');
    expect(after.lastError?.code).toBe('start-failed');
  });

  it('日志超过 1MB、地址在末尾：仍能等到地址（只读尾部窗口）', async () => {
    const inst = await createInstance({ name: 'big-log', harness: 'dsh', packDir: 'examples/doc-review' });
    const noiseLine = `boot: warmup ${'x'.repeat(96)}\n`;
    const noise = noiseLine.repeat(Math.ceil((1.2 * 1024 * 1024) / noiseLine.length));
    const spawn = fakeSpawn({}, `${noise}dsh web: http://127.0.0.1:51290/?token=tail\n`);

    const result = await startInstanceDetailed('big-log', {
      spawn,
      timeoutMs: 3000,
      isAlive: () => false,
      ownerOf: () => 4601,
    });

    expect(result.record.status).toBe('running');
    expect(result.record.port).toBe(51290);
    expect(result.record.url).toBe('http://127.0.0.1:51290/');
    // 确认日志确实超过窗口，否则这条用例证明不了「读尾部也能等到」
    expect(statSync(join(inst.root, 'logs', 'start.log')).size).toBeGreaterThan(1024 * 1024);
  });

  it('地址在尾部窗口之外（很早的输出里）：不会因为读全文件而提前就绪', async () => {
    const inst = await createInstance({ name: 'early-url', harness: 'dsh', packDir: 'examples/doc-review' });
    const noiseLine = `boot: warmup ${'x'.repeat(96)}\n`;
    // 512KB 噪声是尾部窗口（128KB）的 4 倍：只读尾部就看不到第 1 行的地址
    const noise = noiseLine.repeat(Math.ceil((512 * 1024) / noiseLine.length));
    const spawn = fakeSpawn({}, `dsh web: http://127.0.0.1:51291/\n${noise}`);

    let caught: unknown;
    try {
      await startInstance('early-url', { spawn, timeoutMs: 250, pollMs: 20, isAlive: () => false });
    } catch (err) {
      caught = err;
    }
    // 读全文件会命中第 1 行的地址；只读尾部窗口则超时——这是「不整份读」的确定性证明
    expect(isPalError(caught) && caught.code).toBe('start-failed');
    expect((caught as { hint?: string }).hint).toContain('boot: warmup');
    expect(requireInstance(inst.id).status).toBe('broken');
  });

  it('进程已经不在的记录会被刷新成异常，不会一直显示在跑', async () => {
    const rec = await createInstance({ name: 'stale', harness: 'dsh', packDir: 'examples/doc-review' });
    writeFileSync(
      join(rec.root, 'instance.json'),
      JSON.stringify({ ...requireInstance(rec.id), status: 'running', pid: 777777, port: 1 }, null, 2),
      'utf8',
    );
    const rows = refreshStatuses(() => false);
    expect(rows.find((row) => row.id === rec.id)?.status).toBe('broken');
    expect(rows.find((row) => row.id === rec.id)?.pid).toBeUndefined();
  });

  it('linux/win 的垫片都认得：.cmd 走 cmd，普通可执行文件直起', () => {
    const direct = spawnPlanFor('/usr/local/bin/dsh', ['--profile', 'web']);
    expect(direct.file).toBe('/usr/local/bin/dsh');
    expect(direct.args).toEqual(['--profile', 'web']);
    expect(direct.verbatim).toBe(false);

    const shim = spawnPlanFor('C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd', ['--profile', 'web', '--port', '5123']);
    expect(shim.verbatim).toBe(true);
    expect(shim.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(shim.args[3]).toContain('--port');
  });
});

describe('状态视图（stale 只读不写）', () => {
  /** 把记录改成「说在跑」的现场：pid 给了就带上端口/url，没给就是 pid 缺席。 */
  async function runningRecord(name: string, pid?: number): Promise<{ id: string; file: string }> {
    const rec = await createInstance({ name, harness: 'dsh', packDir: 'examples/doc-review' });
    const file = join(rec.root, 'instance.json');
    const runtime = pid === undefined ? {} : { pid, port: 5123, url: 'http://127.0.0.1:5123/' };
    writeFileSync(
      file,
      JSON.stringify({ ...requireInstance(rec.id), status: 'running', ...runtime }, null, 2),
      'utf8',
    );
    return { id: rec.id, file };
  }

  it('running + pid 已死：视图给 broken + stale，记录文件内容与 mtime 不变', async () => {
    const { id, file } = await runningRecord('view-dead', 777777);
    const before = readFileSync(file, 'utf8');
    const mtimeBefore = statSync(file).mtimeMs;

    const view = statusView([requireInstance(id)], () => false)[0]!;

    expect(view.status).toBe('broken');
    expect(view.stale).toBe(true);
    expect(view.pid).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(statSync(file).mtimeMs).toBe(mtimeBefore);
  });

  it('running + pid 还活着：原 status、原 pid，不带 stale', async () => {
    const { id } = await runningRecord('view-alive', 4321);

    const view = statusView([requireInstance(id)], () => true)[0]!;

    expect(view.status).toBe('running');
    expect(view.pid).toBe(4321);
    expect('stale' in view).toBe(false);
  });

  it('running + pid 缺席：也按 stale 视图给 broken', async () => {
    const { id } = await runningRecord('view-nopid');

    const view = statusView([requireInstance(id)], () => true)[0]!;

    expect(view.status).toBe('broken');
    expect(view.stale).toBe(true);
    expect(view.pid).toBeUndefined();
  });

  it('refreshStatuses 落盘：status 写 broken，记录里没有 stale 字段', async () => {
    const { id, file } = await runningRecord('view-refresh', 777777);

    const rows = refreshStatuses(() => false);

    expect(rows.find((row) => row.id === id)?.status).toBe('broken');
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(persisted.status).toBe('broken');
    expect('stale' in persisted).toBe(false);
  });
});

describe('退出跟踪（事件驱动）', () => {
  /** 假子进程：exit 由用例手动触发，用来观察 wait 是在等事件还是轮询。 */
  function fakeChild(): {
    child: ReturnType<SpawnFn>;
    fire: (code: number | null, signal?: NodeJS.Signals | null) => void;
  } {
    let handler: ((...args: never[]) => void) | undefined;
    const child = {
      pid: 4321,
      unref: () => {},
      once: (event: string, cb: (...args: never[]) => void) => {
        if (event === 'exit') handler = cb;
      },
    };
    return {
      child,
      fire: (code, signal = null) => {
        const cb = handler as unknown as (c: number | null, s: NodeJS.Signals | null) => void;
        cb?.(code, signal);
      },
    };
  }

  it('还没退出时 wait(小超时) 返回 undefined，不编造退出信息', async () => {
    const { child } = fakeChild();
    const tracker = trackExit(child);
    const started = Date.now();
    await expect(tracker.wait(40)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(tracker.peek()).toBeUndefined();
  });

  it('exit 后 wait 立即返回，code/signal 正确（不等满 60s 超时）', async () => {
    const { child, fire } = fakeChild();
    const tracker = trackExit(child);
    const started = Date.now();
    const waiting = tracker.wait(60_000);
    fire(3, 'SIGKILL');
    const info = await waiting;
    expect(info?.code).toBe(3);
    expect(info?.signal).toBe('SIGKILL');
    expect(Number.isNaN(Date.parse(info!.at))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(tracker.peek()).toEqual(info);
  });

  it('已经退出过的 wait 也直接给信息，不建 timer 空等', async () => {
    const { child, fire } = fakeChild();
    const tracker = trackExit(child);
    fire(0, null);
    expect(tracker.peek()?.code).toBe(0);
    const started = Date.now();
    const info = await tracker.wait(60_000);
    expect(info?.code).toBe(0);
    expect(info?.signal).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('退出时清掉超时 timer，不留下 24h 的悬挂定时器', async () => {
    vi.useFakeTimers();
    try {
      const { child, fire } = fakeChild();
      const tracker = trackExit(child);
      const waiting = tracker.wait(24 * 60 * 60 * 1000);
      expect(vi.getTimerCount()).toBe(1);
      fire(0, null);
      const info = await waiting;
      expect(info?.code).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('主动停止与看护', () => {
  type ExitLike = { code: number | null; signal: NodeJS.Signals | null; at: string };

  /** 造一条「正在跑、restart=on-failure」的记录；进程死活由 opts.isAlive 控制。 */
  function runningRecord(base: InstanceRecord, pid: number, port: number): InstanceRecord {
    return {
      ...base,
      status: 'running',
      pid,
      port,
      url: `http://127.0.0.1:${port}/`,
      restart: 'on-failure',
      maxRestarts: 3,
    };
  }

  /** 真让重起跑起来会拉起真进程：把宿主指到不存在的路径，重起只会立刻失败。 */
  function blockRealRestart(): void {
    process.env.PAL_DSH_BIN = join(tmp, 'no-such-dsh');
    resetHarnessCache();
  }

  it('stop 主动结束的退出不会被看护标成 broken，也不会重起', async () => {
    const created = await createInstance({ name: 'supervised', harness: 'dsh', packDir: 'examples/doc-review' });
    const running = runningRecord(requireInstance(created.id), 24680, 51237);
    writeInstance(running);
    blockRealRestart();

    // 看护在 kill 之后立刻拿到退出信息：onExit 与 stop 抢着收尾
    let exit: ExitLike | undefined;
    let wake: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      wake = resolve;
    });
    attachSupervisor(running, {
      peek: () => undefined,
      wait: async () => {
        await exited;
        return exit;
      },
    });

    let polls = 0;
    const stopped = await stopInstance(created.id, {
      kill: () => {
        // 标记必须先于 kill 落盘：另一个进程里的看护只能靠磁盘上的它认出主动停止
        expect(existsSync(stoppingMarkFile(created.root))).toBe(true);
        exit = { code: null, signal: 'SIGTERM', at: new Date().toISOString() };
        wake();
      },
      // 前几次还「活着」：让 onExit 在 stop 还在等退出时就跑完
      isAlive: () => {
        polls += 1;
        return polls <= 3;
      },
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(stopped.status).toBe('stopped');
    expect(stopped.pid).toBeUndefined();
    expect(stopped.url).toBeUndefined();
    const after = requireInstance(created.id);
    expect(after.status).toBe('stopped');
    // 崩溃路径会写 lastExit：没有它就说明没被当成崩溃
    expect(after.lastExit).toBeUndefined();
    expect(existsSync(stoppingMarkFile(created.root))).toBe(false);

    const events = readEvents(created.root, 50);
    expect(events.filter((event) => event.event === 'exit-stopped')).toHaveLength(1);
    expect(events.some((event) => event.event === 'exit')).toBe(false);
    expect(events.some((event) => event.event === 'start')).toBe(false);
  });

  it('标记还在时 onExit 不标 broken、不重起', async () => {
    const created = await createInstance({ name: 'marked', harness: 'dsh', packDir: 'examples/doc-review' });
    const running = runningRecord(requireInstance(created.id), 13579, 51238);
    writeInstance(running);
    blockRealRestart();

    // 标记是磁盘上的：pid + 时间，另一个进程（serve）也读得到
    markStopping(created.root, 13579);
    const mark = JSON.parse(readFileSync(stoppingMarkFile(created.root), 'utf8')) as { pid: number; at: string };
    expect(mark.pid).toBe(13579);
    expect(Number.isNaN(Date.parse(mark.at))).toBe(false);

    attachSupervisor(running, {
      peek: () => ({ code: null, signal: 'SIGTERM', at: new Date().toISOString() }),
      wait: async () => ({ code: null, signal: 'SIGTERM', at: new Date().toISOString() }),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const after = requireInstance(created.id);
    expect(after.status).toBe('running');
    expect(after.pid).toBe(13579);
    expect(after.lastExit).toBeUndefined();
    const events = readEvents(created.root, 50);
    expect(events.filter((event) => event.event === 'exit-stopped')).toHaveLength(1);
    expect(events.some((event) => event.event === 'exit' || event.event === 'start')).toBe(false);
  });

  it('onExit 晚到（标记已清、记录已 stopped）也不写回 broken', async () => {
    const created = await createInstance({ name: 'late-exit', harness: 'dsh', packDir: 'examples/doc-review' });
    const running = runningRecord(requireInstance(created.id), 55555, 51240);
    writeInstance(running);
    blockRealRestart();

    let wake: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      wake = resolve;
    });
    attachSupervisor(running, {
      peek: () => undefined,
      wait: async () => {
        await exited;
        return { code: null, signal: 'SIGTERM' as const, at: new Date().toISOString() };
      },
    });

    const stopped = await stopInstance(created.id, { kill: () => {}, isAlive: () => false });
    expect(stopped.status).toBe('stopped');
    // stop 收完尾（标记已清）之后看护才拿到退出：靠记录状态认出这不是崩溃
    wake();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const after = requireInstance(created.id);
    expect(after.status).toBe('stopped');
    expect(after.lastExit).toBeUndefined();
    const events = readEvents(created.root, 50);
    expect(events.some((event) => event.event === 'exit' || event.event === 'start')).toBe(false);
  });

  it('停不掉时也要清掉标记，不留下永久抑制', async () => {
    const created = await createInstance({ name: 'stuck', harness: 'dsh', packDir: 'examples/doc-review' });
    writeInstance(runningRecord(requireInstance(created.id), 11111, 51239));

    let caught: unknown;
    try {
      await stopInstance(created.id, {
        kill: () => {
          expect(existsSync(stoppingMarkFile(created.root))).toBe(true);
        },
        isAlive: () => true,
        timeoutMs: 150,
      });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('busy');
    expect(existsSync(stoppingMarkFile(created.root))).toBe(false);
    expect(isStopping(created.root, 11111)).toBe(false);
    const after = requireInstance(created.id);
    expect(after.status).toBe('running');
    expect(after.pid).toBe(11111);
  });
});
