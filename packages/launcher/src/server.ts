import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import {
  createInstance,
  listInstances,
  readInstance,
  removeInstance,
  requireInstance,
  scanInstances,
  updateInstance,
} from './index.ts';
import { restartInstance, startInstance, statusView, stopInstance } from './start.ts';
import { activeEntries, setActive, readActive } from './active.ts';
import { materializePack } from './materialize.ts';
import { readIndex, resolveRegistry } from '@packhub/runtime';
import { PalError, errorBody } from './errors.ts';
import { discoverAll } from './harness.ts';
import { readEvents, readLog } from './logs.ts';
import { readSecrets, redactText, withSecrets } from './secrets.ts';
import { checkInstance } from './health.ts';
import { readdirSync } from 'node:fs';

const HERE = dirname(resolve(process.argv[1] ?? '.'));

/** 发布时 web 在 runtime/../web；源码跑在 src/../web；测试从仓库根找不到前两者就回落仓库路径。 */
function resolveWebRoot(): string {
  if (process.env.PAL_WEB_ROOT) return process.env.PAL_WEB_ROOT;
  const candidates = [join(HERE, '..', 'web'), join(process.cwd(), 'packages', 'launcher', 'web')];
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? candidates[0]!;
}

const WEB_ROOT = resolveWebRoot();

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** 界面对每个写请求都带这个头：跨源表单发不出来，等于给本地服务加了一道 CSRF 闸。 */
const CLIENT_HEADER = 'x-pal-client';
const CLIENT_VALUE = 'pal-ui';

/**
 * 浏览器凭据（B14）：起服务时随机生成，只有从 index.html 里读得到。
 * 只对“带 Origin 的请求”校验——本机进程直连（CLI / curl / 测试）没有 Origin，照旧放行，
 * 威胁模型只针对浏览器页面，不是全量鉴权。
 */
const TOKEN_HEADER = 'x-pal-token';
/** index.html 里的占位符；serveStatic 出首页时替换成真 token。 */
const TOKEN_PLACEHOLDER = '__PAL_TOKEN__';

/** 32 位小写 hex（16 字节），够长也方便按形状校验。 */
function createToken(): string {
  return randomBytes(16).toString('hex');
}

/** 定长比较，别把 token 逐字节的差异暴露成时序。 */
function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Node 的头值可能是数组；只认第一个字符串并去掉空白。 */
function headerText(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

export interface ServeOptions {
  port?: number;
  host?: string;
  /** 关掉来源校验（只有测试与显式调试用） */
  insecure?: boolean;
}

export interface PalServer {
  url: string;
  /** 本机调用方的凭据：浏览器页面从 index.html 的 meta 里拿，测试直接从这里拿。 */
  token: string;
  close: () => Promise<void>;
}

/** 本地操作面：实例、宿主、包索引、健康检查、日志。只绑回环。 */
export async function startPalServer(opts: ServeOptions = {}): Promise<PalServer> {
  const host = opts.host ?? '127.0.0.1';
  const insecure = opts.insecure ?? process.env.PAL_INSECURE === '1';
  const token = createToken();
  const server: Server = createServer((req, res) => {
    handle(req, res, insecure, token).catch((err: unknown) => {
      const body = errorBody(err);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, body.status, body);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);
  const url = `http://${host}:${port}/`;

  return {
    url,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * 来源校验：本地服务不接受别的站点发起的写请求。
 * 浏览器跨源请求一定带 Origin，所以比对 Origin 与 Host 就够了；再叠一个自定义头，
 * 让跨源的简单表单（不带 Origin 也能发）也进不来。
 *
 * B14 追加：带 Origin 的请求还必须带 index.html 里注入的 x-pal-token（浏览器读不到别的页面）。
 * 不带 Origin 的请求（CLI、curl、测试、本机脚本）跳过 token 校验——只挡浏览器，不做全量鉴权。
 */
export function isTrustedRequest(
  req: IncomingMessage,
  mutating: boolean,
  token: string,
): { ok: boolean; reason?: string } {
  const host = req.headers.host ?? '';
  const origin = req.headers.origin;
  const fromBrowser = typeof origin === 'string' && origin.length > 0;
  if (fromBrowser) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, reason: 'Origin 不是合法地址' };
    }
    if (originHost !== host) return { ok: false, reason: `跨源请求被拒绝：${origin}` };
    const supplied = headerText(req.headers[TOKEN_HEADER]);
    if (!supplied) {
      return { ok: false, reason: `带 Origin 的请求缺少 ${TOKEN_HEADER} 头` };
    }
    if (!token || !sameToken(supplied, token)) {
      return { ok: false, reason: `${TOKEN_HEADER} 不对` };
    }
  }
  if (mutating) {
    const marker = req.headers[CLIENT_HEADER];
    if (marker !== CLIENT_VALUE) {
      return { ok: false, reason: `缺少 ${CLIENT_HEADER} 头` };
    }
  }
  return { ok: true };
}

async function handle(req: IncomingMessage, res: ServerResponse, insecure: boolean, token: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';

  if (!insecure) {
    const trusted = isTrustedRequest(req, mutating, token);
    if (!trusted.ok) {
      throw new PalError('forbidden', trusted.reason ?? '不受信任的请求', {
        hint: `请从 PAL 的界面操作；浏览器请求需要页面里的 ${TOKEN_HEADER}（刷新界面会重新注入）`,
      });
    }
  }

  if (path === '/api/meta' && req.method === 'GET') {
    sendJson(res, 200, { name: 'pal', apiVersion: 'packhub.dev/pal/v0', webRoot: WEB_ROOT });
    return;
  }

  if (path === '/api/harnesses' && req.method === 'GET') {
    const probe = url.searchParams.get('probe') !== '0';
    sendJson(
      res,
      200,
      discoverAll({ probeVersion: probe }).map((info) => ({
        id: info.id,
        label: info.label,
        kind: info.kind,
        available: info.available,
        startable: info.startable,
        ...(info.version ? { version: info.version } : {}),
        ...(info.commandPath ? { commandPath: info.commandPath } : {}),
        ...(info.reason ? { reason: info.reason } : {}),
        ...(info.probeError ? { probeError: info.probeError } : {}),
      })),
    );
    return;
  }

  if (path === '/api/instances' && req.method === 'GET') {
    const scan = scanInstances();
    const active = readActive();
    sendJson(res, 200, {
      // 读列表只给计算出来的状态视图：不写 instance.json，也不隔离坏记录
      instances: statusView(scan.records).map((rec) => ({ ...rec, url: rec.url ?? null })),
      broken: scan.broken.map((bad) => ({ dir: bad.dir, reason: bad.reason })),
      active,
    });
    return;
  }

  if (path === '/api/instances' && req.method === 'POST') {
    const body = await readJson(req);
    const pack = String(body.pack ?? '').trim();
    const name = String(body.name ?? '').trim();
    const harness = String(body.harness ?? 'dir');
    if (!pack || !name) throw new PalError('invalid-input', 'pack 与 name 必填');
    const packDir = await materializePack(pack, {
      ...(body.index ? { index: String(body.index) } : {}),
      ...(body.version ? { version: String(body.version) } : {}),
    });
    const rec = await createInstance({
      name,
      harness: harness as never,
      packDir,
      packRef: pack,
      ...(body.fromHome ? { seedFrom: String(body.fromHome) } : {}),
    });
    sendJson(res, 200, rec);
    return;
  }

  const match = /^\/api\/instances\/([^/]+)(?:\/(start|stop|restart|update|active|logs|health|open))?$/.exec(path);
  if (match) {
    const id = decodeURIComponent(match[1]!);
    const action = match[2];
    if (!action && req.method === 'GET') {
      sendJson(res, 200, requireInstance(id));
      return;
    }
    if (!action && req.method === 'DELETE') {
      const keepData = url.searchParams.get('keepData') === '1';
      const result = await removeInstance(id, { keepData });
      sendJson(res, 200, result);
      return;
    }
    if (action === 'start' && req.method === 'POST') {
      sendJson(res, 200, await startInstance(id, { supervise: true }));
      return;
    }
    if (action === 'restart' && req.method === 'POST') {
      sendJson(res, 200, await restartInstance(id, { supervise: true }));
      return;
    }
    if (action === 'update' && req.method === 'POST') {
      const body = await readJson(req);
      const rec = requireInstance(id);
      const ref = rec.pack.ref ?? rec.pack.name;
      const packDir = await materializePack(ref, {
        ...(body.index ? { index: String(body.index) } : {}),
        ...(body.version ? { version: String(body.version) } : {}),
      });
      sendJson(
        res,
        200,
        await updateInstance(id, {
          packDir,
          packRef: ref,
          // 默认不覆盖本地改动；这边接受 body.force（同 CLI 的 --force），当前界面还没有强制入口
          ...(body.force === true || body.force === 'true' ? { force: true } : {}),
        }),
      );
      return;
    }
    if (action === 'stop' && req.method === 'POST') {
      sendJson(res, 200, await stopInstance(id));
      return;
    }
    if (action === 'active' && req.method === 'POST') {
      sendJson(res, 200, setActive(id));
      return;
    }
    if (action === 'health' && req.method === 'GET') {
      sendJson(res, 200, await checkInstance(id));
      return;
    }
    if (action === 'logs' && req.method === 'GET') {
      const rec = requireInstance(id);
      const file = url.searchParams.get('file') ?? undefined;
      const log = readLog(rec.root, file ? { file } : {});
      sendJson(res, 200, { ...log, text: redactText(log.text), events: readEvents(rec.root, 30) });
      return;
    }
    if (action === 'open' && (req.method === 'GET' || req.method === 'HEAD')) {
      // 浏览器直接导航：把凭据拼在服务端，页面与 API 都看不到 token
      const site = req.headers['sec-fetch-site'];
      if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
        throw new PalError('forbidden', '只接受从本页发起的打开请求');
      }
      const rec = requireInstance(id);
      if (!rec.url) {
        throw new PalError('not-running', `实例没有地址：${rec.name}`, { hint: '先启动它' });
      }
      const target = withSecrets(rec.url, readSecrets(rec.root));
      res.writeHead(302, { location: target, 'cache-control': 'no-store' });
      res.end();
      return;
    }
  }

  if (path === '/api/active' && req.method === 'GET') {
    sendJson(res, 200, activeEntries().map((entry) => ({ harness: entry.harness, id: entry.record?.id ?? null })));
    return;
  }

  if (path === '/api/packs' && req.method === 'GET') {
    const local = listLocalPacks();
    const index = resolveRegistry(url.searchParams.get('index') ?? undefined);
    if (!index) {
      sendJson(res, 200, { index: null, packs: [], local });
      return;
    }
    try {
      const data = await readIndex(index);
      sendJson(res, 200, {
        index,
        local,
        packs: data.packs.map((pack) => ({
          name: pack.name,
          latest: pack.latest,
          title: pack.title ?? '',
          versions: pack.versions ?? [],
          ...(pack.description ? { description: pack.description } : {}),
        })),
      });
    } catch (err) {
      throw new PalError('internal', `读不了索引：${(err as Error).message}`, { cause: err });
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(path, res, token);
    return;
  }

  throw new PalError('not-found', '没有这个接口');
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/** 单次请求体上限；超过就丢弃，但把剩余请求体读完再报错。 */
const MAX_BODY = 1_000_000;
/** 超限后最多再读这么多字节，防止客户端拿超大 body 拖着不放手。 */
const MAX_DRAIN = 4_000_000;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) {
      // 不在这里直接抛：客户端还在写，提前断开会让它挂到超时。
      // 先把请求体读空（有上限），再让上层回 400。
      tooLarge = true;
      chunks.length = 0;
      if (size > MAX_DRAIN) {
        req.destroy();
        break;
      }
      continue;
    }
    chunks.push(buf);
  }
  if (tooLarge) throw new PalError('invalid-input', '请求太大');
  if (chunks.length === 0) return {};
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    throw new PalError('invalid-input', '请求体不是合法 JSON');
  }
}

/**
 * 把 URL 路径变成 WEB_ROOT 内的相对路径；含 `..` 段（含百分号编码、反斜杠）一律拒绝。
 * 返回 null 表示非法路径，直接 404。
 */
function staticRelPath(path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const segments = decoded.split(/[\\/]+/).filter((seg) => seg.length > 0 && seg !== '.');
  if (segments.length === 0 || segments.some((seg) => seg === '..')) return null;
  return segments.join('/');
}

function serveStatic(path: string, res: ServerResponse, token: string): void {
  const root = resolve(WEB_ROOT);
  const rel = path === '/' ? 'index.html' : staticRelPath(path);
  const file = rel === null ? null : resolve(root, rel);
  // 注意带分隔符：只按字符串前缀比会让 web2 这种同前缀的兄弟目录混进来
  const inside = file !== null && (file === root || file.startsWith(root + sep));
  if (!inside || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  // 只有首页带凭据：其它资源原样吐，也避免把 token 铺到每个静态文件上
  if (rel !== 'index.html') {
    res.writeHead(200, { 'content-type': type });
    res.end(readFileSync(file));
    return;
  }
  // token 每次启动都换：首页不能进缓存，否则刷新后界面还拿着旧 token，写请求会全 403
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(readFileSync(file, 'utf8').split(TOKEN_PLACEHOLDER).join(token));
}

/** 界面上「包列表」用：不连索引也能列出本地 Pack 目录。 */
export function listLocalPacks(): string[] {
  const dirs = ['examples', 'registry/packs'];
  const out: string[] = [];
  for (const dir of dirs) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(dir, entry.name, 'packhub.yaml'))) {
          out.push(join(dir, entry.name));
        }
      }
    } catch {
      /* 没有这个目录就算了 */
    }
  }
  return out;
}
