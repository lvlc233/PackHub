import {
  appendFileSync,
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
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadPack } from '@packhub/kernel';
import { writeIndex } from '@packhub/registry';
import { publishPack } from '@packhub/registry';
import { unpackArchive } from '@packhub/runtime';
import {
  accountForToken,
  bumpDownload,
  createAccount,
  downloadTrend,
  hashToken,
  loadDb,
  markYanked,
  ratePack,
  ratingSummary,
  recordReview,
} from './store.ts';
import { ADMIN_HTML } from './admin-page.ts';

export interface MarketOptions {
  /** registry 根目录：packs/ 与 index.json 都写在这里 */
  root: string;
  host?: string;
  port?: number;
  /** 上传上限，默认 25 MB */
  maxUploadBytes?: number;
  /** 需要人工审核：上传进 staging，管理员批准后才进索引 */
  requireReview?: boolean;
  /** 管理 token；缺省用 PACKHUB_MARKET_ADMIN */
  adminToken?: string;
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
  const requireReview = opts.requireReview ?? process.env.PACKHUB_MARKET_REVIEW === '1';
  const adminToken = opts.adminToken ?? process.env.PACKHUB_MARKET_ADMIN;
  const stagingRoot = join(root, '.market', 'staging');
  const adminFile = join(root, '.market', 'admin.json');
  const adminAuditFile = join(root, '.market', 'admin-audit.jsonl');
  mkdirSync(join(root, 'packs'), { recursive: true });
  mkdirSync(join(root, '.market'), { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });

  interface AdminFile {
    apiVersion: 'packhub.dev/market-admin/v0';
    hash: string;
    createdAt: string;
    rotatedAt?: string;
  }
  const readAdmin = (): AdminFile | undefined => {
    if (!existsSync(adminFile)) return undefined;
    try {
      return JSON.parse(readFileSync(adminFile, 'utf8')) as AdminFile;
    } catch {
      return undefined;
    }
  };
  const writeAdmin = (token: string): AdminFile => {
    const current = readAdmin();
    const next: AdminFile = {
      apiVersion: 'packhub.dev/market-admin/v0',
      hash: hashToken(token),
      createdAt: current?.createdAt ?? new Date().toISOString(),
      ...(current ? { rotatedAt: new Date().toISOString() } : {}),
    };
    writeFileSync(adminFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
  };
  const same = (a: string, b: string): boolean => {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  };
  // 首次启动用 env/参数里的 token 落盘；之后以文件为准，允许通过 rotate 换掉
  if (adminToken && !readAdmin()) writeAdmin(adminToken);
  if (requireReview && !adminToken && !readAdmin()) {
    throw new Error('requireReview 需要 adminToken（或 PACKHUB_MARKET_ADMIN），否则没人能批准上传');
  }
  const isAdmin = (req: IncomingMessage): boolean => {
    const given = String(req.headers['x-market-admin'] ?? '');
    if (!given) return false;
    const stored = readAdmin();
    if (stored) return same(hashToken(given), stored.hash);
    return adminToken ? same(given, adminToken) : false;
  };
  const adminAudit = (entry: Record<string, unknown>): void => {
    try {
      appendFileSync(adminAuditFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
    } catch {
      /* 审计写失败不影响主流程 */
    }
  };

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

    if (url.pathname === '/admin' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      });
      return void res.end(ADMIN_HTML);
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
          return {
            ...p,
            downloads: db.stats[key]?.downloads ?? 0,
            trend: downloadTrend(root, String(p.name), latest),
            rating: ratingSummary(root, String(p.name), latest),
          };
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
        readme: existsSync(join(dir, 'PACK.md')) ? readFileSync(join(dir, 'PACK.md'), 'utf8') : null,
        changelog: existsSync(join(dir, 'CHANGELOG.md'))
          ? readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
          : null,
        review: db.reviews[`${name}@${version}`] ?? null,
        downloads: db.stats[`${name}@${version}`]?.downloads ?? 0,
        trend: downloadTrend(root, name, version),
        rating: ratingSummary(root, name, version),
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
          // 人工审核模式下先写 staging：批准前不进索引、不能下载
          const target = requireReview ? stagingRoot : root;
          const published = await publishPack(packDir, { registry: target, allowExec: false });
          if (requireReview) {
            published.finalize();
            recordReview(root, name, version, 'pending', 'waiting for admin review');
            return sendJson(res, 202, {
              name,
              version,
              status: 'pending',
              note: '已通过干净安装与只读校验，等待管理员批准后进索引',
            });
          }
          const indexed = writeIndex(root);
          if (!indexed.ok) {
            published.rollback();
            recordReview(root, name, version, 'rejected', 'index gate failed');
            return sendJson(res, 422, { error: '索引门禁没过，本次版本已撤回' });
          }
          published.finalize();
          recordReview(root, name, version, 'approved', 'clean install passed');
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

    if (url.pathname === '/api/ratings' && req.method === 'POST') {
      const account = accountForToken(root, bearer(req));
      if (!account) return sendJson(res, 401, { error: 'token 无效' });
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}') as {
        name?: string;
        version?: string;
        score?: number;
        comment?: string;
      };
      const name = body.name ?? '';
      const version = body.version ?? '';
      if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(name) || !/^\d+\.\d+\.\d+/.test(version)) {
        return sendJson(res, 400, { error: 'name / version 不合法' });
      }
      if (!existsSync(join(root, 'packs', name, version))) {
        return sendJson(res, 404, { error: '没有这个版本' });
      }
      try {
        ratePack(root, name, version, account.id, Number(body.score), body.comment);
      } catch (err) {
        return sendJson(res, 422, { error: (err as Error).message });
      }
      return sendJson(res, 200, { name, version, rating: ratingSummary(root, name, version) });
    }

    if (url.pathname === '/api/admin/stats' && req.method === 'GET') {
      if (!isAdmin(req)) {
        return sendJson(res, 401, { error: '需要 x-market-admin 管理 token' });
      }
      const db = loadDb(root);
      const packs = (indexPack(root).packs ?? []) as { versions?: string[] }[];
      const downloads = Object.entries(db.stats)
        .sort((a, b) => b[1].downloads - a[1].downloads)
        .slice(0, 10)
        .map(([key, stat]) => {
          const at = key.lastIndexOf('@');
          return { name: key.slice(0, at), version: key.slice(at + 1), downloads: stat.downloads };
        });
      const recent = Object.entries(db.reviews)
        .sort((a, b) => b[1].at.localeCompare(a[1].at))
        .slice(0, 20)
        .map(([key, review]) => {
          const at = key.lastIndexOf('@');
          return { name: key.slice(0, at), version: key.slice(at + 1), ...review };
        });
      return sendJson(res, 200, {
        accounts: Object.keys(db.accounts).length,
        packs: packs.length,
        versions: packs.reduce((n, p) => n + (p.versions?.length ?? 0), 0),
        pending: Object.values(db.reviews).filter((r) => r.status === 'pending').length,
        downloads,
        recent,
      });
    }

    if (url.pathname === '/api/admin/queue' && req.method === 'GET') {
      if (!isAdmin(req)) {
        return sendJson(res, 401, { error: '需要 x-market-admin 管理 token' });
      }
      const db = loadDb(root);
      return sendJson(res, 200, {
        pending: Object.entries(db.reviews)
          .filter(([, r]) => r.status === 'pending')
          .map(([key, r]) => {
            const [name, version] = key.split('@');
            return { name, version, ...r };
          }),
      });
    }

    if (url.pathname === '/api/admin/rotate' && req.method === 'POST') {
      if (!isAdmin(req)) {
        return sendJson(res, 401, { error: '需要 x-market-admin 管理 token' });
      }
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}') as {
        token?: string;
      };
      const provided = typeof body.token === 'string' ? body.token.trim() : '';
      if (provided && provided.length < 12) {
        return sendJson(res, 400, { error: '新 token 至少 12 个字符，或留空让服务端生成' });
      }
      const token = provided || randomBytes(24).toString('base64url');
      const next = writeAdmin(token);
      adminAudit({ action: 'rotate-admin-token', ip: req.socket.remoteAddress, rotatedAt: next.rotatedAt });
      return sendJson(res, 200, {
        token,
        note: '新 token 只显示一次；旧 token 已失效，请立刻更新部署配置',
      });
    }

    if (url.pathname === '/api/admin/review' && req.method === 'POST') {
      if (!isAdmin(req)) {
        return sendJson(res, 401, { error: '需要 x-market-admin 管理 token' });
      }
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}') as {
        name?: string;
        version?: string;
        action?: 'approve' | 'reject';
        note?: string;
      };
      const name = body.name ?? '';
      const version = body.version ?? '';
      if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(name) || !/^\d+\.\d+\.\d+/.test(version)) {
        return sendJson(res, 400, { error: 'name / version 不合法' });
      }
      if (body.action !== 'approve' && body.action !== 'reject') {
        return sendJson(res, 400, { error: 'action 只能是 approve / reject' });
      }
      const stagedDir = join(stagingRoot, 'packs', name, version);
      if (!existsSync(stagedDir)) return sendJson(res, 404, { error: 'staging 里没有这个版本' });

      if (body.action === 'reject') {
        rmSync(join(stagingRoot, 'packs', name, version), { recursive: true, force: true });
        rmSync(join(stagingRoot, 'packs', name, `${version}.phub`), { force: true });
        const left = existsSync(join(stagingRoot, 'packs', name))
          ? readdirSync(join(stagingRoot, 'packs', name))
          : [];
        if (left.length === 0) rmSync(join(stagingRoot, 'packs', name), { recursive: true, force: true });
        // staging 里的索引是发布时留下的中间产物，别跟着版本一起进归档目录
        rmSync(join(stagingRoot, 'index.json'), { force: true });
        recordReview(root, name, version, 'rejected', body.note ?? 'rejected by admin');
        adminAudit({ action: 'reject', name, version, ip: req.socket.remoteAddress, note: body.note });
        return sendJson(res, 200, { name, version, status: 'rejected' });
      }

      const destDir = join(root, 'packs', name, version);
      mkdirSync(dirname(destDir), { recursive: true });
      renameSync(stagedDir, destDir);
      const stagedArchive = join(stagingRoot, 'packs', name, `${version}.phub`);
      const destArchive = join(root, 'packs', name, `${version}.phub`);
      if (existsSync(stagedArchive)) {
        mkdirSync(dirname(destArchive), { recursive: true });
        renameSync(stagedArchive, destArchive);
      }
      const left = existsSync(join(stagingRoot, 'packs', name))
        ? readdirSync(join(stagingRoot, 'packs', name))
        : [];
      if (left.length === 0) rmSync(join(stagingRoot, 'packs', name), { recursive: true, force: true });
      rmSync(join(stagingRoot, 'index.json'), { force: true });
      const indexed = writeIndex(root);
      if (!indexed.ok) {
        // 索引没过：把版本移回 staging，别让「目录在、索引没有」的状态留在 registry
        mkdirSync(dirname(stagedDir), { recursive: true });
        renameSync(destDir, stagedDir);
        if (existsSync(destArchive)) renameSync(destArchive, stagedArchive);
        return sendJson(res, 500, { error: '批准后重建索引失败，版本已移回 staging' });
      }
      recordReview(root, name, version, 'approved', body.note ?? 'approved by admin');
      adminAudit({ action: 'approve', name, version, ip: req.socket.remoteAddress, note: body.note });
      return sendJson(res, 200, { name, version, status: 'approved' });
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
      markYanked(root, name, version, body.reason ?? 'yanked');
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

