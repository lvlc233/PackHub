import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packArchive } from '@packhub/runtime';

export interface MarketSession {
  url: string;
  token: string;
  scope: string;
  /** 发布者名（账号名） */
  name: string;
}

export interface MarketSessionFile {
  apiVersion: 'packhub.dev/market-session/v0';
  sessions: Record<string, MarketSession>;
}

export function sessionPath(): string {
  const home = process.env.PACKHUB_HOME ?? join(homedir(), '.packhub');
  return join(home, 'market.json');
}

export function readSessions(): MarketSessionFile {
  const file = sessionPath();
  if (!existsSync(file)) return { apiVersion: 'packhub.dev/market-session/v0', sessions: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<MarketSessionFile>;
    return { apiVersion: 'packhub.dev/market-session/v0', sessions: parsed.sessions ?? {} };
  } catch {
    return { apiVersion: 'packhub.dev/market-session/v0', sessions: {} };
  }
}

export function saveSession(session: MarketSession): void {
  const data = readSessions();
  data.sessions[session.url.replace(/\/+$/, '')] = {
    ...session,
    url: session.url.replace(/\/+$/, ''),
  };
  const file = sessionPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

export function defaultSession(url?: string): MarketSession {
  const sessions = readSessions().sessions;
  if (url) {
    const hit = sessions[url.replace(/\/+$/, '')];
    if (!hit) throw new Error(`没有 ${url} 的登录记录：先 packhub market login ${url} <token>`);
    return hit;
  }
  const all = Object.values(sessions);
  if (all.length === 0) throw new Error('还没有登录任何市场：先 packhub market register <url> <name>');
  if (all.length > 1) throw new Error(`登录了多个市场（${all.map((s) => s.url).join(', ')}），用 --url 指定`);
  return all[0]!;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function register(url: string, name: string): Promise<MarketSession> {
  const res = await fetch(`${url.replace(/\/+$/, '')}/api/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`注册失败：${await readError(res)}`);
  const body = (await res.json()) as { account: { name: string; scope: string }; token: string };
  const session: MarketSession = {
    url: url.replace(/\/+$/, ''),
    token: body.token,
    scope: body.account.scope,
    name: body.account.name,
  };
  saveSession(session);
  return session;
}

export async function login(url: string, token: string): Promise<MarketSession> {
  const base = url.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`登录失败：${await readError(res)}`);
  const me = (await res.json()) as { name: string; scope: string };
  const session: MarketSession = { url: base, token, scope: me.scope, name: me.name };
  saveSession(session);
  return session;
}

export interface PublishResponse {
  name: string;
  version: string;
  trust?: string;
  planHash?: string;
}

export async function publishToMarket(
  packDir: string,
  opts: { url?: string; token?: string } = {},
): Promise<PublishResponse> {
  const session = opts.url || opts.token ? undefined : defaultSession();
  const base = (opts.url ?? session?.url ?? '').replace(/\/+$/, '');
  const token = opts.token ?? session?.token;
  if (!base) throw new Error('要指定 --url（或用 packhub market login 保存过的地址）');
  if (!token) throw new Error('缺少 token：用 packhub market login 保存，或传 --token');

  const work = mkdtempSync(join(tmpdir(), 'packhub-market-up-'));
  try {
    const archive = join(work, 'upload.phub');
    await packArchive(packDir, { vendored: true, out: archive });
    const body = readFileSync(archive);
    const res = await fetch(`${base}/api/publish`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/gzip',
      },
      body,
    });
    if (!res.ok) throw new Error(`发布失败：${await readError(res)}`);
    return (await res.json()) as PublishResponse;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface MarketPack {
  name: string;
  title?: string;
  description?: string;
  latest: string;
  versions?: string[];
  trust?: string;
  downloads?: number;
  keywords?: string[];
}

export async function searchMarket(url: string, keyword: string): Promise<MarketPack[]> {
  const base = url.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/search?q=${encodeURIComponent(keyword)}`);
  if (!res.ok) throw new Error(`搜索失败：${await readError(res)}`);
  const body = (await res.json()) as { packs?: MarketPack[] };
  return body.packs ?? [];
}

export async function yankVersion(
  ref: string,
  opts: { url?: string; token?: string; reason?: string } = {},
): Promise<{ name: string; version: string }> {
  const session = opts.url || opts.token ? undefined : defaultSession();
  const base = (opts.url ?? session?.url ?? '').replace(/\/+$/, '');
  const token = opts.token ?? session?.token;
  if (!base || !token) throw new Error('要指定 --url 与 --token（或用已保存的登录）');
  const at = ref.lastIndexOf('@');
  if (at <= 0) throw new Error('用法：packhub market yank <name>@<version>');
  const res = await fetch(`${base}/api/yank`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: ref.slice(0, at),
      version: ref.slice(at + 1),
      reason: opts.reason ?? 'yanked by owner',
    }),
  });
  if (!res.ok) throw new Error(`下架失败：${await readError(res)}`);
  return (await res.json()) as { name: string; version: string };
}
