import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { buildPlan, loadPack, parseManifest, planFor, validateGraph, type TargetId } from '@packhub/kernel';
import { installPack, loadState, verifyPack, verifyInstalled, hasInstalledPacks, syncPack, removeSynced, doctorGlobal, type SyncTarget } from '@packhub/runtime';
import { collectPackResources, defaultStaticDir } from '@packhub/hub';
import { publishPack, writeIndex } from '@packhub/registry';

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
      const message = (err as Error).message;
      const tooLarge = message.includes('请求体超过');
      if (tooLarge) {
        // 请求体还没读完就拒绝：回完 413 后把剩余字节丢掉并关连接，
        // 不能直接 destroy——客户端会先看到 ECONNRESET，收不到 413。
        res.setHeader('connection', 'close');
        req.resume();
      }
      sendJson(res, tooLarge ? 413 : 500, { error: message });
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
      const key = `${ctx.manifest?.metadata.name ?? ''}@${ctx.manifest?.metadata.version ?? ''}`;
      const record = state.packs[key];
      // 只有每一步都落到位（done/noop）才算「已装」；有跳过就是半套
      const complete =
        record !== undefined &&
        record.actions.length > 0 &&
        record.actions.every((a) => a.status === 'done' || a.status === 'noop');
      return {
        dir: relative(root, p.dir),
        name: ctx.manifest?.metadata.name ?? p.dir,
        version: ctx.manifest?.metadata.version ?? '?',
        title: ctx.manifest?.metadata.title ?? '',
        targets: ctx.manifest?.metadata.targets ?? [],
        resourceCount: ctx.manifest?.resources.length ?? 0,
        errors: ctx.issues.filter((i) => i.severity === 'error').length,
        planHash: plan?.planHash ?? null,
        installedHash: complete && record ? record.planHash : null,
      };
    });
    return sendJson(res, 200, { root: relative(process.cwd(), root), packs });
  }

  // 草稿预览：吃一段 manifest 文本，不落盘，只返回问题与计划
  if (url.pathname === '/api/plan' && req.method === 'POST') {
    const body = await readBody(req);
    const text = String(body.manifest ?? '');
    if (!text.trim()) return sendJson(res, 400, { error: 'manifest 为空' });
    const parsed = parseManifest(text, '<draft>');
    if (!parsed.manifest) {
      return sendJson(res, 200, { issues: parsed.issues, plan: null });
    }
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

  // 创作台上传单个文件到 Pack 目录（路径限定在目标 Pack 内）
  if (url.pathname === '/api/packs/upload' && req.method === 'POST') {
    const parsed = (await readBody(req, 16 * 1024 * 1024)) as {
      dir?: string;
      path?: string;
      dataBase64?: string;
    };
    const rel = String(parsed.dir ?? '').trim();
    const filePath = String(parsed.path ?? '').trim();
    if (!rel || !filePath) return sendJson(res, 400, { error: '要提供 dir 与 path' });
    const packDir = safeDir(root, rel);
    const target = safeDir(packDir, filePath);
    const data = Buffer.from(String(parsed.dataBase64 ?? ''), 'base64');
    if (data.length === 0) return sendJson(res, 400, { error: '文件是空的' });
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, data);
    return sendJson(res, 201, {
      dir: relative(root, packDir).split(sep).join('/'),
      path: relative(packDir, target).split(sep).join('/'),
      bytes: data.length,
    });
  }
  // 创作台保存：把预览用的 manifest 写成真实 Pack 目录（只写清单，不落资源文件）
  if (url.pathname === '/api/packs/create' && req.method === 'POST') {
    const body = await readBody(req);
    const rel = String(body.dir ?? '').trim();
    const text = String(body.manifest ?? '');
    if (!rel) return sendJson(res, 400, { error: '要提供保存目录，例如 packs/me/my-pack' });
    if (!text.trim()) return sendJson(res, 400, { error: 'manifest 为空' });
    const target = safeDir(root, rel);
    if (existsSync(join(target, 'packhub.yaml')) && body.force !== true) {
      return sendJson(res, 409, { error: `${rel} 里已经有 packhub.yaml；换一个目录，或传 force: true` });
    }
    const parsed = parseManifest(text, '<console>');
    if (!parsed.manifest) return sendJson(res, 422, { error: '清单未通过校验', issues: parsed.issues });
    const { issues } = validateGraph(parsed.manifest);
    const errors = [...parsed.issues, ...issues].filter((i) => i.severity === 'error');
    if (errors.length > 0) return sendJson(res, 422, { error: '清单未通过校验', issues: errors });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'packhub.yaml'), text, 'utf8');
    // PACK.md / CHANGELOG 是包页展示用的旁挂文档，跟清单一起保存
    const docs = body.docs as { readme?: unknown; changelog?: unknown } | undefined;
    if (docs && typeof docs.readme === 'string') {
      writeFileSync(join(target, 'PACK.md'), docs.readme, 'utf8');
    }
    if (docs && typeof docs.changelog === 'string') {
      writeFileSync(join(target, 'CHANGELOG.md'), docs.changelog, 'utf8');
    }
    return sendJson(res, 201, {
      dir: relative(root, target).split(sep).join('/'),
      name: parsed.manifest.metadata.name,
      version: parsed.manifest.metadata.version,
    });
  }

  // 从面板发布到本仓库的 registry（干净安装+校验+写索引）
  if (url.pathname === '/api/publish' && req.method === 'POST') {
    const body = await readBody(req);
    const target = safeDir(root, String(body.dir ?? url.searchParams.get('dir') ?? '.'));
    const registry = body.registry ? safeDir(root, String(body.registry)) : join(root, 'registry');
    try {
      const result = await publishPack(target, {
        registry,
        allowExec: false,
        force: body.force === true,
      });
      const indexed = writeIndex(registry);
      if (!indexed.ok) result.rollback();
      else result.finalize();
      return sendJson(res, indexed.ok ? 200 : 422, {
        name: result.name,
        version: result.version,
        dir: relative(root, result.dir).split(sep).join('/'),
        indexed: indexed.ok,
        error: indexed.ok ? undefined : '索引门禁没过，本次版本已撤回',
      });
    } catch (err) {
      return sendJson(res, 422, { error: (err as Error).message });
    }
  }
  if (url.pathname === '/api/registry/resources' && req.method === 'GET') {
    const name = url.searchParams.get('name') ?? '';
    const version = url.searchParams.get('version') ?? undefined;
    const result = collectPackResources(root, name, version);
    if (!result) return sendJson(res, 404, { error: '没有这个包或版本' });
    return sendJson(res, 200, result);
  }

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
    const manifestPath = join(dir, 'packhub.yaml');
    if (!existsSync(manifestPath)) return sendJson(res, 404, { error: '没有这个版本' });
    const reportPath = join(dir, 'verify.json');
    const lockPath = join(dir, 'packhub.lock.json');
    return sendJson(res, 200, {
      name,
      version,
      manifest: readFileSync(manifestPath, 'utf8'),
      lock: existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : null,
      verify: existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null,
    });
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
    // into：可把包装到另一个项目目录；不传则装进 Pack 自己
    const into = body.into ? safeDir(root, String(body.into)) : ctx.dir;
    const result = await installPack(ctx, plan, {
      allowExec: body.allowExec === true,
      dryRun: body.dryRun === true,
      root: into,
      packRoot: ctx.dir,
    });
    return sendJson(res, 200, {
      outcomes: result.outcomes,
      planHash: plan.planHash,
      statePath: result.statePath,
      dryRun: body.dryRun === true,
      root: relative(root, into).split(sep).join('/'),
    });
  }

  if (url.pathname === '/api/verify' && req.method === 'POST') {
    // 项目模式：add 装进来的包没有 packhub.yaml，用 state 里的计划快照验
    if (!existsSync(join(dir, 'packhub.yaml')) && hasInstalledPacks(dir)) {
      const reports = await verifyInstalled(dir);
      return sendJson(res, 200, {
        installed: reports,
        results: reports.flatMap((r) => r.results),
        planHash: reports[0]?.planHash ?? '',
      });
    }
    const ctx = loadPack(dir);
    const { plan, issues } = planFor(ctx);
    if (!plan) return sendJson(res, 422, { error: '计划生成失败', issues });
    return sendJson(res, 200, { results: await verifyPack(ctx.dir, plan), planHash: plan.planHash });
  }

  if (url.pathname === '/api/harness' && req.method === 'GET') {
    const reports = doctorGlobal(['dsh', 'codex', 'claude-code']);
    return sendJson(res, 200, {
      targets: reports.map((r) => ({
        target: r.target,
        root: r.root,
        ok: Boolean(r.report?.ok),
        packs: r.report?.packs ?? [],
        error: r.error ?? null,
      })),
    });
  }

  if (url.pathname === '/api/sync' && req.method === 'POST') {
    const body = await readBody(req);
    const targets = (Array.isArray(body.to) ? body.to : ['dsh', 'codex'])
      .map(String)
      .filter((t): t is SyncTarget => t === 'dsh' || t === 'codex' || t === 'claude-code');
    if (targets.length === 0) return sendJson(res, 400, { error: '至少选一个 harness' });
    try {
      const result = await syncPack(dir, {
        targets,
        dryRun: body.dryRun === true,
        overwrite: body.overwrite === true,
      });
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 422, { error: (err as Error).message });
    }
  }

  if (url.pathname === '/api/sync/remove' && req.method === 'POST') {
    const body = await readBody(req);
    const targets = (Array.isArray(body.to) ? body.to : ['dsh', 'codex'])
      .map(String)
      .filter((t): t is SyncTarget => t === 'dsh' || t === 'codex' || t === 'claude-code');
    if (targets.length === 0) return sendJson(res, 400, { error: '至少选一个 harness' });
    try {
      return sendJson(res, 200, { results: removeSynced(dir, targets) });
    } catch (err) {
      return sendJson(res, 422, { error: (err as Error).message });
    }
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

async function readBody(
  req: IncomingMessage,
  limit = 8 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) {
      // 继续把剩余字节读掉（不保留），否则客户端在上传中途会收到 ECONNRESET
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(buf);
  }
  if (tooLarge) throw new Error(`请求体超过 ${Math.round(limit / 1024 / 1024)} MB 上限`);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export { defaultStaticDir } from '@packhub/hub';
