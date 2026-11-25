import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instancesRoot } from '../src/paths.ts';
import { API_VERSION, type InstanceRecord } from '../src/records.ts';
import { writeInstance } from '../src/recordWrite.ts';
import {
  startUiServer,
  type UiHealthResponse,
  type UiHost,
  type UiInstance,
  type UiPlanResponse,
  type UiServer,
  type UiServerOptions,
} from '../src/ui.ts';
import {
  runPalCommand,
  type PalRunResult,
  type PalRunner,
  type TerminalRequest,
} from '../src/uiSpawn.ts';


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

/** 带注入桩起服务：子进程与终端窗口都不碰真进程。 */
async function serveWith(options: Pick<UiServerOptions, 'runPal' | 'openTerminal'>): Promise<UiServer> {
  ui = await startUiServer({ port: 0, ...options });
  return ui;
}

/** 子进程桩：记下每次的 argv 与选项，按给定结果（或函数）回答。 */
function stubPal(result: PalRunResult | ((args: string[]) => PalRunResult)): {
  runner: PalRunner;
  calls: string[][];
  options: Array<{ cwd?: string; timeoutMs?: number } | undefined>;
} {
  const calls: string[][] = [];
  const options: Array<{ cwd?: string; timeoutMs?: number } | undefined> = [];
  const runner: PalRunner = (args, opts) => {
    calls.push(args);
    options.push(opts);
    return Promise.resolve(typeof result === 'function' ? result(args) : result);
  };
  return { runner, calls, options };
}

/** 真 spawn：用 bin.ts + strip-types 起子进程（与 `pal ui` 进程里同一条路）。 */
const REAL_PAL: PalRunner = (args, options) =>
  runPalCommand(args, options, {
    execPath: process.execPath,
    execArgv: ['--experimental-strip-types'],
    entry: BIN,
  });

/** 一份最小 Pack：只放一个 knowledge 资源，够 `pal install --dry-run` 出计划。 */
function writePack(dir: string, name = 'ui/demo-pack'): string {
  mkdirSync(join(dir, 'resources'), { recursive: true });
  writeFileSync(
    join(dir, 'packhub.yaml'),
    [
      'apiVersion: packhub.dev/v0',
      'kind: Pack',
      'metadata:',
      `  name: ${name}`,
      '  version: 0.0.1',
      '  title: UI 测试包',
      'resources:',
      '  - id: readme',
      '    type: knowledge',
      '    source: ./resources/readme.md',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(dir, 'resources', 'readme.md'), '# ui\n', 'utf8');
  return dir;
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

    // 新增的 POST 也走同一道闸门
    const plan = await post(started, '/api/plan', { source: 'some-pack', host: 'dsh' }, {
      'content-type': 'application/json',
    });
    expect(plan.status).toBe(403);
    const action = await post(started, '/api/home-action', { action: 'verify', id: 'demo-ui' }, { 'x-pal-ui': '1' });
    expect(action.status).toBe(403);
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

/* ---------- 启动器 v2：宿主表 / 安装 / 管理 / 体检 / 终端 ---------- */

describe('pal ui 的启动器 v2 接口', () => {
  it('GET /api/hosts 列出注册表里的六个宿主，dsh / opencode 的模式对都在', async () => {
    const started = await serve();
    const res = await fetch(new URL('/api/hosts', started.url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: UiHost[] };
    expect(body.hosts.map((host) => host.id)).toEqual([
      'dsh',
      'claude-code',
      'codex',
      'opencode',
      'workbody',
      'hermes',
    ]);
    const dsh = body.hosts.find((host) => host.id === 'dsh')!;
    expect(dsh.modes.map((mode) => [mode.id, mode.kind, mode.default])).toEqual([
      ['web', 'server', true],
      ['app', 'app', false],
    ]);
    expect(dsh.attached).toBe(true);
    expect(dsh.project).toBe('pointer');
    const opencode = body.hosts.find((host) => host.id === 'opencode')!;
    expect(opencode.modes.map((mode) => [mode.id, mode.kind, mode.default])).toEqual([
      ['tui', 'foreground', true],
      ['web', 'server', false],
    ]);
    expect(opencode.attached).toBe(true);
    expect(opencode.project).toBe('full');
  });

  it('GET / 的页面是 harness-first：侧栏 harness 列表 + 添加整合包弹层', async () => {
    const started = await serve();
    const { status, text } = await getText(started, '/');
    expect(status).toBe(200);
    expect(text).toContain('id="harness-list"');
    expect(text).toContain('添加整合包');
    expect(text).toContain('id="install-modal"');
    expect(text).toContain('id="source"');
    expect(text).toContain('id="preview"');
    expect(text).toContain('id="install"');
    expect(text).toContain('自动刷新');
  });

  it('POST /api/plan 缺参 / 未知宿主都是 400，且不 spawn', async () => {
    const stub = stubPal({ code: 0, stdout: '{}', stderr: '' });
    const started = await serveWith({ runPal: stub.runner });

    const missing = await post(started, '/api/plan', { host: 'dsh' });
    expect(missing.status).toBe(400);
    expect(String(missing.body.error)).toContain('source');

    const badHost = await post(started, '/api/plan', { source: 'some-pack', host: 'nope' });
    expect(badHost.status).toBe(400);
    expect(String(badHost.body.error)).toContain('未知宿主');

    const badTarget = await post(started, '/api/plan', { source: 'some-pack', host: 'dsh', target: 'attached' });
    expect(badTarget.status).toBe(400);
    expect(String(badTarget.body.error)).toContain('home');

    // target 与参数不匹配不静默忽略：与 CLI 退 2 是同一件事
    const mismatched = await post(started, '/api/plan', {
      source: 'some-pack',
      host: 'dsh',
      target: 'managed',
      home: 'C:\\tmp\\dsh',
    });
    expect(mismatched.status).toBe(400);
    expect(String(mismatched.body.error)).toContain('--home');
    expect(stub.calls).toEqual([]);
  });

  it('POST /api/plan 用临时 Pack 真 spawn pal install --dry-run --json，返回计划与最终名字', async () => {
    const packDir = writePack(join(tmp, 'pack'));
    const started = await serveWith({ runPal: REAL_PAL });

    const res = await post(started, '/api/plan', { source: packDir, host: 'opencode', target: 'managed' });
    expect(res.status).toBe(200);
    const body = res.body as unknown as UiPlanResponse;
    expect(body.ok).toBe(true);
    expect(body.code).toBe(0);
    expect(body.name).toBe('opencode-ui-demo-pack');
    const plan = body.plan as { actions: Array<{ op: string; to?: string }>; pack: { name: string } };
    expect(plan.pack.name).toBe('ui/demo-pack');
    expect(plan.actions.length).toBeGreaterThan(0);
    // 计划动作里有知识文件落点：会写到实例 home 的 knowledge 目录
    expect(plan.actions.some((action) => (action.to ?? '').includes('knowledge'))).toBe(true);
    // dry-run 不落盘：实例目录还是空的
    expect(existsSync(join(process.env.PACKHUB_INSTANCES!, 'opencode-ui-demo-pack'))).toBe(false);
  });

  it('POST /api/install 失败时把 exit code / stdout / stderr 原样带回来', async () => {
    const stub = stubPal({ code: 2, stdout: 'partial-out', stderr: 'x 清单有问题：读不到 metadata.name\n' });
    const started = await serveWith({ runPal: stub.runner });

    const res = await post(started, '/api/install', { source: 'nope-pack', host: 'dsh' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, code: 2, stdout: 'partial-out' });
    expect(String(res.body.stderr)).toContain('清单有问题');
    // 非 dry-run：没有 --dry-run / --json，目标参数按 target 拼
    expect(stub.calls[0]).toEqual(['install', 'nope-pack', '--host', 'dsh']);
    expect(stub.options[0]?.timeoutMs).toBe(120_000);
  });

  it('POST /api/install 按 target 拼 --home / --project / --from-home', async () => {
    const stub = stubPal({ code: 0, stdout: '✓ demo\n', stderr: '' });
    const started = await serveWith({ runPal: stub.runner });

    await post(started, '/api/install', {
      source: 'p',
      host: 'dsh',
      target: 'attached',
      home: 'C:\\tmp\\dsh-home',
      profile: 'web',
    });
    await post(started, '/api/install', { source: 'p', host: 'dsh', target: 'project', project: 'C:\\tmp\\proj' });
    await post(started, '/api/install', {
      source: 'p',
      host: 'opencode',
      target: 'managed',
      name: 'mine',
      root: 'C:\\tmp\\root',
      fromHome: 'C:\\tmp\\global',
    });
    expect(stub.calls[0]).toEqual(['install', 'p', '--host', 'dsh', '--home', 'C:\\tmp\\dsh-home', '--profile', 'web']);
    expect(stub.calls[1]).toEqual(['install', 'p', '--host', 'dsh', '--project', 'C:\\tmp\\proj']);
    expect(stub.calls[2]).toEqual([
      'install',
      'p',
      '--host',
      'opencode',
      '--name',
      'mine',
      '--root',
      'C:\\tmp\\root',
      '--from-home',
      'C:\\tmp\\global',
    ]);
  });

  it('POST /api/home-action 非法 action 400；未知 id 404；update / remove 的 argv 正确', async () => {
    writeInstance(record());
    const stub = stubPal({ code: 0, stdout: '✓ demo\n', stderr: '' });
    const started = await serveWith({ runPal: stub.runner });

    const bad = await post(started, '/api/home-action', { action: 'explode', id: 'demo-ui' });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toContain('action');
    expect(stub.calls).toEqual([]);

    const unknown = await post(started, '/api/home-action', { action: 'verify', id: 'nope' });
    expect(unknown.status).toBe(404);
    expect(stub.calls).toEqual([]);

    const update = await post(started, '/api/home-action', { action: 'update', id: 'demo-ui', profile: 'web' });
    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({ ok: true, code: 0, stdout: '✓ demo\n' });
    expect(stub.calls[0]).toEqual(['update', '--home', '20260101000000-abcdef123456', '--profile', 'web']);

    await post(started, '/api/home-action', { action: 'remove', id: 'demo-ui' });
    expect(stub.calls[1]).toEqual(['remove', '20260101000000-abcdef123456', '--yes']);
    expect(stub.options[1]?.timeoutMs).toBe(60_000);
  });

  it('GET /api/health 未知 id 404；正常记录返回 raw 与解析后的 json', async () => {
    writeInstance(record());
    const report = {
      id: '20260101000000-abcdef123456',
      name: 'demo-ui',
      ok: true,
      checks: [{ name: 'record', status: 'ok', detail: 'instance.json 可读' }],
    };
    const stub = stubPal({ code: 0, stdout: JSON.stringify([report], null, 2), stderr: '' });
    const started = await serveWith({ runPal: stub.runner });

    const unknown = await fetch(new URL('/api/health?id=nope', started.url));
    expect(unknown.status).toBe(404);
    expect(stub.calls).toEqual([]);

    const res = await fetch(new URL('/api/health?id=demo-ui', started.url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as UiHealthResponse;
    expect(body.ok).toBe(true);
    expect(body.code).toBe(0);
    expect(Array.isArray(body.json)).toBe(true);
    expect(body.raw).toContain('"ok": true');
    expect(stub.calls[0]).toEqual(['health', '20260101000000-abcdef123456', '--json']);
  });

  it('GET /api/health 解析不了 JSON 时只给 raw 原文', async () => {
    writeInstance(record());
    const stub = stubPal({ code: 1, stdout: 'not-json-output', stderr: 'x 坏了\n' });
    const started = await serveWith({ runPal: stub.runner });

    const res = await fetch(new URL('/api/health?id=demo-ui', started.url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as UiHealthResponse;
    expect(body.ok).toBe(false);
    expect(body.code).toBe(1);
    expect(body.json).toBeUndefined();
    expect(body.raw).toBe('not-json-output');
  });

  it('POST /api/terminal 非前台模式 400；前台模式返回 pal run 命令并开窗口', async () => {
    writeInstance(record({ harness: 'dsh', name: 'dsh-demo' }));
    writeInstance(record({ id: '20260101000001-abcdef123456', name: 'oc-demo', harness: 'opencode' }));
    const opened: TerminalRequest[] = [];
    const stub = stubPal({ code: 0, stdout: '', stderr: '' });
    const started = await serveWith({
      runPal: stub.runner,
      openTerminal: (request) => {
        opened.push(request);
        return Promise.resolve({ window: 'stub-window' });
      },
    });

    const bad = await post(started, '/api/terminal', { id: 'dsh-demo' });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toContain('前台模式');
    expect(opened).toEqual([]);

    const good = await post(started, '/api/terminal', { id: 'oc-demo' });
    expect(good.status).toBe(200);
    expect(String(good.body.command)).toContain('pal run');
    expect(String(good.body.command)).toContain('oc-demo');
    expect(String(good.body.window)).toBe('stub-window');
    expect(opened[0]?.command).toBe('pal run oc-demo');
    expect(opened[0]?.title).toContain('oc-demo');
  });

  it('POST /api/terminal 打开失败时 500 + 原因', async () => {
    writeInstance(record({ name: 'oc-demo', harness: 'opencode' }));
    const stub = stubPal({ code: 0, stdout: '', stderr: '' });
    const started = await serveWith({
      runPal: stub.runner,
      openTerminal: () => Promise.reject(new Error('没有可用的终端模拟器')),
    });

    const res = await post(started, '/api/terminal', { id: 'oc-demo' });
    expect(res.status).toBe(500);
    expect(String(res.body.error)).toContain('没有可用的终端模拟器');
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
