import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPack } from '@packhub/kernel';
import { writeIndex } from '@packhub/registry';
import { publishPack } from '@packhub/registry';
import { unpackArchive } from '@packhub/runtime';
import {
  accountForToken,
  bumpDownload,
  createAccount,
  loadDb,
  recordReview,
  saveDb,
} from './store.ts';

export interface MarketOptions {
  /** registry 根目录：packs/ 与 index.json 都写在这里 */
  root: string;
  host?: string;
  port?: number;
  /** 上传上限，默认 25 MB */
  maxUploadBytes?: number;
}

export interface RunningMarket {
  url: string;
  close: () => Promise<void>;
}

const MIME_JSON = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': MIME_JSON });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error(`上传超过上限（${Math.round(limit / 1024 / 1024)} MB）`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? '';
}

function indexPack(root: string): { packs?: unknown[] } {
  const file = join(root, 'index.json');
  if (!existsSync(file)) return { packs: [] };
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { packs?: unknown[] };
  } catch {
    return { packs: [] };
  }
}

/** 市场只接受只读校验：command / scenario / mcp-ready 会在服务器上执行上传者的代码。 */
const EXECUTABLE_CHECKS = new Set(['command', 'scenario', 'mcp-ready']);

export async function startMarket(opts: MarketOptions): Promise<RunningMarket> {
  const root = resolve(opts.root);
  const maxUpload = opts.maxUploadBytes ?? 25 * 1024 * 1024;
  mkdirSync(join(root, 'packs'), { recursive: true });
  mkdirSync(join(root, '.market'), { recursive: true });

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

    if (url.pathname === '/api/health') {
      const index = indexPack(root);
      return sendJson(res, 200, { ok: true, packs: index.packs?.length ?? 0 });
    }

    if (url.pathname === '/api/accounts' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}') as {
        name?: string;
      };
      if (!body.name || typeof body.name !== 'string') return sendJson(res, 400, { error: '要提供 name' });
      try {
        const created = createAccount(root, body.name);
        return sendJson(res, 201, {
          account: { id: created.account.id, name: created.account.name, scope: created.account.scope },
          token: created.token,
          note: 'token 只显示一次，保存到 packhub market login',
        });
      } catch (err) {
        return sendJson(res, 409, { error: (err as Error).message });
      }
    }

    if (url.pathname === '/api/me' && req.method === 'GET') {
      const account = accountForToken(root, bearer(req));
      if (!account) return sendJson(res, 401, { error: 'token 无效' });
      return sendJson(res, 200, { id: account.id, name: account.name, scope: account.scope });
    }

    if (url.pathname === '/api/search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const db = loadDb(root);
      const packs = (indexPack(root).packs ?? []) as Record<string, unknown>[];
      const hits = packs
        .filter((p) => {
          const text = [p.name, p.title, p.description, (p.keywords as string[] | undefined)?.join(' ')]
            .join(' ')
            .toLowerCase();
          return !q || text.includes(q);
        })
        .map((p) => {
          const latest = String(p.latest ?? '');
          const key = `${String(p.name)}@${latest}`;
          return { ...p, downloads: db.stats[key]?.downloads ?? 0 };
        });
      return sendJson(res, 200, { packs: hits });
    }

    if (url.pathname === '/api/packs' && req.method === 'GET') {
      const name = url.searchParams.get('name') ?? '';
      const version = url.searchParams.get('version') ?? '';
      if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(name) || !/^\d+\.\d+\.\d+/.test(version)) {
        return sendJson(res, 400, { error: 'name / version 不合法' });
      }
      const dir = join(root, 'packs', name, version);
      if (!existsSync(dir)) return sendJson(res, 404, { error: '没有这个版本' });
      const db = loadDb(root);
      return sendJson(res, 200, {
        name,
        version,
        manifest: readFileSync(join(dir, 'packhub.yaml'), 'utf8'),
        lock: existsSync(join(dir, 'packhub.lock.json'))
          ? JSON.parse(readFileSync(join(dir, 'packhub.lock.json'), 'utf8'))
          : null,
        verify: existsSync(join(dir, 'verify.json'))
          ? JSON.parse(readFileSync(join(dir, 'verify.json'), 'utf8'))
          : null,
        review: db.reviews[`${name}@${version}`] ?? null,
        downloads: db.stats[`${name}@${version}`]?.downloads ?? 0,
      });
    }

    if (url.pathname === '/download' && req.method === 'GET') {
      const name = url.searchParams.get('name') ?? '';
      const version = url.searchParams.get('version') ?? '';
      const db = loadDb(root);
      if (db.yanked[`${name}@${version}`]) return sendJson(res, 410, { error: '这个版本已下架' });
      const file = join(root, 'packs', name, `${version}.phub`);
      if (!existsSync(file)) return sendJson(res, 404, { error: '没有这个归档' });
      bumpDownload(root, name, version);
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': statSync(file).size,
      });
      createReadStream(file).pipe(res);
      return;
    }

    if (url.pathname === '/api/publish' && req.method === 'POST') {
      const account = accountForToken(root, bearer(req));
      if (!account) return sendJson(res, 401, { error: 'token 无效（先 packhub market register）' });
      let body: Buffer;
      try {
        body = await readBody(req, maxUpload);
      } catch (err) {
        return sendJson(res, 413, { error: (err as Error).message });
      }
      if (body.length === 0) return sendJson(res, 400, { error: '请求体是空的（要发 .phub 归档）' });

      const work = mkdtempSync(join(tmpdir(), 'packhub-market-'));
      try {
        const archive = join(work, 'upload.phub');
        writeFileSync(archive, body);
        const packDir = join(work, 'pack');
        await unpackArchive(archive, packDir);
        const ctx = loadPack(packDir);
        const errors = ctx.issues.filter((i) => i.severity === 'error');
        if (!ctx.manifest || errors.length > 0) {
          return sendJson(res, 422, { error: '清单未通过校验', issues: errors.map((e) => e.message) });
        }
        const name = ctx.manifest.metadata.name;
        const version = ctx.manifest.metadata.version;
        if (!name.startsWith(`${account.scope}/`)) {
          return sendJson(res, 403, { error: `只能发布 ${account.scope}/ 下的包：${name}` });
        }
        const visibility = ctx.manifest.metadata.visibility ?? 'private';
        if (visibility !== 'public' && visibility !== 'unlisted') {
          return sendJson(res, 422, { error: `市场只收 public / unlisted，当前是 ${visibility}` });
        }
        if (ctx.manifest.install?.exec?.length) {
          return sendJson(res, 422, { error: '市场拒绝带 install.exec 的包' });
        }
        const executable = (ctx.manifest.verify ?? []).filter((c) => EXECUTABLE_CHECKS.has(c.type));
        if (executable.length > 0) {
          return sendJson(res, 422, {
            error: `市场只接受只读校验；拒绝：${executable.map((c) => c.type).join(', ')}（发布前的 command/scenario 请在 CI 跑）`,
          });
        }

        try {
          const published = await publishPack(packDir, { registry: root, allowExec: false });
          recordReview(root, name, version, 'approved', 'clean install passed');
          const indexed = writeIndex(root);
          if (!indexed.ok) {
            recordReview(root, name, version, 'rejected', 'index gate failed');
            return sendJson(res, 422, { error: '索引门禁没过，版本已写入但未进索引' });
          }
          return sendJson(res, 201, {
            name,
            version,
            trust: published.report.ok ? 'verified' : 'community',
            planHash: published.report.planHash,
          });
        } catch (err) {
          recordReview(root, name, version, 'rejected', (err as Error).message);
          return sendJson(res, 422, { error: (err as Error).message });
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }

    if (url.pathname === '/api/yank' && req.method === 'POST') {
      const account = accountForToken(root, bearer(req));
      if (!account) return sendJson(res, 401, { error: 'token 无效' });
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}') as {
        name?: string;
        version?: string;
        reason?: string;
      };
      const name = body.name ?? '';
      const version = body.version ?? '';
      if (!name.startsWith(`${account.scope}/`) || !version) {
        return sendJson(res, 403, { error: '只能下架自己 scope 下的版本' });
      }
      const dir = join(root, 'packs', name, version);
      if (!existsSync(dir)) return sendJson(res, 404, { error: '没有这个版本' });
      // 移到 quarantine：目录与归档都撤掉，但保留审计证据
      const quarantine = join(root, '.market', 'quarantine', name, version);
      mkdirSync(join(quarantine, '..'), { recursive: true });
      renameSync(dir, quarantine);
      const archive = join(root, 'packs', name, `${version}.phub`);
      if (existsSync(archive)) {
        mkdirSync(quarantine, { recursive: true });
        renameSync(archive, join(quarantine, `${version}.phub`));
      }
      const db = loadDb(root);
      db.yanked[`${name}@${version}`] = body.reason ?? 'yanked';
      saveDb(root, db);
      // 最后一个版本被撤掉时，清掉空的包目录，否则索引会因为「没有版本目录」报错
      const left = existsSync(join(root, 'packs', name))
        ? readdirSync(join(root, 'packs', name), { withFileTypes: true })
            .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+/.test(e.name))
            .map((e) => e.name)
        : [];
      if (left.length === 0) rmSync(join(root, 'packs', name), { recursive: true, force: true });
      const indexed = writeIndex(root);
      if (!indexed.ok) return sendJson(res, 500, { error: '下架后重建索引失败' });
      return sendJson(res, 200, { name, version, yanked: true });
    }

    return sendJson(res, 404, { error: `未知接口 ${url.pathname}` });
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (opts.port ?? 0);
  const host = opts.host ?? '127.0.0.1';

  return {
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        setTimeout(done, 3000).unref();
      }),
  };
}

