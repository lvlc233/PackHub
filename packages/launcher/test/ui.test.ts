import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instancesRoot } from '../src/paths.ts';
import { API_VERSION, type InstanceRecord } from '../src/records.ts';
import { writeInstance } from '../src/recordWrite.ts';
import { startUiServer, type UiInstance, type UiServer } from '../src/ui.ts';

// `pal ui --json` 那条要真起一个子进程（CLI → 监听 → 打印 → 被关掉）；慢机器上给足时间
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * `pal ui` 的服务端与页面：本地 HTTP 的读写契约、页面标题、POST 的本地闸门。
 * 测试只用端口 0（系统挑），不打开浏览器；服务实例由 `server.close` 关掉。
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'packages/launcher/src/bin.ts');
const UI_HEADERS = { 'content-type': 'application/json', 'x-pal-ui': '1' };

let tmp: string;
let ui: UiServer | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-ui-'));
  process.env.PACKHUB_HOME = join(tmp, 'home');
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
});

afterEach(async () => {
  if (ui) {
    await ui.close();
    ui = undefined;
  }
  delete process.env.PACKHUB_HOME;
  delete process.env.PACKHUB_INSTANCES;
  rmSync(tmp, { recursive: true, force: true });
});

/** 一份假记录：默认是 opencode 的 managed home（tui 前台 + web server）。 */
function record(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  const name = overrides.name ?? 'demo-ui';
  return {
    apiVersion: API_VERSION,
    id: '20260101000000-abcdef123456',
    name,
    harness: 'opencode',
    root: join(instancesRoot(), name),
    pack: { name: 'demo/pack', version: '1.0.0' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    managed: true,
    attached: false,
    status: 'installed',
    ports: [],
    ...overrides,
  };
}

async function serve(): Promise<UiServer> {
  ui = await startUiServer({ port: 0 });
  return ui;
}

async function getText(started: UiServer, path: string): Promise<{ status: number; text: string }> {
  const res = await fetch(new URL(path, started.url));
  return { status: res.status, text: await res.text() };
}

async function post(
  started: UiServer,
  path: string,
  body: unknown,
  headers: Record<string, string> = UI_HEADERS,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL(path, started.url), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('pal ui 的页面与接口', () => {
  it('GET / 返回 200 的单页 HTML，标题是中文启动器；不引外部脚本', async () => {
    const started = await serve();
    const { status, text } = await getText(started, '/');
    expect(status).toBe(200);
    expect(text).toContain('<title>PAL 启动器</title>');
    expect(text).toContain('自动刷新');
    // 单页自带 CSS/JS：没有 CDN、没有框架脚本
    expect(text).not.toMatch(/<script[^>]+src=/i);
    expect(text).not.toMatch(/href="https?:\/\//i);
  });

  it('/api/instances 在空 PAL home 下是空数组', async () => {
    const started = await serve();
    const res = await fetch(new URL('/api/instances', started.url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instances: UiInstance[] };
    expect(body.instances).toEqual([]);
  });

  it('/api/instances 给字段与模式表：id / name / harness / pack / status / attached / url / port / pid + modes', async () => {
    // status=running 且 pid 是活着的进程：视图不会把它推导成 broken（statusView 只读，不写盘）
    writeInstance(
      record({ attached: true, status: 'running', url: 'http://127.0.0.1:5555/', port: 5555, pid: process.pid }),
    );
    const started = await serve();
    const res = await fetch(new URL('/api/instances', started.url));
    const body = (await res.json()) as { instances: UiInstance[] };
    const item = body.instances[0]!;

    expect(item).toMatchObject({
      id: '20260101000000-abcdef123456',
      name: 'demo-ui',
      harness: 'opencode',
      pack: { name: 'demo/pack', version: '1.0.0' },
      status: 'running',
      attached: true,
      url: 'http://127.0.0.1:5555/',
      port: 5555,
      pid: process.pid,
    });
    expect(item.modes.map((mode) => [mode.id, mode.kind, mode.default, mode.available])).toEqual([
      ['tui', 'foreground', true, true],
      ['web', 'server', false, true],
    ]);
    // 前台模式的复制命令只给一条：与 `pal run` 等价
    expect(item.modes[0]!.command).toBe('pal run demo-ui');
    expect(item.modes[1]!.command).toBeUndefined();
  });

  it('/api/instances 按当前记录判可用性：managed dsh 的 app 模式不可用并给原因', async () => {
    writeInstance(record({ name: 'dsh-demo', harness: 'dsh' }));
    const started = await serve();
    const res = await fetch(new URL('/api/instances', started.url));
    const body = (await res.json()) as { instances: UiInstance[] };
    const modes = body.instances[0]!.modes;
    const web = modes.find((mode) => mode.id === 'web')!;
    const app = modes.find((mode) => mode.id === 'app')!;
    expect(web).toMatchObject({ kind: 'server', default: true, available: true });
    expect(app.available).toBe(false);
    expect(app.reason).toContain('managed 的 app 启动要先确认它能用 DSH_HOME 指到实例');
  });

  it('POST /api/start 前台模式：409 + 命令，不 spawn、不拉起 core', async () => {
    writeInstance(record());
    const started = await serve();

    const byMode = await post(started, '/api/start', { id: 'demo-ui', mode: 'tui' });
    expect(byMode.status).toBe(409);
    expect(byMode.body.error).toBe('前台模式需要在终端运行');
    expect(byMode.body.command).toBe('pal run demo-ui');

    // 不写 mode 就是宿主的默认模式（opencode 是 tui）：同一份回答
    const byDefault = await post(started, '/api/start', { id: 'demo-ui' });
    expect(byDefault.status).toBe(409);
    expect(byDefault.body.command).toBe('pal run demo-ui');

    // 前台模式没有写记录、也没有起 core：记录还是 installed、没有 pid
    expect(existsSync(join(process.env.PACKHUB_HOME!, 'core.json'))).toBe(false);
    const res = await fetch(new URL('/api/instances', started.url));
    const body = (await res.json()) as { instances: UiInstance[] };
    expect(body.instances[0]!.status).toBe('installed');
    expect(body.instances[0]!.pid).toBeNull();
  });

  it('未知 id：start / stop / logs 都回 404', async () => {
    const started = await serve();
    expect((await post(started, '/api/start', { id: 'nope' })).status).toBe(404);
    expect((await post(started, '/api/stop', { id: 'nope' })).status).toBe(404);
    const logs = await fetch(new URL('/api/logs?id=nope', started.url));
    expect(logs.status).toBe(404);
    expect(((await logs.json()) as { code: string }).code).toBe('unknown-instance');
  });

  it('POST 少了 x-pal-ui（或 content-type 不是 JSON）：403，什么都不做', async () => {
    writeInstance(record());
    const started = await serve();

    const noMarker = await post(started, '/api/start', { id: 'demo-ui', mode: 'tui' }, {
      'content-type': 'application/json',
    });
    expect(noMarker.status).toBe(403);
    expect(String(noMarker.body.hint)).toContain('x-pal-ui');

    const noJson = await post(started, '/api/start', { id: 'demo-ui', mode: 'tui' }, { 'x-pal-ui': '1' });
    expect(noJson.status).toBe(403);
  });

  it('/api/logs 给日志尾部与文件路径；没有日志时是 200 + 空数组', async () => {
    const rec = record();
    writeInstance(rec);
    const started = await serve();

    const empty = await fetch(new URL('/api/logs?id=demo-ui', started.url));
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { file: string; lines: string[] };
    expect(emptyBody.lines).toEqual([]);

    mkdirSync(join(rec.root, 'logs'), { recursive: true });
    writeFileSync(join(rec.root, 'logs', 'start.log'), 'line-1\nline-2\nline-3\n遮蔽测试\n', 'utf8');
    const res = await fetch(new URL('/api/logs?id=20260101000000-abcdef123456&tail=2', started.url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { file: string; lines: string[] };
    expect(body.file).toBe(join(rec.root, 'logs', 'start.log'));
    expect(body.lines).toEqual(['line-3', '遮蔽测试']);
  });

  it('POST /api/stop 对 app 记录直接收尾（pid 已死也不报错），不走 core', async () => {
    writeInstance(
      record({
        name: 'dsh-app',
        harness: 'dsh',
        attached: true,
        launchMode: 'app',
        status: 'running',
        pid: 987654,
        spawnPid: 987654,
      }),
    );
    const started = await serve();

    const res = await post(started, '/api/stop', { id: 'dsh-app' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('stopped');
    expect(existsSync(join(process.env.PACKHUB_HOME!, 'core.json'))).toBe(false);
  });
});

/* ---------- CLI：pal ui --json ---------- */

/** 等子进程输出的第一行；提前退出或没有输出都当失败（把 stderr 带进消息里）。 */
function firstLine(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    let settled = false;
    const finish = (err?: Error, line?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onErr);
      child.off('exit', onExit);
      if (err) reject(err);
      else resolve(line ?? '');
    };
    const timer = setTimeout(() => finish(new Error(`pal ui --json 没有输出（stderr：${stderr}）`)), timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index >= 0) finish(undefined, buffer.slice(0, index).trim());
    };
    const onErr = (chunk: Buffer): void => {
      stderr += chunk.toString('utf8');
    };
    const onExit = (code: number | null): void =>
      finish(new Error(`pal ui 提前退出（code ${code}，stderr：${stderr}）`));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onErr);
    child.once('exit', onExit);
  });
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
}

describe('pal ui 的命令行入口', () => {
  it('--json 打印 {url, port} 后进程可关；不打开浏览器、不碰 core', async () => {
    const home = join(tmp, 'home');
    const child = spawn(process.execPath, ['--experimental-strip-types', BIN, 'ui', '--json'], {
      cwd: ROOT,
      env: { ...process.env, PACKHUB_HOME: home, PACKHUB_INSTANCES: join(tmp, 'instances') },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      const info = JSON.parse(await firstLine(child, 60_000)) as { url: string; port: number };
      expect(info.port).toBeGreaterThan(0);
      expect(info.url).toBe(`http://127.0.0.1:${info.port}/`);
      const res = await fetch(info.url);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('PAL 启动器');
      // UI 自己不拉起 core：这一行只读记录，不涉及常驻进程
      expect(existsSync(join(home, 'core.json'))).toBe(false);
    } finally {
      await kill(child);
    }
  });
});
