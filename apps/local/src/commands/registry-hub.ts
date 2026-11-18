// 由 cli.ts 拆分：search / cacheLs / cacheClean / cache / discover / hub
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, command, json, problemRaw, say, stop, terminate, warn } from '../emit.ts';
import { startHub } from '@packhub/hub';
import { PACKHUB_ENV, searchResources, RESOURCE_TYPES } from '@packhub/kernel';
import {
  addResource,
  readIndex,
  resolveRegistry,
  registryIndexes,
  loadCatalog,
  searchNpm,
  inspectCache,
  cleanCache,
} from '@packhub/runtime';


export const search = command({
  meta: { name: 'search', description: '在 registry 索引里按关键词找包' },
  args: {
    keyword: { type: 'positional', required: false, description: '名称 / 标题 / 描述 / 关键词' },
    index: { type: 'string', description: `索引路径、URL 或本机配置里的 registry 名（默认取 ${PACKHUB_ENV.index} / 本机配置）` },
    all: { type: 'boolean', default: false, description: '搜所有配置过的 registry' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const refs = args.all
      ? registryIndexes()
      : [resolveRegistry(args.index ? String(args.index) : undefined)].filter((r): r is string => Boolean(r));
    if (refs.length === 0) {
      problemRaw(`没有索引：加 --index <路径|URL|registry 名>，或设 ${PACKHUB_ENV.index}，或在 ~/.packhub/config.json 配 registries`);
      stop(EXIT.USAGE);
    }
    const keyword = String(args.keyword ?? '').toLowerCase();
    const hits: (import('@packhub/runtime').IndexEntry & { registry?: string })[] = [];
    for (const ref of refs) {
      const index = await readIndex(ref);
      for (const p of index.packs.filter((x) => {
        const text = [x.name, x.title ?? '', x.description ?? '', (x.keywords ?? []).join(' ')].join(' ').toLowerCase();
        return !keyword || text.includes(keyword);
      })) {
        hits.push(refs.length > 1 ? { ...p, registry: ref } : p);
      }
    }
    if (args.json) {
      json(hits);
      return;
    }
    if (hits.length === 0) {
      say('没有匹配的包');
      return;
    }
    for (const p of hits) {
      const trust = p.trust === 'verified' ? '✓ verified' : 'community';
      say(`${p.name}@${p.latest}  ${trust}`);
      if (p.registry) say(`  来源：${p.registry}`);
      if (p.title) say(`  ${p.title}`);
      if (p.description) say(`  ${p.description}`);
      if (p.install) say(`  ${p.install}`);
    }
  },
});

export const cacheLs = command({
  meta: { name: 'ls', description: '看缓存里有什么、谁还在用' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const report = inspectCache(resolve(String(args.dir)));
    if (args.json) {
      json(report);
      return;
    }
    if (report.entries.length === 0) {
      say('缓存是空的');
      return;
    }
    for (const entry of report.entries) {
      say(
        `${entry.referenced ? '●' : '○'} ${entry.path.padEnd(48)} ${entry.kind.padEnd(8)} ${Math.max(1, Math.round(entry.bytes / 1024))} KB`,
      );
    }
    say(`\n共 ${Math.max(1, Math.round(report.totalBytes / 1024))} KB；○ 是没有任何已装版本引用的缓存`);
  },
});

export const cacheClean = command({
  meta: { name: 'clean', description: '删掉没有被已装版本引用的缓存（先 dry-run 看清单）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    'dry-run': { type: 'boolean', default: false },
  },
  run({ args }) {
    const res = cleanCache(resolve(String(args.dir)), { dryRun: Boolean(args['dry-run']) });
    if (res.removed.length === 0) {
      say('没有可回收的缓存');
      return;
    }
    for (const p of res.removed) say(`  × ${p}`);
    say(
      `\n${res.dryRun ? '[dry-run] 将删除' : '已删除'} ${res.removed.length} 项，释放约 ${Math.max(1, Math.round(res.freedBytes / 1024))} KB`,
    );
  },
});

export const cache = command({
  meta: { name: 'cache', description: '查看与回收 .packhub/cache' },
  subCommands: { ls: cacheLs, clean: cacheClean },
});

export const discover = command({
  meta: { name: 'discover', description: '搜 MCP / skill / CLI 候选，并把选中的写进清单' },
  args: {
    keyword: { type: 'positional', required: false, description: '关键词；留空列出全部' },
    catalog: { type: 'string', description: '资源目录（文件或 URL；默认取 index 同目录的 resources.json）' },
    index: { type: 'string', description: '索引路径或 URL，用来找同目录的 resources.json' },
    npm: { type: 'boolean', default: false, description: '同时查 npm registry（联网）' },
    type: { type: 'string', description: `只看某一类：${RESOURCE_TYPES.join(' / ')}` },
    limit: { type: 'string', default: '10' },
    add: { type: 'string', description: '把第几个结果写进清单（从 1 开始）' },
    dir: { type: 'string', default: '.', description: 'Pack 目录（配合 --add）' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const keyword = String(args.keyword ?? '');
    const limit = Math.max(1, Number(args.limit) || 10);
    const local = await loadCatalog({
      ...(args.catalog ? { catalog: String(args.catalog) } : {}),
      ...(args.index ? { index: String(args.index) } : {}),
    });
    const npmRes = args.npm ? await searchNpm(keyword || 'mcp', limit) : { entries: [] as never[] };
    if (local.error) warn(local.error);
    if ('error' in npmRes && npmRes.error) warn(npmRes.error);

    const seen = new Set<string>();
    const entries = [...local.entries, ...npmRes.entries].filter((e) => {
      if (seen.has(e.source)) return false;
      seen.add(e.source);
      return true;
    });
    let hits = searchResources(entries, keyword);
    if (args.type) hits = hits.filter((h) => h.entry.type === String(args.type));
    hits = hits.slice(0, limit);

    if (hits.length === 0) {
      say('没有匹配的资源候选');
      if (!args.npm) say('试试加 --npm（联网查 npm），或用 --catalog 指向一份资源目录');
      return;
    }

    if (args.add !== undefined) {
      const n = Number(args.add);
      if (!Number.isInteger(n) || n < 1 || n > hits.length) {
        problemRaw(`--add 超出范围：1..${hits.length}`);
        stop(EXIT.USAGE);
      }
      const pick = hits[n - 1]!.entry;
      const file = join(resolve(String(args.dir)), 'packhub.yaml');
      if (!existsSync(file)) {
        problemRaw(`没有 packhub.yaml：${file}（先跑 packhub init）`);
        stop(EXIT.USAGE);
      }
      const added = addResource(file, { type: pick.type, source: pick.source });
      say(`✓ 已追加资源 ${added.id}（${pick.type}）→ ${file}`);
      say(`  source: ${pick.source}`);
      say('下一步：packhub install . --dry-run 看计划');
      return;
    }

    if (args.json) {
      json({
            catalog: local.source,
            resources: hits.map((h) => ({ ...h.entry, score: h.score, matched: h.matched })),
          });
      return;
    }
    for (const [i, hit] of hits.entries()) {
      const e = hit.entry;
      say(`${String(i + 1).padStart(2)}. [${e.type.padEnd(9)}] ${e.title ?? e.id}`);
      say(`    ${e.source}`);
      if (e.description) say(`    ${e.description}`);
    }
    say(`\n目录：${local.source}${args.npm ? ' + npm search' : ''}`);
    say('写进清单：packhub discover "<关键词>" ' + (args.index ? `--index ${String(args.index)} ` : '') + `--add <序号> --dir .`);
  },
});

export const hub = command({
  meta: { name: 'hub', description: '启动只读发布端（索引、包数据、计划预览；没有执行接口）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    port: { type: 'string', default: '8788' },
    host: { type: 'string', default: '127.0.0.1', description: '非回环地址必须配鉴权' },
    token: { type: 'string', description: `静态 token（也可用 ${PACKHUB_ENV.hubToken}）` },
    'user-header': { type: 'string', description: '反向代理注入的身份头，例如 X-Forwarded-User' },
    audit: { type: 'string', description: '审计日志文件（每行一个 JSON）' },
    rpm: { type: 'string', default: '240', description: '每 IP 每分钟请求上限，0 不限' },
  },
  async run({ args }) {
    const wanted = Number(args.port);
    const server = await startHub({
      root: resolve(String(args.dir)),
      port: wanted,
      host: String(args.host),
      ...(args.token ? { auth: { token: String(args.token) } } : {}),
      ...(args['user-header'] ? { auth: { userHeader: String(args['user-header']) } } : {}),
      ...(args.audit ? { auditFile: resolve(String(args.audit)) } : {}),
      rpm: Number(args.rpm),
    }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        problemRaw(`端口 ${wanted} 已经被占用：换一个 --port（--port 0 让系统分配），或先停掉占用它的进程`);
        problemRaw(
          `  查占用：${process.platform === 'win32' ? `netstat -ano | findstr :${wanted}` : `lsof -iTCP:${wanted} -sTCP:LISTEN`}`,
        );
        stop(EXIT.USAGE);
      }
      throw err;
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : Number(args.port);
    say(`Hub（只读）→ http://${String(args.host)}:${port}  ${args.token || args['user-header'] ? '（已启用鉴权）' : '（回环，无鉴权）'}`);
    say('执行接口一个都没有；安装请用 packhub install / add');

    // 优雅退出：收到信号先停监听，等在途请求写完再走
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        say(`${signal} → 停止接收新请求`);
        server.close(() => terminate(EXIT.OK));
        setTimeout(() => terminate(EXIT.RUNTIME), 5000).unref();
      });
    }
  },
});
