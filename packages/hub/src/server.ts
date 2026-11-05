import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, parseManifest, validateGraph, type TargetId } from '@packhub/kernel';
import { collectPackResources } from './resources.ts';

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
        return sendJson(req, res, 200, {
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
            sendFile(req, res, file);
            return;
          }
          const index = join(staticDir, 'index.html');
          if (existsSync(index)) {
            sendFile(req, res, index);
            return;
          }
        }
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404：Hub 只有只读接口（/api/health、/api/registry、/api/registry/pack、/api/plan）');
    } catch (err) {
      const message = (err as Error).message;
      sendJson(req, res, message.includes('超过 1 MB') ? 413 : 500, { error: message });
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
    if (!existsSync(file)) return sendJson(req, res, 404, { error: '这个仓库还没有 registry/index.json' });
    return sendJson(req, res, 200, JSON.parse(readFileSync(file, 'utf8')), 'public, max-age=30, must-revalidate');
  }

  if (url.pathname === '/api/registry/pack' && req.method === 'GET') {
    const name = url.searchParams.get('name') ?? '';
    let version = url.searchParams.get('version') ?? '';
    if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(name)) {
      return sendJson(req, res, 400, { error: 'name 不合法' });
    }
    if (!version) {
      const idxPath = join(root, 'registry/index.json');
      if (!existsSync(idxPath)) return sendJson(req, res, 404, { error: '没有索引' });
      const idx = JSON.parse(readFileSync(idxPath, 'utf8')) as {
        packs?: { name: string; latest: string }[];
      };
      version = idx.packs?.find((x) => x.name === name)?.latest ?? '';
    }
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      return sendJson(req, res, 404, { error: '没有这个版本' });
    }
    const dir = join(root, 'registry/packs', name, version);
    if (!existsSync(join(dir, 'packhub.yaml'))) {
      return sendJson(req, res, 404, { error: '没有这个版本' });
    }
    const manifestText = readFileSync(join(dir, 'packhub.yaml'), 'utf8');
    const parsed = parseManifest(manifestText, join(dir, 'packhub.yaml'));
    const m = parsed.manifest?.metadata;
    return sendJson(
      req,
      res,
      200,
      {
        name,
        version,
        manifest: manifestText,
        // 解析后的元数据：页面不用在浏览器里再引一个 YAML 库
        metadata: m
          ? {
              name: m.name,
              version: m.version,
              title: m.title ?? m.name,
              description: m.description ?? '',
              license: m.license ?? null,
              homepage: m.homepage ?? null,
              authors: m.authors ?? [],
              keywords: m.keywords ?? [],
              targets: m.targets,
              visibility: m.visibility ?? 'private',
              requiresAgent: parsed.manifest?.requires?.agent ?? null,
            }
          : null,
        lock: readJson(join(dir, 'packhub.lock.json')),
        verify: readJson(join(dir, 'verify.json')),
        // 包说明与变更记录：原文返回，页面自己排
        readme: existsSync(join(dir, 'PACK.md')) ? readFileSync(join(dir, 'PACK.md'), 'utf8') : null,
        changelog: existsSync(join(dir, 'CHANGELOG.md'))
          ? readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
          : null,
      },
      'public, max-age=300, must-revalidate',
    );
  }

  if (url.pathname === '/api/registry/resources' && req.method === 'GET') {
    const name = url.searchParams.get('name') ?? '';
    const version = url.searchParams.get('version') ?? undefined;
    const result = collectPackResources(root, name, version);
    if (!result) return sendJson(req, res, 404, { error: '没有这个包或版本' });
    return sendJson(req, res, 200, result);
  }

  if (url.pathname === '/api/plan' && req.method === 'POST') {
    const body = await readBody(req);
    const text = String(body.manifest ?? '');
    if (!text.trim()) return sendJson(req, res, 400, { error: 'manifest 为空' });
    const parsed = parseManifest(text, '<draft>');
    if (!parsed.manifest) return sendJson(req, res, 200, { issues: parsed.issues, plan: null });
    const { graph, issues } = validateGraph(parsed.manifest);
    const errors = [...parsed.issues, ...issues].filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      return sendJson(req, res, 200, { issues: [...parsed.issues, ...issues], plan: null });
    }
    const { plan, issues: planIssues } = buildPlan(parsed.manifest, graph, {
      target: (String(body.target ?? 'dir') as TargetId) || 'dir',
      targetVars: {},
      packDir: root,
    });
    return sendJson(req, res, 200, { issues: planIssues, plan: plan ?? null });
  }

  return sendJson(req, res, 404, { error: `未知接口：${url.pathname}` });
}

function readJson(file: string): unknown {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new Error('请求体超过 1 MB');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string): void {
  const stat = statSync(file);
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const isHtml = extname(file).toLowerCase() === '.html';
  const cache = isHtml ? 'no-cache' : 'public, max-age=300, must-revalidate';
  const headers = {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': cache,
    etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  res.end(readFileSync(file));
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  cacheControl = 'no-store',
): void {
  const text = JSON.stringify(body);
  const etag = `"${createHash('sha1').update(text).digest('hex')}"`;
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cacheControl,
    etag,
  };
  // 条件请求：读方带 If-None-Match 且内容没变时回 304，不重复传索引
  if (status === 200 && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(status, headers);
  res.end(text);
}
