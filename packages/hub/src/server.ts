import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
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

/** web 构建产物默认位置（packages/web/dist）。 */
export function defaultStaticDir(): string {
  return fileURLToPath(new URL('../../web/dist/', import.meta.url));
}

export interface HubOptions {
  /** 仓库根（registry 在它下面） */
  root: string;
  port: number;
  staticDir?: string;
}

/**
 * 只读的发布端：索引、包页数据、计划预览。
 * 这里没有 install / verify —— 执行永远发生在目标机器上。
 */
export function startHub(opts: HubOptions): Promise<Server> {
  const root = resolve(opts.root);
  const staticDir = opts.staticDir ? resolve(opts.staticDir) : undefined;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

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
      res.end('404：Hub 只有只读接口（/api/registry、/api/registry/pack、/api/plan）');
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  });

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port, '127.0.0.1', () => ok(server));
  });
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
    if (errors.length > 0) return sendJson(res, 200, { issues: [...parsed.issues, ...issues], plan: null });
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
