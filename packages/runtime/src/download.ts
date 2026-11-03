import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch as undiciFetch, ProxyAgent, setGlobalDispatcher } from 'undici';

let proxyReady = false;

/** 本机有 HTTPS_PROXY 时走代理（Node 自带的 fetch 不读环境变量）。 */
function ensureProxy(): void {
  if (proxyReady) return;
  proxyReady = true;
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY;
  if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));
}

export type FetchErrorCode =
  | 'unsupported-scheme'
  | 'not-found'
  | 'integrity-mismatch'
  | 'network'
  | 'http-status';

export class FetchError extends Error {
  readonly code: FetchErrorCode;

  constructor(message: string, code: FetchErrorCode) {
    super(message);
    this.code = code;
    this.name = 'FetchError';
  }
}

export interface FetchResult {
  file: string;
  bytes: number;
  /** 实际算出来的，`sha256-<base64>` 或 `sha512-<base64>` */
  integrity: string;
}

/** 解析 source 到真实下载地址。只支持 npm / github / https；pypi 留给 0.0.3。 */
export function resolveDownloadUrl(source: string): { url: string; kind: 'npm' | 'github' | 'http' } {
  if (source.startsWith('https://') || source.startsWith('http://')) {
    return { url: source, kind: 'http' };
  }
  if (source.startsWith('github:')) {
    const body = source.slice('github:'.length);
    const at = body.lastIndexOf('@');
    const target = at > 0 ? body.slice(0, at) : body;
    const ref = at > 0 ? body.slice(at + 1) : 'HEAD';
    const [owner, repo] = target.split('/');
    if (!owner || !repo) throw new FetchError(`github source 缺少 owner/repo：${source}`, 'not-found');
    return {
      url: `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`,
      kind: 'github',
    };
  }
  if (source.startsWith('npm:')) {
    const body = source.slice('npm:'.length);
    const at = body.lastIndexOf('@');
    const name = at > 0 ? body.slice(0, at) : body;
    const version = at > 0 ? body.slice(at + 1) : 'latest';
    return { url: `https://registry.npmjs.org/${name}/${version}`, kind: 'npm' };
  }
  if (source.startsWith('pypi:')) {
    throw new FetchError('pypi 的下载地址要查 PyPI 元数据，请用 resolvePypiSdist()', 'unsupported-scheme');
  }
  throw new FetchError(`无法下载的 source：${source}`, 'unsupported-scheme');
}

/** npm 的版本元数据里拿 tarball 与官方 integrity。 */
async function npmTarball(source: string): Promise<{ url: string; integrity?: string }> {
  const { url } = resolveDownloadUrl(source);
  ensureProxy();
  const res = await undiciFetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new FetchError(`npm 元数据请求失败 ${res.status}：${source}`, 'http-status');
  }
  const meta = (await res.json()) as {
    dist?: { tarball?: string; integrity?: string };
  };
  if (!meta.dist?.tarball) throw new FetchError(`npm 包没有 tarball：${source}`, 'not-found');
  return { url: meta.dist.tarball, integrity: meta.dist.integrity };
}

export interface DownloadOptions {
  headers?: Record<string, string>;
  /** 缺凭证时报错要指名的环境变量 */
  authHint?: string;
}

/** 只保留 host + path：URL 的查询串可能带凭证，不能进日志与报错。 */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

/** 下载到指定文件，边下边算哈希；expected 给了就必须匹配。 */
export async function download(
  source: string,
  dest: string,
  expectedIntegrity?: string,
  opts: DownloadOptions = {},
): Promise<FetchResult> {
  let url: string;
  let expected = expectedIntegrity;

  const kind = resolveDownloadUrl(source).kind;
  if (kind === 'npm') {
    const tarball = await npmTarball(source);
    url = tarball.url;
    expected = expected ?? tarball.integrity;
  } else {
    url = resolveDownloadUrl(source).url;
  }

  ensureProxy();
  const res = await undiciFetch(url, { redirect: 'follow', ...(opts.headers ? { headers: opts.headers } : {}) });
  if (!res.ok || !res.body) {
    const hint =
      res.status === 401 || res.status === 403
        ? `（鉴权失败${opts.authHint ? `：检查 ${opts.authHint} 是否有效` : '：该来源需要凭证'}）`
        : '';
    throw new FetchError(`下载失败 ${res.status}：${safeUrl(url)}${hint}`, 'http-status');
  }

  mkdirSync(dirname(dest), { recursive: true });
  const algorithm = expected?.startsWith('sha512-') ? 'sha512' : 'sha256';
  const hash = createHash(algorithm);

  const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  nodeStream.on('data', (chunk) => hash.update(chunk as Buffer));
  await pipeline(nodeStream, createWriteStream(dest));

  const actual = `${algorithm}-${hash.digest('base64')}`;
  if (expected && expected !== actual) {
    throw new FetchError(
      `完整性校验失败：期望 ${expected}，实际 ${actual}（${source}）`,
      'integrity-mismatch',
    );
  }
  return { file: dest, bytes: statSync(dest).size, integrity: actual };
}

export const __internals = { npmTarball };

export interface PypiSdist {
  url: string;
  filename: string;
  version: string;
}

interface PypiPayload {
  info?: { version?: string };
  urls?: {
    packagetype?: string;
    filename?: string;
    url?: string;
    yanked?: boolean;
    digests?: { sha256?: string };
  }[];
}

/**
 * 从 PyPI 的 JSON 元数据里挑源码包（sdist 的 .tar.gz）。
 * 只有 wheel 的包直接报错：wheel 是 zip，我们没有解包器，也不该把二进制当源码装。
 */
export function pickSdist(payload: PypiPayload): PypiSdist {
  const files = (payload.urls ?? []).filter((u) => u.url && u.filename && !u.yanked);
  const sdist = files.find(
    (u) => u.packagetype === 'sdist' && u.filename!.endsWith('.tar.gz'),
  );
  if (!sdist) {
    const wheelOnly = files.some((u) => u.packagetype === 'bdist_wheel');
    throw new FetchError(
      wheelOnly
        ? '这个包只发了 wheel（zip），没有 .tar.gz 源码包；PackHub 不装二进制，换别的来源或让作者补 sdist'
        : '这个版本没有可用的 .tar.gz 源码包',
      'not-found',
    );
  }
  return {
    url: sdist.url!,
    filename: sdist.filename!,
    version: payload.info?.version ?? '',
  };
}

/** `pypi:name@1.2.3` → 真正的 sdist 地址。pyPI 的 URL 带哈希，不能离线拼，只能查。 */
export async function resolvePypiSdist(spec: string): Promise<PypiSdist> {
  const body = spec.slice('pypi:'.length);
  const at = body.lastIndexOf('@');
  if (at <= 0) {
    throw new FetchError('pypi 来源必须 pin 到版本：pypi:name@1.2.3', 'unsupported-scheme');
  }
  const name = body.slice(0, at);
  const version = body.slice(at + 1);

  ensureProxy();
  let res: Response;
  try {
    res = (await undiciFetch(
      `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`,
      { headers: { accept: 'application/json' } },
    )) as unknown as Response;
  } catch (err) {
    throw new FetchError(`查 PyPI 元数据失败：${(err as Error).message}`, 'network');
  }
  if (!res.ok) {
    throw new FetchError(`PyPI 返回 ${res.status}：${name}@${version}`, 'not-found');
  }
  const payload = (await res.json()) as PypiPayload;
  return pickSdist(payload);
}
