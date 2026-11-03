import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, parseManifest, validateGraph, type TargetId } from '@packhub/kernel';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

export interface HubAuth {
  /** 静态 token；客户端用 Authorization: Bearer <token> 或 x-packhub-token */
  token?: string;
  /** 反向代理注入的身份头（例如 X-Forwarded-User）；配了就认它，不再要求 token */
  userHeader?: string;
}

export interface HubOptions {
  /** 仓库根（registry 在它下面） */
  root: string;
  port: number;
  /** 默认 127.0.0.1；非回环地址必须配 auth，否则拒绝启动 */
  host?: string;
  staticDir?: string;
  auth?: HubAuth;
  /** 审计日志：每次请求一行 JSON（谁、何时、取了什么） */
  auditFile?: string;
  /** 每 IP 每分钟请求上限，默认 240；0 表示不限流 */
  rpm?: number;
}

/** web 构建产物默认位置（packages/web/dist）。 */
export function defaultStaticDir(): string {
  return fileURLToPath(new URL('../../web/dist/', import.meta.url));
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * 只读的发布端：索引、包页数据、计划预览。
 * 这里没有 install / verify —— 执行永远发生在目标机器上。
 * 对外监听必须带 auth，否则启动即失败（fail-closed）。
 */
export function startHub(opts: HubOptions): Promise<Server> {
  const root = resolve(opts.root);
  const staticDir = opts.staticDir ? resolve(opts.staticDir) : undefined;
  const host = opts.host ?? '127.0.0.1';
  const token = opts.auth?.token ?? process.env.PACKHUB_HUB_TOKEN;
  const userHeader = opts.auth?.userHeader;

  if (!LOOPBACK.has(host) && !token && !userHeader) {
    throw new Error(
      `拒绝在 ${host} 上无鉴权启动：对外监听必须配 --token（或 PACKHUB_HUB_TOKEN / --user-header）`,
    );
  }

  const limiter = new RateLimiter(opts.rpm ?? 240);
  const startedAt = Date.now();

  const server = createServer(async (req, res) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

    if (!limiter.take(ip)) {
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60' });
      res.end(JSON.stringify({ error: '请求太频繁' }));
      return;
    }

    const user = userHeader ? String(req.headers[userHeader.toLowerCase()] ?? '') : '';
    const isHealth = url.pathname === '/api/health';
    if (!isHealth && (token || userHeader)) {
      const ok = userHeader
        ? Boolean(user)
        : `${req.headers.authorization ?? ''}`.replace(/^Bearer\s+/i, '') === token ||
          req.headers['x-packhub-token'] === token;
      if (!ok) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '需要鉴权' }));
        audit(opts.auditFile, { ip, user, method: req.method, path: url.pathname, status: 401 });
        return;
      }
    }

    res.on('finish', () => {
      audit(opts.auditFile, {
        ip,
        user: user || undefined,
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
      });
    });

    try {
      if (isHealth) {
        return sendJson(res, 200, {
          ok: true,
          packs: countPacks(root),
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        });
      }

      if (url.pathname.startsWith('/api/')) {
        return await handleApi(url, req, res, root);
      }

      if (staticDir && existsSync(staticDir)) {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = resolve(staticDir, rel);
        if (file === staticDir || file.startsWith(staticDir + sep)) {
          if (existsSync(file) && statSync(file).isFile()) {
            res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
            res.end(readFileSync(file));
            return;
          }
          const index = join(staticDir, 'index.html');
          if (existsSync(index)) {
            res.writeHead(200, { 'content-type': MIME['.html']! });
            res.end(readFileSync(index));
            return;
          }
        }
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404：Hub 只有只读接口（/api/health、/api/registry、/api/registry/pack、/api/plan）');
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  });

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port, host, () => {
      log({ event: 'hub.start', host, port: (server.address() as { port: number }).port, auth: Boolean(token || userHeader) });
      ok(server);
    });
  });
}

class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  private readonly perMinute: number;

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  take(ip: string): boolean {
    if (this.perMinute <= 0) return true;
    const now = Date.now();
    const entry = this.hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    entry.count++;
    return entry.count <= this.perMinute;
  }
}

function countPacks(root: string): number {
  try {
    const idx = JSON.parse(readFileSync(join(root, 'registry/index.json'), 'utf8')) as {
      packs?: unknown[];
    };
    return idx.packs?.length ?? 0;
  } catch {
    return 0;
  }
}

function audit(file: string | undefined, entry: Record<string, unknown>): void {
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {
    /* 审计写失败不影响响应 */
  }
}

function log(entry: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

async function handleApi(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
): Promise<void> {
  if (url.pathname === '/api/registry' && req.method === 'GET') {
    const file = join(root, 'registry/index.json');
    if (!existsSync(file)) return sendJson(res, 404, { error: '这个仓库还没有 registry/index.json' });
    return sendJson(res, 200, JSON.parse(readFileSync(file, 'utf8')));
  }

  if (url.pathname === '/api/registry/pack' && req.method === 'GET') {
    const name = url.searchParams.get('name') ?? '';
    let version = url.searchParams.get('version') ?? '';
    if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(name)) {
      return sendJson(res, 400, { error: 'name 不合法' });
    }
    if (!version) {
      const idxPath = join(root, 'registry/index.json');
      if (!existsSync(idxPath)) return sendJson(res, 404, { error: '没有索引' });
      const idx = JSON.parse(readFileSync(idxPath, 'utf8')) as {
        packs?: { name: string; latest: string }[];
      };
      version = idx.packs?.find((x) => x.name === name)?.latest ?? '';
    }
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      return sendJson(res, 404, { error: '没有这个版本' });
    }
    const dir = join(root, 'registry/packs', name, version);
    if (!existsSync(join(dir, 'packhub.yaml'))) {
      return sendJson(res, 404, { error: '没有这个版本' });
    }
    return sendJson(res, 200, {
      name,
      version,
      manifest: readFileSync(join(dir, 'packhub.yaml'), 'utf8'),
      lock: readJson(join(dir, 'packhub.lock.json')),
      verify: readJson(join(dir, 'verify.json')),
    });
  }

  if (url.pathname === '/api/plan' && req.method === 'POST') {
    const body = await readBody(req);
    const text = String(body.manifest ?? '');
    if (!text.trim()) return sendJson(res, 400, { error: 'manifest 为空' });
    const parsed = parseManifest(text, '<draft>');
    if (!parsed.manifest) return sendJson(res, 200, { issues: parsed.issues, plan: null });
    const { graph, issues } = validateGraph(parsed.manifest);
    const errors = [...parsed.issues, ...issues].filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      return sendJson(res, 200, { issues: [...parsed.issues, ...issues], plan: null });
    }
    const { plan, issues: planIssues } = buildPlan(parsed.manifest, graph, {
      target: (String(body.target ?? 'dir') as TargetId) || 'dir',
      targetVars: {},
      packDir: root,
    });
    return sendJson(res, 200, { issues: planIssues, plan: plan ?? null });
  }

  return sendJson(res, 404, { error: `未知接口：${url.pathname}` });
}

function readJson(file: string): unknown {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
