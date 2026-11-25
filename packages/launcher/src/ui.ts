// `pal ui` 的服务端：本地 HTTP + 单页 HTML，只做「列出 home / 启动 / 停止 / 看日志」。
//
// 边界（见 decisions「pal ui：本地 HTTP + 单页」）：
// - 只绑 127.0.0.1，不是给局域网用的；
// - 读/写实例都走现有模块（coreCall / startAppInstance / stopInstance / 记录扫描），这里不另造一套启停；
// - POST 要求 `content-type: application/json` + `x-pal-ui: 1`（页面自己带），挡掉别的网页顺手 POST 127.0.0.1；
// - 页面不用框架、不引 CDN，动态内容只在 JS 里用 textContent / 属性赋值，不拼 HTML 字符串。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { LaunchMode } from '@packhub/kernel';
import { scanInstances } from './catalog.ts';
import { coreCall } from './coreClient.ts';
import { errorBody, PalError } from './errors.ts';
import { adapterFor } from './layout.ts';
import { availabilityOf, resolveLaunchMode, unavailableReason } from './launchModes.ts';
import { readLog } from './logs.ts';
import type { InstanceRecord } from './records.ts';
import { resolveStartProfile } from './startProfile.ts';
import { startAppInstance } from './startApp.ts';
import { logFileOf, statusView, stopInstance } from './start.ts';

/** 一条模式在页面上的样子；`command` 只给前台模式（页面显示它、点击复制）。 */
export interface UiMode {
  id: string;
  label: string;
  kind: LaunchMode['kind'];
  default: boolean;
  available: boolean;
  reason?: string;
  command?: string;
}

/** `GET /api/instances` 的一条 home。动态字段都给 null，不靠「缺字段」表达没有。 */
export interface UiInstance {
  id: string;
  name: string;
  harness: string;
  pack: { name: string; version: string };
  status: string;
  attached: boolean;
  url: string | null;
  port: number | null;
  pid: number | null;
  modes: UiMode[];
}

export interface UiServerOptions {
  /** 0 = 让系统挑（默认）；只有 CLI 的 `--port` 会给出具体值 */
  port?: number;
  host?: string;
}

export interface UiServer {
  server: Server;
  url: string;
  port: number;
  /** 关掉监听；已建立的连接不等，直接断（页面会显示「连不上」）。 */
  close: () => Promise<void>;
}

const DEFAULT_TAIL = 200;
const MAX_TAIL = 2000;
const MAX_BODY = 1_000_000;

/** 一个 home 的页脚命令：`pal run` 只对应默认那条前台模式，别的模式要写明 `--mode`。 */
function foregroundCommand(rec: InstanceRecord, mode: LaunchMode): string {
  const target = shellToken(rec.name);
  const defaultForeground = adapterFor(rec.harness)?.modes.find((item) => item.kind === 'foreground');
  return defaultForeground?.id === mode.id ? `pal run ${target}` : `pal start ${target} --mode ${mode.id}`;
}

/** 复制用的命令里，名字带空白 / 引号时包一层双引号（页面直接用它，不再自己拼）。 */
function shellToken(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

/**
 * 列表视图：一条记录 + 适配器的模式表，可用性按当前记录现判（与 `pal start --list-modes` 同一套函数）。
 * 状态用 `statusView`：pid 已经不在的「running」按异常显示，但这是只读推导，不写盘。
 */
function instancesView(records: InstanceRecord[]): UiInstance[] {
  return statusView(records).map((rec) => {
    const adapter = adapterFor(rec.harness);
    const modes = adapter?.modes ?? [];
    const defaultId = adapter?.defaultMode ?? modes[0]?.id;
    const ctx = availabilityOf(rec);
    return {
      id: rec.id,
      name: rec.name,
      harness: rec.harness,
      pack: { name: rec.pack.name, version: rec.pack.version },
      status: rec.status,
      attached: rec.attached === true,
      url: rec.url ?? null,
      port: rec.port ?? null,
      pid: rec.pid ?? null,
      modes: modes.map((mode) => {
        const reason = unavailableReason(mode, ctx);
        const view: UiMode = {
          id: mode.id,
          label: mode.label,
          kind: mode.kind,
          default: mode.id === defaultId,
          available: reason === undefined,
        };
        if (reason !== undefined) view.reason = reason;
        if (mode.kind === 'foreground') view.command = foregroundCommand(rec, mode);
        return view;
      }),
    };
  });
}

/** 按 id 或名字找一份记录；用纯读扫描，不因为页面刷新就把坏记录搬进隔离区。 */
function findRecord(idOrName: string): InstanceRecord | undefined {
  return scanInstances().records.find((rec) => rec.id === idOrName || rec.name === idOrName);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(html);
}

/** POST 的本地闸门：浏览器跨站表单发不出这两个头，同源页面自己带。 */
function requireUiRequest(req: IncomingMessage): void {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  const marker = req.headers['x-pal-ui'];
  if (!type.startsWith('application/json') || Array.isArray(marker) || marker !== '1') {
    throw new PalError('forbidden', '请求被拒：POST 只接受本页面发的 JSON 请求', {
      hint: '要带 content-type: application/json 与 x-pal-ui: 1；pal ui 只给本机页面用',
    });
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new PalError('invalid-input', '请求体太大');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PalError('invalid-input', '请求体不是合法 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new PalError('invalid-input', '请求体要是 JSON 对象');
  }
  return data as Record<string, unknown>;
}

function bodyId(body: Record<string, unknown>): string {
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) {
    throw new PalError('invalid-input', '要一个 id：{ id, mode? }', { hint: '页面从 /api/instances 拿到的 id' });
  }
  return id;
}

function requireRecord(id: string): InstanceRecord {
  const rec = findRecord(id);
  if (!rec) {
    throw new PalError('unknown-instance', `没有这个实例：${id}`, { hint: '刷新页面；或 pal list 看现有实例' });
  }
  return rec;
}

/** 停的时候按记录里上次启动的模式分派：app 直接收 pid，server 交给 core。 */
function recordedKind(rec: InstanceRecord): 'server' | 'app' {
  const mode = adapterFor(rec.harness)?.modes.find((item) => item.id === rec.launchMode);
  return mode?.kind === 'app' ? 'app' : 'server';
}

async function startOne(body: Record<string, unknown>): Promise<InstanceRecord> {
  const rec = requireRecord(bodyId(body));
  const requested = typeof body.mode === 'string' && body.mode.trim() ? body.mode.trim() : undefined;
  const { mode } = resolveLaunchMode(rec, requested);
  // 与 CLI 同一条不可用判断（例如 dsh 的 app 只对 attached 开放）：先把原因翻成 400，再谈执行
  const reason = unavailableReason(mode, availabilityOf(rec));
  if (reason !== undefined) {
    throw new PalError('invalid-input', `宿主 ${rec.harness} 的 ${mode.id} 模式不可用：${reason}`, {
      hint: '模式表见页面上的按钮说明；pal start <home> --list-modes 也能看',
    });
  }
  if (mode.kind === 'foreground') {
    // 前台模式要终端：页面只显示复制命令，不替用户 spawn（spawn 出去没有 stdin/TTY）
    throw new ForegroundMode(foregroundCommand(rec, mode));
  }
  if (mode.kind === 'app') return startAppInstance(rec.id, { mode });
  // server：与 `pal start` 同一条 core RPC；profile 的解析也沿用 CLI 的那一份
  const profile = resolveStartProfileFor(rec, mode);
  return coreCall<InstanceRecord>('start', {
    id: rec.id,
    mode: mode.id,
    ...(profile ? { profile } : {}),
  });
}

/**
 * server 启动要带 profile 时按 CLI 的同一套规则解析（dsh 的 web 模式）：
 * 记录里的 profile（`all` = 没记）> 宿主的默认 `web`；attached dsh 会先核对 profile 目录存在。
 * 解析失败是用法错（400），不启动。
 */
function resolveStartProfileFor(rec: InstanceRecord, mode: LaunchMode): string | undefined {
  if (mode.usesProfile !== true) return undefined;
  return resolveStartProfile(rec, mode).name;
}

/** 409：前台模式的统一回答（页面显示并复制命令）。 */
class ForegroundMode extends PalError {
  readonly command: string;

  constructor(command: string) {
    super('invalid-input', '前台模式需要在终端运行', {
      hint: '在终端里跑这条命令；PAL 不替页面 spawn 没有 TTY 的进程',
    });
    this.command = command;
  }
}

async function stopOne(body: Record<string, unknown>): Promise<InstanceRecord> {
  const rec = requireRecord(bodyId(body));
  if (recordedKind(rec) === 'app') return stopInstance(rec.id);
  return coreCall<InstanceRecord>('stop', { id: rec.id });
}

function logsOf(url: URL): { file: string; lines: string[] } {
  const id = (url.searchParams.get('id') ?? '').trim();
  if (!id) throw new PalError('invalid-input', '要 id：/api/logs?id=<home>');
  const rec = requireRecord(id);
  const raw = Number(url.searchParams.get('tail') ?? DEFAULT_TAIL);
  const tail = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), MAX_TAIL) : DEFAULT_TAIL;
  const log = readLog(rec.root);
  // 行尾的换行会 split 出一个空串；空行对读日志的人没有信息量，去掉再取尾部
  const lines = log.text.split(/\r?\n/).filter((line) => line !== '').slice(-tail);
  return { file: logFileOf(rec), lines };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://pal-ui');

  if (req.method === 'GET' && url.pathname === '/') {
    sendHtml(res, PAGE_HTML);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/instances') {
    sendJson(res, 200, { instances: instancesView(scanInstances().records) });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    sendJson(res, 200, logsOf(url));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/start') {
    requireUiRequest(req);
    const body = await readJsonBody(req);
    sendJson(res, 200, await startOne(body));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/stop') {
    requireUiRequest(req);
    const body = await readJsonBody(req);
    sendJson(res, 200, await stopOne(body));
    return;
  }
  throw new PalError('not-found', `pal ui 没有这个接口：${req.method} ${url.pathname}`, {
    hint: '页面用的接口：GET / /api/instances /api/logs，POST /api/start /api/stop',
  });
}

/**
 * 起 UI 服务：只绑 127.0.0.1，端口 0 = 系统挑。
 * 它是前台进程的一部分（`pal ui` 阻塞到 Ctrl+C），生命周期与 core 无关：关掉它不动实例，也不停 core。
 */
export async function startUiServer(options: UiServerOptions = {}): Promise<UiServer> {
  const host = options.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof ForegroundMode) {
        sendJson(res, 409, {
          error: err.message,
          command: err.command,
          code: 'foreground-needs-terminal',
          ...(err.hint ? { hint: err.hint } : {}),
        });
        return;
      }
      const body = errorBody(err);
      sendJson(res, body.status, body);
    });
  });

  const requested = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      reject(
        err.code === 'EADDRINUSE'
          ? new PalError('port-in-use', `端口 ${requested} 已被占用`, {
              hint: '换一个 --port，或不写让它自己挑',
              details: { port: requested },
            })
          : new PalError('internal', `pal ui 起不来：${err.message}`, { cause: err, details: { port: requested } }),
      );
    };
    server.once('error', onError);
    server.listen(requested, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requested;
  return {
    server,
    port,
    url: `http://${host}:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/* ---------- 页面 ---------- */

/**
 * 单页 HTML：内联 CSS/JS，不引 CDN、不用框架。
 * 动态内容一律走 textContent / 属性赋值（不拼 innerHTML），名字与日志里的尖括号不会被当成标记。
 */
const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PAL 启动器</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #1f2328; }
header { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 20px; background: #fff; border-bottom: 1px solid #e3e6ea; }
h1 { margin: 0; font-size: 18px; }
.toolbar { display: flex; align-items: center; gap: 12px; color: #57606a; }
button { font: inherit; border: 1px solid #d0d7de; background: #f6f8fa; color: #1f2328; border-radius: 6px; padding: 5px 10px; cursor: pointer; }
button:hover:not(:disabled) { background: #eef1f4; }
button:disabled { opacity: .5; cursor: not-allowed; }
main { padding: 18px 20px 60px; display: grid; grid-template-columns: repeat(auto-fill, minmax(370px, 1fr)); gap: 14px; }
.card { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 14px 16px; }
.card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.name { margin: 0; font-size: 15px; font-weight: 600; word-break: break-all; }
.host, .pack { color: #57606a; font-size: 12px; }
.badges { margin-left: auto; display: flex; gap: 6px; }
.badge { font-size: 12px; padding: 1px 7px; border-radius: 999px; background: #eef1f4; color: #57606a; }
.badge.run { background: #dafbe1; color: #1a7f37; }
.badge.attached { background: #ddf4ff; color: #0969da; }
.modes { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.mode-pair { display: flex; align-items: center; gap: 8px; }
.cmd { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; background: #f6f8fa; border: 1px solid #e3e6ea; border-radius: 6px; padding: 3px 7px; cursor: pointer; }
.meta { margin-top: 10px; color: #57606a; font-size: 12px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.meta button { padding: 3px 9px; font-size: 12px; }
.open { color: #0969da; }
.danger { color: #cf222e; border-color: #ffcecb; background: #fff5f5; }
.empty { grid-column: 1 / -1; background: #fff; border: 1px dashed #d0d7de; border-radius: 10px; padding: 28px; text-align: center; }
.empty p { margin: 6px 0; }
.hint { color: #57606a; font-size: 13px; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #1f2328; color: #fff; padding: 8px 14px; border-radius: 8px; max-width: 80vw; z-index: 30; }
.toast.bad { background: #cf222e; }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(760px, 92vw); background: #fff; border-left: 1px solid #e3e6ea; box-shadow: -8px 0 24px rgba(0,0,0,.08); z-index: 20; display: flex; flex-direction: column; }
.drawer-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid #e3e6ea; }
.drawer-head h2 { margin: 0; font-size: 14px; }
.drawer-head .file { margin-left: auto; font-size: 12px; color: #57606a; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 55%; }
pre#drawer-body { margin: 0; padding: 12px 14px; overflow: auto; flex: 1; font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; word-break: break-all; background: #fafbfc; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<header>
  <h1>PAL 启动器</h1>
  <div class="toolbar">
    <label><input type="checkbox" id="auto" checked> 自动刷新（2s）</label>
    <button id="refresh" type="button">刷新状态</button>
  </div>
</header>
<main id="list"></main>
<div id="toast" class="toast" hidden></div>
<aside id="drawer" class="drawer" hidden>
  <div class="drawer-head">
    <h2 id="drawer-title">日志</h2>
    <span class="file" id="drawer-file"></span>
    <button id="drawer-close" type="button">关闭</button>
  </div>
  <pre id="drawer-body"></pre>
</aside>
<script>
(function () {
  'use strict';
  var listEl = document.getElementById('list');
  var toastEl = document.getElementById('toast');
  var drawer = document.getElementById('drawer');
  var drawerBody = document.getElementById('drawer-body');
  var drawerTitle = document.getElementById('drawer-title');
  var drawerFile = document.getElementById('drawer-file');
  var auto = document.getElementById('auto');
  var timer = null;

  var STATUS = { running: '运行中', stopped: '已停止', installed: '已安装', installing: '安装中', broken: '异常', failed: '失败' };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(message, bad) {
    toastEl.textContent = message;
    toastEl.className = bad ? 'toast bad' : 'toast';
    toastEl.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { toastEl.hidden = true; }, 3600);
  }

  function api(path, body) {
    var options = {};
    if (body !== undefined) {
      options.method = 'POST';
      options.headers = { 'content-type': 'application/json', 'x-pal-ui': '1' };
      options.body = JSON.stringify(body);
    }
    return fetch(path, options).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (err) { data = null; }
        if (!res.ok) {
          var error = new Error(data && data.error ? data.error : 'HTTP ' + res.status);
          error.data = data;
          throw error;
        }
        return data;
      });
    });
  }

  function copy(text) {
    function done() { toast('已复制：' + text); }
    function failed() { toast('复制失败，请手动选择命令：' + text, true); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, failed);
      return;
    }
    var area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (err) { failed(); }
    document.body.removeChild(area);
  }

  function load() {
    return api('/api/instances').then(function (data) {
      render(data && data.instances ? data.instances : []);
    }).catch(function (err) {
      renderError(err);
    });
  }

  function renderError(err) {
    listEl.textContent = '';
    var box = el('div', 'empty');
    box.appendChild(el('p', '', '连不上 PAL 启动器：' + err.message));
    box.appendChild(el('p', 'hint', '这个页面可能已经停了：回到终端看 pal ui 的输出。'));
    listEl.appendChild(box);
  }

  function render(instances) {
    listEl.textContent = '';
    if (!instances.length) {
      listEl.appendChild(emptyState());
      return;
    }
    for (var i = 0; i < instances.length; i += 1) listEl.appendChild(card(instances[i]));
  }

  function emptyState() {
    var box = el('div', 'empty');
    box.appendChild(el('p', '', '还没有 home。先装一个：'));
    var code = el('code', 'cmd', 'pal install <Pack 目录> --host dsh');
    code.title = '点击复制';
    code.addEventListener('click', function () { copy(code.textContent); });
    box.appendChild(code);
    box.appendChild(el('p', 'hint', '第一版不提供安装表单：装完在终端里刷新这个页面。'));
    return box;
  }

  function card(inst) {
    var wrap = el('article', 'card');
    var head = el('div', 'card-head');
    head.appendChild(el('h2', 'name', inst.name));
    head.appendChild(el('span', 'host', inst.harness));
    if (inst.pack && inst.pack.name) {
      head.appendChild(el('span', 'pack', inst.pack.name + '@' + inst.pack.version));
    }
    var badges = el('div', 'badges');
    badges.appendChild(el('span', 'badge ' + (inst.status === 'running' ? 'run' : 'idle'), STATUS[inst.status] || inst.status));
    if (inst.attached) badges.appendChild(el('span', 'badge attached', 'attached'));
    head.appendChild(badges);
    wrap.appendChild(head);

    var running = inst.status === 'running';
    var modes = el('div', 'modes');
    for (var i = 0; i < inst.modes.length; i += 1) modes.appendChild(modeButton(inst, inst.modes[i], running));
    if (inst.modes.length === 0) modes.appendChild(el('span', 'hint', '这个宿主没有可启动的模式'));
    wrap.appendChild(modes);

    var meta = el('div', 'meta');
    if (inst.pid) meta.appendChild(el('span', '', 'pid ' + inst.pid));
    if (inst.port) meta.appendChild(el('span', '', '端口 ' + inst.port));
    if (inst.url && /^https?:\\/\\//i.test(inst.url)) {
      var link = el('a', 'open', '打开页面');
      link.href = inst.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      meta.appendChild(link);
    }
    if (running) {
      var stop = el('button', 'danger', '停止');
      stop.addEventListener('click', function () { stopInstance(inst); });
      meta.appendChild(stop);
    }
    var logs = el('button', '', '日志');
    logs.addEventListener('click', function () { openLogs(inst); });
    meta.appendChild(logs);
    wrap.appendChild(meta);
    return wrap;
  }

  function modeButton(inst, mode, running) {
    var node;
    if (mode.kind === 'foreground') {
      node = el('button', '', '需终端');
      node.title = '前台模式在终端里跑：点按钮或下面的命令复制';
    } else {
      node = el('button', '', mode.kind === 'app' ? '启动 App' : '启动 ' + mode.label);
    }
    if (!mode.available) {
      node.disabled = true;
      node.title = mode.reason || '当前 home 上不可用';
    } else if (running && mode.kind !== 'foreground') {
      node.disabled = true;
      node.title = '已在运行，先停止';
    } else if (mode.kind === 'foreground') {
      node.addEventListener('click', function () { copy(mode.command || ''); });
      var holder = el('span', 'mode-pair');
      holder.appendChild(node);
      var code = el('code', 'cmd', mode.command || '');
      code.title = '点击复制';
      code.addEventListener('click', function () { copy(mode.command || ''); });
      holder.appendChild(code);
      return holder;
    } else {
      node.addEventListener('click', function () { startInstance(inst, mode); });
    }
    return node;
  }

  function startInstance(inst, mode) {
    toast('正在启动 ' + inst.name + '（' + mode.id + '）…');
    api('/api/start', { id: inst.id, mode: mode.id }).then(function () {
      return load();
    }).catch(function (err) {
      var data = err.data || {};
      if (data.command) {
        copy(data.command);
        toast(err.message, true);
      } else {
        toast(err.message, true);
      }
      return load();
    });
  }

  function stopInstance(inst) {
    toast('正在停止 ' + inst.name + '…');
    api('/api/stop', { id: inst.id }).then(function () {
      toast('已停止 ' + inst.name);
      return load();
    }).catch(function (err) {
      toast(err.message, true);
      return load();
    });
  }

  function openLogs(inst) {
    drawer.hidden = false;
    drawerTitle.textContent = '日志 · ' + inst.name;
    drawerFile.textContent = '';
    // 日志用 textContent 写进 <pre>：宿主输出里的标签不会被当成 HTML
    drawerBody.textContent = '读取中…';
    api('/api/logs?id=' + encodeURIComponent(inst.id) + '&tail=200').then(function (data) {
      drawerFile.textContent = data.file || '';
      drawerBody.textContent = data.lines && data.lines.length ? data.lines.join('\\n') : '还没有日志';
    }).catch(function (err) {
      drawerBody.textContent = '读日志失败：' + err.message;
    });
  }

  function schedule() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (auto.checked) {
      timer = setInterval(function () { load(); }, 2000);
    }
  }

  document.getElementById('refresh').addEventListener('click', function () { load(); });
  document.getElementById('drawer-close').addEventListener('click', function () { drawer.hidden = true; });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') drawer.hidden = true;
  });
  auto.addEventListener('change', schedule);

  load();
  schedule();
})();
</script>
</body>
</html>
`;
