import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { createInstance, listInstances, readInstance, removeInstance } from './index.ts';
import { refreshStatuses, startInstance, stopInstance } from './start.ts';
import { activeEntries, setActive } from './active.ts';
import { materializePack } from './materialize.ts';
import { readIndex, resolveRegistry } from '@packhub/runtime';

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

export interface ServeOptions {
  port?: number;
  host?: string;
}

export interface PalServer {
  url: string;
  close: () => Promise<void>;
}

/** 本地只读/操作面：实例列表、创建、启停、切换、日志。只绑回环。 */
export async function startPalServer(opts: ServeOptions = {}): Promise<PalServer> {
  const host = opts.host ?? '127.0.0.1';
  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: (err as Error).message });
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/api/instances' && req.method === 'GET') {
    sendJson(res, 200, refreshStatuses());
    return;
  }

  if (path === '/api/instances' && req.method === 'POST') {
    const body = await readJson(req);
    const pack = String(body.pack ?? '').trim();
    const name = String(body.name ?? '').trim();
    const harness = String(body.harness ?? 'dir');
    if (!pack || !name) {
      sendJson(res, 400, { error: 'pack 与 name 必填' });
      return;
    }
    const packDir = await materializePack(pack, {
      ...(body.index ? { index: String(body.index) } : {}),
      ...(body.version ? { version: String(body.version) } : {}),
    });
    const rec = await createInstance({ name, harness: harness as never, packDir });
    sendJson(res, 200, rec);
    return;
  }

  const match = /^\/api\/instances\/([^/]+)(?:\/(start|stop|active|logs))?$/.exec(path);
  if (match) {
    const id = decodeURIComponent(match[1]!);
    const action = match[2];
    if (!action && req.method === 'DELETE') {
      sendJson(res, 200, removeInstance(id));
      return;
    }
    if (action === 'start' && req.method === 'POST') {
      sendJson(res, 200, await startInstance(id));
      return;
    }
    if (action === 'stop' && req.method === 'POST') {
      sendJson(res, 200, stopInstance(id));
      return;
    }
    if (action === 'active' && req.method === 'POST') {
      sendJson(res, 200, setActive(id));
      return;
    }
    if (action === 'logs' && req.method === 'GET') {
      const rec = readInstance(id);
      if (!rec) {
        sendJson(res, 404, { error: '没有这个实例' });
        return;
      }
      const file = join(rec.root, 'logs', 'start.log');
      sendJson(res, 200, { log: existsSync(file) ? readFileSync(file, 'utf8') : '' });
      return;
    }
  }

  if (path === '/api/active' && req.method === 'GET') {
    sendJson(res, 200, activeEntries().map((entry) => ({ harness: entry.harness, id: entry.record?.id ?? null })));
    return;
  }

  if (path === '/api/packs' && req.method === 'GET') {
    const index = resolveRegistry();
    if (!index) {
      sendJson(res, 200, { index: null, packs: [] });
      return;
    }
    try {
      const data = await readIndex(index);
      sendJson(res, 200, {
        index,
        packs: data.packs.map((pack) => ({
          name: pack.name,
          latest: pack.latest,
          title: pack.title ?? '',
        })),
      });
    } catch (err) {
      sendJson(res, 502, { error: `读不了索引：${(err as Error).message}` });
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(path, res);
    return;
  }

  sendJson(res, 404, { error: '没有这个接口' });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function serveStatic(path: string, res: ServerResponse): void {
  const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
  const file = join(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT) || !existsSync(file)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}
