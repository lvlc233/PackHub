// `pal ui` 的服务端：本地 HTTP + 单页 HTML。
//
// 边界（见 decisions「pal ui」）：
// - 只绑 127.0.0.1，不是给局域网用的；
// - 读/写实例都走现有模块（coreCall / startAppInstance / stopInstance / 记录扫描），这里不另造一套启停；
// - 安装 / 更新 / 回滚 / 验证 / 卸载 / 删除 / 体检都不在 UI 里重写：spawn 同一条 pal 命令（见 uiSpawn.ts），
//   只把 stdout / stderr / 退出码转给页面；
// - POST 要求 `content-type: application/json` + `x-pal-ui: 1`（页面自己带），挡掉别的网页顺手 POST 127.0.0.1；
// - 页面不用框架、不引 CDN，动态内容只在 JS 里用 textContent / 属性赋值，不拼 HTML 字符串。
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { harnesses, type LaunchMode } from '@packhub/kernel';
import { scanInstances } from './catalog.ts';
import { coreCall } from './coreClient.ts';
import { defaultHomeName } from './create.ts';
import { errorBody, PalError } from './errors.ts';
import { adapterFor } from './layout.ts';
import { availabilityOf, resolveLaunchMode, unavailableReason } from './launchModes.ts';
import { readLog } from './logs.ts';
import type { InstanceRecord } from './records.ts';
import { resolveStartProfile } from './startProfile.ts';
import { startAppInstance } from './startApp.ts';
import { logFileOf, statusView, stopInstance } from './start.ts';
import { PAGE_HTML } from './uiPage.ts';
import {
  ACTION_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
  foregroundCommand as palRunCommand,
  homeActionArgs,
  homeActionTimeout,
  installArgs,
  isHomeAction,
  openTerminalWindow,
  parseInstallRequest,
  runPalCommand,
  type HomeAction,
  type InstallRequest,
  type PalRunner,
  type TerminalOpener,
} from './uiSpawn.ts';

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
  managed: boolean;
  attached: boolean;
  root: string;
  home: string | null;
  profile: string | null;
  launchMode: string | null;
  url: string | null;
  port: number | null;
  pid: number | null;
  modes: UiMode[];
}

/** `GET /api/hosts` 的一条宿主：安装表单的动态选项（宿主名单与模式都来自 kernel 注册表）。 */
export interface UiHost {
  id: string;
  label: string;
  /** 支持 attached home（装进宿主真实全局目录） */
  attached: boolean;
  /** 项目级落点：full / pointer / false（没有项目级落点） */
  project: 'full' | 'pointer' | false;
  modes: Array<{ id: string; label: string; kind: LaunchMode['kind']; default: boolean }>;
}

/** spawn 一条 pal 命令的通用回答：页面按 `ok` 决定红字，输出原样给出去。 */
export interface UiPalResponse {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** `POST /api/plan`：多一个解析出来的计划与最终名字（JSON 解析失败时只有原文）。 */
export interface UiPlanResponse extends UiPalResponse {
  plan?: unknown;
  name?: string;
}

/** `GET /api/health`：能解析就带 `json`，否则只有 `raw` 文本。 */
export interface UiHealthResponse {
  ok: boolean;
  code: number | null;
  json?: unknown;
  raw: string;
  stderr?: string;
  timedOut?: boolean;
}

/** `POST /api/terminal`：实际要跑的命令 + 起出来的窗口命令行。 */
export interface UiTerminalResponse {
  command: string;
  window: string;
}

export interface UiServerOptions {
  /** 0 = 让系统挑（默认）；只有 CLI 的 `--port` 会给出具体值 */
  port?: number;
  host?: string;
  /** 子进程边界（测试注入桩）；默认 spawn 当前进程的 pal 入口 */
  runPal?: PalRunner;
  /** 终端窗口（测试注入桩）；默认 wt.exe / cmd start / x-terminal-emulator */
  openTerminal?: TerminalOpener;
}

export interface UiServer {
  server: Server;
  url: string;
  port: number;
  /** 关掉监听；已建立的连接不等，直接断（页面会显示「连不上」）。 */
  close: () => Promise<void>;
}

/** 处理一条请求时要用的外部能力：测试可以整段替掉，不碰真进程。 */
interface UiContext {
  runPal: PalRunner;
  openTerminal: TerminalOpener;
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
      managed: rec.managed === true,
      attached: rec.attached === true,
      root: rec.root,
      home: rec.home ?? null,
      profile: rec.profile ?? null,
      launchMode: rec.launchMode ?? null,
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

/**
 * 宿主表：安装表单的宿主下拉与 attached / project 选项都从这里来。
 * 加宿主只改 kernel 的注册表，页面与服务端都不另抄一份名单。
 */
function hostsView(): { hosts: UiHost[] } {
  return {
    hosts: harnesses().map((spec) => {
      const defaultId = spec.defaultMode ?? spec.modes[0]?.id;
      return {
        id: spec.id,
        label: spec.label,
        attached: spec.attached === true,
        project: spec.project ?? 'full',
        modes: spec.modes.map((mode) => ({
          id: mode.id,
          label: mode.label,
          kind: mode.kind,
          default: mode.id === defaultId,
        })),
      };
    }),
  };
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

/* ---------- 安装 / 管理：spawn 同一条 pal 命令 ---------- */

/** 子进程工作目录：记录根还在就用它（pal 的命令按 cwd 解析相对路径），否则交回当前目录。 */
function cwdOf(rec: InstanceRecord): string | undefined {
  try {
    return existsSync(rec.root) ? rec.root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * home 级动作的 cwd。`remove` 例外：它连根删掉 `record.root`，Windows 上子进程的 cwd 在根里
 * 就删不掉（目录被握着），所以换一个中立目录；pal remove 只按记录里的绝对路径干活，不看 cwd。
 */
function actionCwd(rec: InstanceRecord, action: HomeAction): string | undefined {
  if (action === 'remove') return tmpdir();
  return cwdOf(rec);
}

/** 计划 JSON 只认 `{plan, name?}`；解析失败返回空对象，原文由调用方原样带出去。 */
function parsePlanJson(stdout: string): { plan?: unknown; name?: string } {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const record = data as Record<string, unknown>;
  const out: { plan?: unknown; name?: string } = {};
  if (record.plan && typeof record.plan === 'object') out.plan = record.plan;
  if (typeof record.name === 'string' && record.name.trim()) out.name = record.name.trim();
  return out;
}

/**
 * 最终名字：attached 的 dry-run JSON 自带（可能被自动改成 `<名字>-attached`）；
 * managed 的 JSON 没有名字，按 CLI 同一条规则用 `defaultHomeName(host, plan.pack.name)` 算；
 * 项目没有 home 名。
 */
function planName(request: InstallRequest, parsed: { plan?: unknown; name?: string }): string | undefined {
  if (parsed.name) return parsed.name;
  if (request.target === 'project') return undefined;
  if (request.name) return request.name;
  const plan = parsed.plan as { pack?: { name?: unknown } } | undefined;
  const packName = plan && plan.pack && typeof plan.pack.name === 'string' ? plan.pack.name : undefined;
  return packName ? defaultHomeName(request.host, packName) : undefined;
}

async function planInstall(body: Record<string, unknown>, ctx: UiContext): Promise<UiPlanResponse> {
  const request = parseInstallRequest(body);
  const result = await ctx.runPal(installArgs(request, { dryRun: true }), { timeoutMs: INSTALL_TIMEOUT_MS });
  const parsed = parsePlanJson(result.stdout);
  const name = planName(request, parsed);
  return {
    ok: result.code === 0,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(parsed.plan === undefined ? {} : { plan: parsed.plan }),
    ...(name === undefined ? {} : { name }),
  };
}

async function installFrom(body: Record<string, unknown>, ctx: UiContext): Promise<UiPalResponse> {
  const request = parseInstallRequest(body);
  const result = await ctx.runPal(installArgs(request), { timeoutMs: INSTALL_TIMEOUT_MS });
  return {
    ok: result.code === 0,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.timedOut ? { timedOut: true } : {}),
  };
}

async function homeActionOf(body: Record<string, unknown>, ctx: UiContext): Promise<UiPalResponse> {
  if (!isHomeAction(body.action)) {
    throw new PalError(
      'invalid-input',
      `action 只能是 update / rollback / verify / uninstall / remove，收到：${String(body.action ?? '')}`,
      { hint: '页面上的按钮各对应一条：更新 / 回滚 / 验证 / 卸载 / 删除' },
    );
  }
  const action: HomeAction = body.action;
  const rec = requireRecord(bodyId(body));
  const profile = typeof body.profile === 'string' ? body.profile.trim() : '';
  const result = await ctx.runPal(homeActionArgs(action, rec.id, profile || undefined), {
    cwd: actionCwd(rec, action),
    timeoutMs: homeActionTimeout(action),
  });
  return {
    ok: result.code === 0,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.timedOut ? { timedOut: true } : {}),
  };
}

async function healthOf(url: URL, ctx: UiContext): Promise<UiHealthResponse> {
  const id = (url.searchParams.get('id') ?? '').trim();
  if (!id) throw new PalError('invalid-input', '要 id：/api/health?id=<home>');
  const rec = requireRecord(id);
  const result = await ctx.runPal(['health', rec.id, '--json'], {
    cwd: cwdOf(rec),
    timeoutMs: ACTION_TIMEOUT_MS,
  });
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = undefined;
  }
  return {
    ok: result.code === 0,
    code: result.code,
    ...(json === undefined ? {} : { json }),
    raw: result.stdout,
    ...(result.stderr ? { stderr: result.stderr } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
  };
}

/**
 * 终端按钮：只对前台（TUI）模式开放。窗口里跑 `pal run <名字>`；
 * 返回实际命令与起出来的窗口命令行（Windows 上 wt.exe 不在就退回 cmd start）。
 */
async function terminalOf(body: Record<string, unknown>, ctx: UiContext): Promise<UiTerminalResponse> {
  const rec = requireRecord(bodyId(body));
  const mode = adapterFor(rec.harness)?.modes.find((item) => item.kind === 'foreground');
  if (!mode) {
    throw new PalError('invalid-input', `宿主 ${rec.harness} 没有前台模式，终端按钮只用于 TUI`, {
      hint: 'server / app 模式用「启动」按钮；前台模式（tui）才需要终端窗口',
    });
  }
  const command = palRunCommand(rec.name);
  const opened = await ctx.openTerminal({ command, title: `PAL · ${rec.name}` });
  return { command, window: opened.window };
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: UiContext): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://pal-ui');

  if (req.method === 'GET' && url.pathname === '/') {
    sendHtml(res, PAGE_HTML);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/instances') {
    sendJson(res, 200, { instances: instancesView(scanInstances().records) });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/hosts') {
    sendJson(res, 200, hostsView());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    sendJson(res, 200, logsOf(url));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, await healthOf(url, ctx));
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
  if (req.method === 'POST' && url.pathname === '/api/plan') {
    requireUiRequest(req);
    const body = await readJsonBody(req);
    sendJson(res, 200, await planInstall(body, ctx));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/install') {
    requireUiRequest(req);
    const body = await readJsonBody(req);
    sendJson(res, 200, await installFrom(body, ctx));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/home-action') {
    requireUiRequest(req);
    const body = await readJsonBody(req);
    sendJson(res, 200, await homeActionOf(body, ctx));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/terminal') {
    requireUiRequest(req);
    const body = await readJsonBody(req);
    sendJson(res, 200, await terminalOf(body, ctx));
    return;
  }
  throw new PalError('not-found', `pal ui 没有这个接口：${req.method} ${url.pathname}`, {
    hint:
      '页面用的接口：GET / /api/instances /api/hosts /api/logs /api/health，' +
      'POST /api/start /api/stop /api/plan /api/install /api/home-action /api/terminal',
  });
}

/**
 * 起 UI 服务：只绑 127.0.0.1，端口 0 = 系统挑。
 * 它是前台进程的一部分（`pal ui` 阻塞到 Ctrl+C），生命周期与 core 无关：关掉它不动实例，也不停 core。
 */
export async function startUiServer(options: UiServerOptions = {}): Promise<UiServer> {
  const host = options.host ?? '127.0.0.1';
  const ctx: UiContext = {
    runPal: options.runPal ?? ((args, opts) => runPalCommand(args, opts)),
    openTerminal: options.openTerminal ?? openTerminalWindow,
  };
  const server = createServer((req, res) => {
    handle(req, res, ctx).catch((err: unknown) => {
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
