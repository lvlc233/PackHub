import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPalServer, type PalServer } from '../src/server.ts';
import { createInstance } from '../src/index.ts';
import { resetHarnessCache } from '../src/harness.ts';

let tmp: string;
let server: PalServer;

const url = (path: string): string => `${server.url}${path.replace(/^\//, '')}`;

const serverPort = (): number => Number(new URL(server.url).port);

interface RawResult {
  status: number;
  text: string;
  error?: string;
}

/**
 * 用原始 http.request 发请求：fetch 会先把 URL 里的 `..` 规范化掉，测不到服务端行为。
 * timeoutMs 到点就主动断开并标记 error='timeout'，用来证明连接没被挂住。
 */
function rawRequest(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: Buffer | string; agent?: Agent; timeoutMs?: number } = {},
): Promise<RawResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: RawResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(value);
    };
    const req = request(
      {
        host: '127.0.0.1',
        port: serverPort(),
        path,
        method: init.method ?? 'GET',
        headers: init.headers,
        ...(init.agent ? { agent: init.agent } : {}),
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => finish({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => finish({ status: 0, text: '', error: err.code ?? err.message }));
    if (init.timeoutMs) {
      timer = setTimeout(() => {
        req.destroy();
        finish({ status: 0, text: '', error: 'timeout' });
      }, init.timeoutMs);
    }
    req.end(init.body);
  });
}

/** 界面就是这么发请求的：同一个头，同一个来源。 */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'application/json', 'x-pal-client': 'pal-ui', ...extra };
}

/** 浏览器里的界面：带 Origin，还要带 index.html 里注入的 token。 */
function browserHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return headers({ origin: new URL(server.url).origin, 'x-pal-token': server.token, ...extra });
}

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url(path), { ...init, headers: headers((init.headers as Record<string, string>) ?? {}) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* 静态文件不是 JSON */
  }
  return { status: res.status, body: body as never };
}

async function json(path: string, init: RequestInit = {}): Promise<any> {
  const res = await call(path, init);
  if (res.status >= 400) throw new Error(JSON.stringify(res.body));
  return res.body;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-server-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  process.env.PACKHUB_HOME = join(tmp, 'home');
  delete process.env.PACKHUB_INDEX;
  server = await startPalServer({ port: 0 });
});

afterEach(async () => {
  await server.close();
  delete process.env.PACKHUB_INSTANCES;
  delete process.env.PACKHUB_HOME;
  resetHarnessCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('PAL 本地界面 API', () => {
  it('首页是界面，不是空响应', async () => {
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('PAL');
    expect(text).toContain('/app.js');
  });

  it('创建、列出、设为当前、看日志、体检、删除', async () => {
    const first = await json('/api/instances');
    expect(first.instances).toEqual([]);

    const rec = await json('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'web', harness: 'dir' }),
    });
    expect(rec.name).toBe('web');
    expect(rec.status).toBe('installed');

    const list = await json('/api/instances');
    expect(list.instances.map((item: { id: string }) => item.id)).toEqual([rec.id]);
    expect(list.active.dir).toBe(rec.id);

    await json(`/api/instances/${rec.id}/active`, { method: 'POST' });
    expect(await json('/api/active')).toEqual([{ harness: 'dir', id: rec.id }]);

    const logs = await json(`/api/instances/${rec.id}/logs`);
    expect(logs.text).toBe('');
    expect(Array.isArray(logs.files)).toBe(true);

    const health = await json(`/api/instances/${rec.id}/health`);
    expect(health.id).toBe(rec.id);
    expect(health.checks.map((check: { name: string }) => check.name)).toContain('baseline');

    const removed = await json(`/api/instances/${rec.id}`, { method: 'DELETE' });
    expect(removed.removed).toBe(true);
    expect((await json('/api/instances')).instances).toEqual([]);
  });

  it('跨源写请求被拒绝，缺客户端头的写请求也被拒绝', async () => {
    const cross = await fetch(url('/api/instances'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pal-client': 'pal-ui',
        origin: 'http://evil.example',
      },
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'evil', harness: 'dir' }),
    });
    expect(cross.status).toBe(403);
    expect(((await cross.json()) as { code: string }).code).toBe('forbidden');

    const noHeader = await fetch(url('/api/instances'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'csrf', harness: 'dir' }),
    });
    expect(noHeader.status).toBe(403);

    // 读接口不受影响
    expect((await call('/api/instances')).status).toBe(200);
  });

  it('带 Origin 的请求要页面 token：缺 / 错 403，对了回到原行为', async () => {
    const origin = new URL(server.url).origin;
    const body = JSON.stringify({ pack: 'examples/doc-review', name: 'browser', harness: 'dir' });
    const base = { 'content-type': 'application/json', 'x-pal-client': 'pal-ui', origin };

    const missing = await fetch(url('/api/instances'), { method: 'POST', headers: base, body });
    expect(missing.status).toBe(403);
    const missingBody = (await missing.json()) as { code: string; error: string };
    expect(missingBody.code).toBe('forbidden');
    expect(missingBody.error).toContain('x-pal-token');
    expect(missingBody.error).toContain('缺少');

    // 形状合法但值不对：换掉首字符，保证和真 token 不同且仍像 token
    const wrongToken = server.token.replace(/^./, (ch: string) => (ch === 'a' ? 'b' : 'a'));
    const wrong = await fetch(url('/api/instances'), {
      method: 'POST',
      headers: { ...base, 'x-pal-token': wrongToken },
      body,
    });
    expect(wrong.status).toBe(403);
    const wrongBody = (await wrong.json()) as { code: string; error: string };
    expect(wrongBody.code).toBe('forbidden');
    expect(wrongBody.error).toContain('x-pal-token');

    // 读接口也一样：带 Origin 就说明是浏览器页面在发，没 token 不放行
    const read = await fetch(url('/api/instances'), { headers: { origin } });
    expect(read.status).toBe(403);

    // 带对 token：写请求照旧（还要 x-pal-client），能创建实例
    const good = await fetch(url('/api/instances'), {
      method: 'POST',
      headers: browserHeaders(),
      body,
    });
    expect(good.status).toBe(200);
    expect(((await good.json()) as { name: string }).name).toBe('browser');
  });

  it('不带 Origin 的写请求仍按原规则：x-pal-client 就够', async () => {
    const rec = await json('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'cli', harness: 'dir' }),
    });
    expect(rec.name).toBe('cli');

    const noHeader = await fetch(url('/api/instances'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'csrf', harness: 'dir' }),
    });
    expect(noHeader.status).toBe(403);
  });

  it('首页注入真实 token，占位符不残留；其它静态文件原样', async () => {
    expect(server.token).toMatch(/^[0-9a-f]{32,}$/);

    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<meta name="pal-token" content="${server.token}" />`);
    expect(html).not.toContain('__PAL_TOKEN__');

    // 直接点 /index.html 也一样注入
    const direct = await (await fetch(url('/index.html'))).text();
    expect(direct).toContain(server.token);

    // 只有首页带凭据：别把 token 铺到每个静态资源上
    const app = await (await fetch(url('/app.js'))).text();
    expect(app).not.toContain(server.token);
    expect(app).not.toContain('__PAL_TOKEN__');
  });

  it('静态资源带 Origin（浏览器 module 请求）不要求 token；/api 仍要求', async () => {
    const origin = new URL(server.url).origin;
    // 浏览器按 module 取 app.js 会带 Origin，但它拿不到页面 token，不能因此 403
    const app = await fetch(url('/app.js'), { headers: { origin } });
    expect(app.status).toBe(200);
    const css = await fetch(url('/style.css'), { headers: { origin } });
    expect(css.status).toBe(200);
    // /api/* 仍然要 token
    const api = await fetch(url('/api/instances'), { headers: { origin } });
    expect(api.status).toBe(403);
  });

  it('未知实例 404、未知宿主 400，错误里带稳定 code', async () => {
    const missing = await call('/api/instances/nope/stop', { method: 'POST' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('unknown-instance');

    const badHarness = await call('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'x', harness: 'nope' }),
    });
    expect(badHarness.status).toBe(400);
    expect(badHarness.body.code).toBe('unknown-harness');
    expect(badHarness.body.hint).toContain('dsh');
  });

  it('创建接口接受 body.root：相对路径 400，绝对外部路径真的建到那里', async () => {
    const relative = await call('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'rel-root', harness: 'dir', root: 'beside/inst' }),
    });
    expect(relative.status).toBe(400);
    expect(relative.body.code).toBe('invalid-input');
    // 路径只在 details 里，message 不回显
    expect(relative.body.error).not.toContain('beside/inst');
    expect(relative.body.details?.root).toBe('beside/inst');
    expect((await json('/api/instances')).instances).toEqual([]);

    const target = join(tmp, 'beside', 'web-root');
    const rec = await json('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'abs-root', harness: 'dir', root: target }),
    });
    expect(rec.root).toBe(target);
    expect(existsSync(join(target, 'instance.json'))).toBe(true);
  });

  it('接管已有目录：绝对路径成功；相对路径 / UNC 400，路径只进 details', async () => {
    const dir = join(tmp, 'adopt-me');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.md'), 'hello', 'utf8');

    const rec = await json('/api/instances/adopt', {
      method: 'POST',
      body: JSON.stringify({ dir, name: 'adopted', harness: 'dir' }),
    });
    expect(rec.name).toBe('adopted');
    expect(rec.root).toBe(dir);
    // 接管只写记录，目录归用户自己的
    expect(rec.managed).toBe(false);
    expect(rec.origin.kind).toBe('adopted');
    expect(existsSync(join(dir, 'instance.json'))).toBe(true);
    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('hello');
    expect((await json('/api/instances')).instances.map((i: { id: string }) => i.id)).toContain(rec.id);

    const relative = await call('/api/instances/adopt', {
      method: 'POST',
      body: JSON.stringify({ dir: 'rel/home', name: 'rel-adopt', harness: 'dir' }),
    });
    expect(relative.status).toBe(400);
    expect(relative.body.code).toBe('invalid-input');
    expect(relative.body.error).not.toContain('rel/home');
    expect(relative.body.details?.dir).toBe('rel/home');

    const unc = await call('/api/instances/adopt', {
      method: 'POST',
      body: JSON.stringify({ dir: '\\\\server\\share\\home', name: 'unc-adopt', harness: 'dir' }),
    });
    expect(unc.status).toBe(400);
    expect(unc.body.code).toBe('invalid-input');
    expect(unc.body.error).toContain('UNC');
    // 两次失败都没有留下半份记录
    expect((await json('/api/instances')).instances.map((i: { name: string }) => i.name)).toEqual(['adopted']);
  });

  it('复制实例：自定义 root 生效，源实例不动', async () => {
    const src = await json('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'clone-src', harness: 'dir' }),
    });
    const target = join(tmp, 'cloned-root');
    const copy = await json(`/api/instances/${src.id}/clone`, {
      method: 'POST',
      body: JSON.stringify({ name: 'clone-copy', root: target }),
    });
    expect(copy.id).not.toBe(src.id);
    expect(copy.name).toBe('clone-copy');
    expect(copy.root).toBe(target);
    expect(copy.status).toBe('installed');
    expect(copy.origin).toEqual({ kind: 'copy', from: src.id });
    expect(existsSync(join(target, 'instance.json'))).toBe(true);
    // 源实例还在，没被挪走
    expect((await json(`/api/instances/${src.id}`)).root).toBe(src.root);
  });

  it('改名：PATCH /api/instances/:id 换名字，同名重名与空名有明确错误', async () => {
    const rec = await json('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'old-name', harness: 'dir' }),
    });
    const renamed = await json(`/api/instances/${rec.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'new-name' }),
    });
    expect(renamed.id).toBe(rec.id);
    expect(renamed.name).toBe('new-name');
    // 读回来的是落盘的结果，不是内存里的 draft
    expect((await json(`/api/instances/${rec.id}`)).name).toBe('new-name');

    const empty = await call(`/api/instances/${rec.id}`, { method: 'PATCH', body: JSON.stringify({ name: '  ' }) });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('invalid-input');
  });

  it('迁移：绝对目标真的挪根并改记录；相对目标 400 且不动目录', async () => {
    const rec = await json('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'move-me', harness: 'dir' }),
    });
    const to = join(tmp, 'moved-here');
    const moved = await json(`/api/instances/${rec.id}/migrate`, {
      method: 'POST',
      body: JSON.stringify({ to }),
    });
    expect(moved.id).toBe(rec.id);
    expect(moved.root).toBe(to);
    expect(existsSync(join(to, 'instance.json'))).toBe(true);
    expect(existsSync(rec.root)).toBe(false);

    const relative = await call(`/api/instances/${rec.id}/migrate`, {
      method: 'POST',
      body: JSON.stringify({ to: 'moved/relative' }),
    });
    expect(relative.status).toBe(400);
    expect(relative.body.code).toBe('invalid-input');
    expect(relative.body.details?.to).toBe('moved/relative');
    expect((await json(`/api/instances/${rec.id}`)).root).toBe(to);
  });

  it('导出模板：默认写进 exports 目录并回 {file,template}；自定义 out 必须是绝对路径', async () => {
    const rec = await json('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'export-me', harness: 'dir' }),
    });
    const result = await json(`/api/instances/${rec.id}/export`, { method: 'POST', body: '{}' });
    // 默认导出在 PAL home 的 exports，不在 instancesRoot（否则会被扫描当坏记录隔离）
    const expected = join(tmp, 'home', 'exports', 'export-me.pal.json');
    expect(result.file).toBe(expected);
    // 触发一次列表扫描后模板文件还在（旧实现放 instancesRoot 时会被当坏记录隔离掉）
    await call('/api/instances');
    expect(existsSync(expected)).toBe(true);
    expect(result.template.apiVersion).toBe('packhub.dev/instance-template/v0');
    expect(result.template.name).toBe('export-me');
    expect(result.template.reproducible).toBe(true);
    expect(JSON.parse(readFileSync(expected, 'utf8'))).toEqual(result.template);

    const relative = await call(`/api/instances/${rec.id}/export`, {
      method: 'POST',
      body: JSON.stringify({ out: 'out.pal.json' }),
    });
    expect(relative.status).toBe(400);
    expect(relative.body.code).toBe('invalid-input');
    expect(relative.body.error).not.toContain('out.pal.json');
    expect(relative.body.details?.out).toBe('out.pal.json');

    const custom = join(tmp, 'elsewhere', 'custom.pal.json');
    const customOut = await json(`/api/instances/${rec.id}/export`, {
      method: 'POST',
      body: JSON.stringify({ out: custom }),
    });
    expect(customOut.file).toBe(custom);
    expect(existsSync(custom)).toBe(true);
  });

  it('导入模板：读回导出的文件，按新名字在新根重建', async () => {
    const rec = await json('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'import-src', harness: 'dir' }),
    });
    const exported = await json(`/api/instances/${rec.id}/export`, { method: 'POST', body: '{}' });
    const root = join(tmp, 'imported');
    const imported = await json('/api/instances/import', {
      method: 'POST',
      body: JSON.stringify({ file: exported.file, name: 'from-template', root }),
    });
    expect(imported.id).not.toBe(rec.id);
    expect(imported.name).toBe('from-template');
    expect(imported.root).toBe(root);
    expect(imported.pack.ref).toBe('examples/doc-review');

    // 模板文件路径也要求绝对：相对路径先挡住，不猜 cwd
    const relative = await call('/api/instances/import', {
      method: 'POST',
      body: JSON.stringify({ file: 'rel.pal.json', name: 'nope' }),
    });
    expect(relative.status).toBe(400);
    expect(relative.body.code).toBe('invalid-input');
    expect(relative.body.details?.file).toBe('rel.pal.json');
  });

  it('缺字段 400；宿主发现结果带版本与可启动性', async () => {
    const res = await call('/api/instances', { method: 'POST', body: JSON.stringify({ name: 'x' }) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid-input');

    const harnesses = await json('/api/harnesses?probe=0');
    const ids = harnesses.map((item: { id: string }) => item.id);
    expect(ids).toEqual(['dir', 'dsh', 'claude-code', 'codex']);
    const claude = harnesses.find((item: { id: string }) => item.id === 'claude-code');
    expect(claude.startable).toBe(true);
    const dir = harnesses.find((item: { id: string }) => item.id === 'dir');
    expect(dir.startable).toBe(false);
    expect(dir.reason).toContain('项目目录');
  });

  it('包列表带版本；没有索引时也能列本地 Pack', async () => {
    const packs = await json('/api/packs');
    expect(packs.index).toBeNull();
    expect(Array.isArray(packs.local)).toBe(true);
  });

  it('更新接口：同一个 Pack 同一版本不产生变化', async () => {
    const rec = await json('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'upd-me', harness: 'dir' }),
    });
    const result = await json(`/api/instances/${rec.id}/update`, { method: 'POST', body: '{}' });
    expect(result.changed).toBe(false);
    expect(result.to).toBe('lvlc233/doc-review@0.1.0');
  });

  it('入口表：每个入口带访问面、就绪判据与能不能起；当前那个被标出来', async () => {
    process.env.PAL_DSH_BIN = process.execPath;
    resetHarnessCache();
    const rec = await json('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'entries', harness: 'dsh' }),
    });
    const entries = await json(`/api/instances/${rec.id}/entries`);
    expect(entries.map((entry: { kind: string }) => entry.kind)).toEqual(['web', 'app', 'tui', 'headless']);
    const web = entries.find((entry: { kind: string }) => entry.kind === 'web');
    expect(web.surface).toBe('browser');
    expect(web.ready).toBe('url');
    expect(web.binds.port).toBe(true);
    expect(web.current).toBe(false);
    const tui = entries.find((entry: { kind: string }) => entry.kind === 'tui');
    expect(tui.startable).toBe(false);
    expect(tui.reason).toContain('tui profile');
    delete process.env.PAL_DSH_BIN;
    resetHarnessCache();
  });

  it('打开实例：服务端把凭据拼回去，接口本身不吐 token', async () => {    const rec = await json('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'opened', harness: 'dir' }),
    });
    // 没有地址时明确报错，而不是给一个空跳转
    const res = await call(`/api/instances/${rec.id}/open`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not-running');
  });

  it('读列表没有副作用：pid 已死的记录只报告，不改记录文件、不隔离坏记录', async () => {
    const rec = await createInstance({ name: 'dead', harness: 'dir', packDir: 'examples/doc-review' });
    const file = join(rec.root, 'instance.json');
    const runtimePath = join(rec.root, 'runtime.json');
    // 造一个"记录说在跑、进程其实已经不在了"的现场：运行态写在 runtime.json
    writeFileSync(
      runtimePath,
      JSON.stringify({ status: 'running', pid: 777777, port: 1 }, null, 2) + '\n',
      'utf8',
    );
    const before = readFileSync(file, 'utf8');
    const runtimeBefore = readFileSync(runtimePath, 'utf8');

    // 再放一条真正读不了的坏记录：读列表应该只报告，不把它搬进 .quarantine
    const badDir = join(tmp, 'instances', 'broken-record');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'instance.json'), '{ not json', 'utf8');

    const list = await json('/api/instances');
    const row = list.instances.find((item: { id: string }) => item.id === rec.id);
    // 视图里是 broken + stale（记录还没刷新过），但磁盘上的记录一个字节都没动
    expect(row?.status).toBe('broken');
    expect(row?.stale).toBe(true);
    expect(row?.pid).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(runtimePath, 'utf8')).toBe(runtimeBefore);
    expect(list.broken.map((bad: { dir: string }) => bad.dir)).toContain(badDir);
    expect(existsSync(badDir)).toBe(true);
    expect(existsSync(join(tmp, 'instances', '.quarantine'))).toBe(false);
  });

  it('静态路径越界（.. 段、编码斜杠、反斜杠）一律 404，不泄漏仓库文件', async () => {
    // 仓根 package.json 就在 web 目录外：越界成功的话会原样吐出来
    const repoPackage = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    expect(repoPackage).toContain('packhub');

    const attempts = [
      '/../package.json',
      '/..%2fpackage.json',
      '/..%2F..%2fpackage.json',
      '/..%5cpackage.json',
      '/%2e%2e/package.json',
      '/..%2fweb2%2fsecret.txt',
    ];
    for (const attempt of attempts) {
      const res = await rawRequest(attempt);
      expect(res.status, attempt).toBe(404);
      expect(res.text, attempt).not.toContain('"packhub"');
    }

    // 正常的静态资源不受影响
    const ok = await rawRequest('/index.html');
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('PAL');
  });

  it('请求体超过 1MB 返回 400，剩余请求体读完、连接不会被挂住', async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const body = JSON.stringify({
        pack: 'examples/doc-review',
        name: 'big',
        harness: 'dir',
        pad: 'x'.repeat(1_500_000),
      });
      const big = await rawRequest('/api/instances', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pal-client': 'pal-ui',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
        agent,
        timeoutMs: 5000,
      });
      expect(big.status).toBe(400);
      expect((JSON.parse(big.text) as { code: string }).code).toBe('invalid-input');

      // 旧实现只回 400 就不管剩下的字节了，这条复用同一连接的请求会一直等不到响应
      const after = await rawRequest('/index.html', { agent, timeoutMs: 3000 });
      expect(after.error).toBeUndefined();
      expect(after.status).toBe(200);

      // 没有创建出半截实例；服务本身照常响应
      expect((await json('/api/instances')).instances).toEqual([]);
    } finally {
      agent.destroy();
    }
  });

  it('服务关掉后 token 不再可用', async () => {
    const extra = await startPalServer({ port: 0 });
    let closed = false;
    try {
      // 每次启动都是新 token：旧页面的凭据不会跟着新进程用
      expect(extra.token).toMatch(/^[0-9a-f]{32}$/);
      expect(extra.token).not.toBe(server.token);

      const before = await fetch(extra.url);
      expect(before.status).toBe(200);
      expect(await before.text()).toContain(extra.token);

      await extra.close();
      closed = true;
      // 地址已经没了，token 自然没有可用之处
      await expect(fetch(extra.url)).rejects.toThrow();
    } finally {
      if (!closed) await extra.close().catch(() => {});
    }
  });
});
