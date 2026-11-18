import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  INDEX_API_VERSION,
  LOCK_FILE,
  MANIFEST_FILE,
  PACKHUB_ENV,
  PACK_NAME_PATTERN,
  PACK_VERSION_PATTERN,
  TARGET_IDS,
  isTargetId,
  parseManifest,
  planFor,
  validateGraph,
  type PackContext,
} from '@packhub/kernel';
import { collectPackResources } from './resources.ts';

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
  auth?: HubAuth;
  /** 审计日志：每次请求一行 JSON（谁、何时、取了什么） */
  auditFile?: string;
  /** 每 IP 每分钟请求上限，默认 240；0 表示不限流 */
  rpm?: number;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * 客户端输入造成的错误：状态码、对外文案与 code 都是显式给的。
 * 顶层 catch 只认这个类型；别的异常一律当服务器内部问题，原文不进响应。
 */
class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 只读发布端：索引、包/资源数据与计划预览。没有执行接口。
 * 静态页面已移除（2026-11-07），这里只剩 /api/*。
 * 对外监听必须带 auth，否则启动即失败（fail-closed）。
 */
export function startHub(opts: HubOptions): Promise<Server> {
  const root = resolve(opts.root);
  const host = opts.host ?? '127.0.0.1';
  const token = opts.auth?.token ?? process.env[PACKHUB_ENV.hubToken];
  const userHeader = opts.auth?.userHeader;

  if (!LOOPBACK.has(host) && !token && !userHeader) {
    throw new Error(
      `拒绝在 ${host} 上无鉴权启动：对外监听必须配 --token（或 ${PACKHUB_ENV.hubToken} / --user-header）`,
    );
  }

  const limiter = new RateLimiter(opts.rpm ?? 240);
  const startedAt = Date.now();
  // /api/plan 收到的是一份清单文本，不是服务器上的 Pack 目录。给一个不存在的唯一路径当 packDir：
  // 清单里 `context: ./x`、`modify.with: ./x`、`modify.at` 都会走 kernel 现成的「文件不存在」issue，
  // 而不是把 Hub 机器上的文件读进响应。不建这个目录：建了的话 `context: ./` 会 resolve 到目录本身，
  // readFileSync 抛 EISDIR，反而变成内部错误。
  const planPackDir = join(tmpdir(), `packhub-hub-plan-${randomUUID()}`);

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
        return await handleApi(url, req, res, root, planPackDir);
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404：Hub 只有只读接口（/api/health、/api/registry、/api/registry/pack、/api/plan）');
    } catch (err) {
      // 客户端输入的错（太大、不是 JSON）按 code 映射；其余是服务器自己的问题：
      // 原文（解析器报错、带盘符的路径）只进日志，不交给客户端。
      if (err instanceof HttpError) {
        return sendJson(req, res, err.status, { error: err.message, code: err.code });
      }
      log({ event: 'hub.error', path: url.pathname, message: (err as Error).message });
      sendJson(req, res, 500, { error: 'Hub 内部错误' });
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
  /** 计划预览用的 Pack 目录：一个不存在的路径，保证读不到服务器文件 */
  planPackDir: string,
): Promise<void> {
  if (url.pathname === '/api/registry' && req.method === 'GET') {
    const file = join(root, 'registry/index.json');
    if (!existsSync(file)) return sendJson(req, res, 404, { error: '这个仓库还没有 registry/index.json' });
    const index = JSON.parse(readFileSync(file, 'utf8')) as { apiVersion?: unknown };
    // 索引是发布流水线写下的数据，不是本服务现算的：apiVersion 不认识就说明这份索引不是
    // 当前 Hub 能解释的格式（字段可能已经变了），宁可报错也不把半懂的索引透传给客户端。
    // 选 500 而不是 502：index.json 是随仓库托管的本地产物，不是上游网关的响应。
    if (index.apiVersion !== INDEX_API_VERSION) {
      log({ event: 'hub.index-api-version', got: String(index.apiVersion), want: INDEX_API_VERSION });
      return sendJson(req, res, 500, {
        error: `索引的 apiVersion 不认识：${String(index.apiVersion)}（本 Hub 支持 ${INDEX_API_VERSION}）`,
        code: 'index-api-version',
      });
    }
    return sendJson(req, res, 200, index, 'public, max-age=30, must-revalidate');
  }

  if (url.pathname === '/api/registry/pack' && req.method === 'GET') {
    const name = url.searchParams.get('name') ?? '';
    let version = url.searchParams.get('version') ?? '';
    if (!PACK_NAME_PATTERN.test(name)) {
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
    if (!PACK_VERSION_PATTERN.test(version)) {
      return sendJson(req, res, 404, { error: '没有这个版本' });
    }
    const dir = join(root, 'registry/packs', name, version);
    if (!existsSync(join(dir, MANIFEST_FILE))) {
      return sendJson(req, res, 404, { error: '没有这个版本' });
    }
    const manifestText = readFileSync(join(dir, MANIFEST_FILE), 'utf8');
    const parsed = parseManifest(manifestText, join(dir, MANIFEST_FILE));
    const m = parsed.manifest?.metadata;
    return sendJson(
      req,
      res,
      200,
      {
        name,
        version,
        manifest: manifestText,
        // 解析后的元数据：客户端不用再自己引一个 YAML 库
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
        lock: readJson(join(dir, LOCK_FILE)),
        verify: readJson(join(dir, 'verify.json')),
        // 包说明与变更记录：原文返回，排版交给客户端
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
    const raw = String(body.target ?? 'dir') || 'dir';
    // target 是计划契约的一部分：枚举外的值不能产出计划，直接拒掉
    if (!isTargetId(raw)) {
      return sendJson(req, res, 400, {
        error: `未知 target：${raw}（可选 ${TARGET_IDS.join(' / ')}）`,
      });
    }
    const parsed = parseManifest(text, '<draft>');
    if (!parsed.manifest) return sendJson(req, res, 200, { issues: parsed.issues, plan: null });
    const { graph, issues } = validateGraph(parsed.manifest);
    const all = [...parsed.issues, ...issues];
    if (all.some((i) => i.severity === 'error')) {
      return sendJson(req, res, 200, { issues: all, plan: null });
    }
    // 出计划走 kernel 的 planFor：target 校验、落点变量、packDir 的用法只有那一份实现
    const ctx: PackContext = { dir: planPackDir, manifest: parsed.manifest, graph, issues: [] };
    const { plan, issues: planIssues } = planFor(ctx, { target: raw });
    return sendJson(req, res, 200, { issues: planIssues, plan: plan ?? null });
  }

  return sendJson(req, res, 404, { error: `未知接口：${url.pathname}` });
}

function readJson(file: string): unknown {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** 1 MB 上限：预览用的清单不需要更大；超了按 413，而不是把内存吃满。 */
const BODY_LIMIT = 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new HttpError(413, 'body-too-large', '请求体超过 1 MB');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'body-invalid-json', '请求体不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'body-invalid-json', '请求体要一个 JSON 对象');
  }
  return parsed as Record<string, unknown>;
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
