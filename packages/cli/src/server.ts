import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPack, loadPack, loadState, planFor, verifyPack } from '@packhub/core';

export interface ServeOptions {
  root: string;
  port: number;
  staticDir?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** 把 core 暴露成本地 API：面板只是它的门面，所有判断都在 core 里。 */
export function startServer(opts: ServeOptions): Promise<Server> {
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
      res.end('404：api 在 /api/*，面板产物未构建（pnpm --filter web build）');
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
  const dir = safeDir(root, url.searchParams.get('dir') ?? '.');

  if (url.pathname === '/api/packs' && req.method === 'GET') {
    const packs = listPacks(root).map((p) => {
      const ctx = loadPack(p.dir);
      const { plan } = planFor(ctx);
      const state = loadState(p.dir);
      const installed = Object.keys(state.packs).find((k) => k.startsWith(`${ctx.manifest?.metadata.name ?? ''}@`));
      return {
        dir: relative(root, p.dir),
        name: ctx.manifest?.metadata.name ?? p.dir,
        version: ctx.manifest?.metadata.version ?? '?',
        title: ctx.manifest?.metadata.title ?? '',
        targets: ctx.manifest?.metadata.targets ?? [],
        resourceCount: ctx.manifest?.resources.length ?? 0,
        errors: ctx.issues.filter((i) => i.severity === 'error').length,
        planHash: plan?.planHash ?? null,
        installedHash: installed ? state.packs[installed]!.planHash : null,
      };
    });
    return sendJson(res, 200, { root: relative(process.cwd(), root), packs });
  }

  if (url.pathname === '/api/pack' && req.method === 'GET') {
    const ctx = loadPack(dir);
    const { plan, issues } = planFor(ctx);
    return sendJson(res, 200, {
      dir: relative(root, dir),
      manifest: ctx.manifest ?? null,
      issues: [...ctx.issues, ...issues],
      plan: plan ?? null,
      state: loadState(dir).packs,
    });
  }

  if (url.pathname === '/api/install' && req.method === 'POST') {
    const body = await readBody(req);
    const ctx = loadPack(dir);
    const { plan, issues } = planFor(ctx);
    if (!plan) return sendJson(res, 422, { error: '计划生成失败', issues });
    const result = installPack(ctx, plan, { allowExec: body.allowExec === true });
    return sendJson(res, 200, { outcomes: result.outcomes, planHash: plan.planHash });
  }

  if (url.pathname === '/api/verify' && req.method === 'POST') {
    const ctx = loadPack(dir);
    const { plan, issues } = planFor(ctx);
    if (!plan) return sendJson(res, 422, { error: '计划生成失败', issues });
    return sendJson(res, 200, { results: verifyPack(ctx.dir, plan), planHash: plan.planHash });
  }

  return sendJson(res, 404, { error: `未知接口 ${url.pathname}` });
}

function listPacks(root: string): { dir: string }[] {
  const candidates: string[] = [];
  if (existsSync(join(root, 'packhub.yaml'))) candidates.push(root);
  for (const sub of ['examples', 'packs']) {
    const base = join(root, sub);
    if (!existsSync(base)) continue;
    for (const name of listDirs(base)) {
      const dir = join(base, name);
      if (existsSync(join(dir, 'packhub.yaml'))) candidates.push(dir);
    }
  }
  return candidates.map((dir) => ({ dir }));
}

function listDirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);
}

function safeDir(root: string, rel: string): string {
  const target = resolve(root, rel);
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`目录越界：${rel}`);
  return target;
}

function relative(from: string, to: string): string {
  return normalize(to).replace(normalize(from) + sep, '').replace(/\\/g, '/') || '.';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function defaultStaticDir(): string {
  return fileURLToPath(new URL('../../web/dist/', import.meta.url));
}
