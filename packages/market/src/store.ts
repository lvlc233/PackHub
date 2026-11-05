import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MarketAccount {
  id: string;
  name: string;
  /** 该账号只能发布自己 scope 下的包 */
  scope: string;
  tokenHash: string;
  createdAt: string;
}

export interface MarketDb {
  apiVersion: 'packhub.dev/market/v0';
  accounts: Record<string, MarketAccount>;
  /** name@version → 下载次数 */
  stats: Record<string, { downloads: number; updatedAt: string }>;
  /** name@version → 审核状态；上传即自动审核（因为已跑过干净安装） */
  reviews: Record<string, { status: 'approved' | 'pending' | 'rejected'; note?: string; at: string }>;
  /** name@version → 下架原因；下架后版本目录移到 quarantine */
  yanked: Record<string, string>;
  /** name@version → 每个账号一票的评分与评论 */
  ratings: Record<string, Record<string, { score: number; comment?: string; at: string }>>;
}

const API = 'packhub.dev/market/v0';

export function dbPath(root: string): string {
  return join(root, '.market', 'db.json');
}

export function loadDb(root: string): MarketDb {
  const file = dbPath(root);
  if (!existsSync(file)) {
    return { apiVersion: API, accounts: {}, stats: {}, reviews: {}, yanked: {}, ratings: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<MarketDb>;
    return {
      apiVersion: API,
      accounts: parsed.accounts ?? {},
      stats: parsed.stats ?? {},
      reviews: parsed.reviews ?? {},
      yanked: parsed.yanked ?? {},
      ratings: parsed.ratings ?? {},
    };
  } catch {
    return { apiVersion: API, accounts: {}, stats: {}, reviews: {}, yanked: {}, ratings: {} };
  }
}

export function saveDb(root: string, db: MarketDb): void {
  const file = dbPath(root);
  mkdirSync(join(root, '.market'), { recursive: true });
  writeFileSync(file, JSON.stringify(db, null, 2) + '\n', 'utf8');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 账号名 → scope：只留小写字母数字与连字符。 */
export function scopeOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 39);
}

export interface CreatedAccount {
  account: MarketAccount;
  /** 只在创建时返回一次 */
  token: string;
}

export function createAccount(root: string, name: string): CreatedAccount {
  const db = loadDb(root);
  const scope = scopeOf(name);
  if (!scope) throw new Error('账号名至少要有一个字母或数字');
  if (Object.values(db.accounts).some((a) => a.scope === scope)) {
    throw new Error(`这个 scope 已经被占用：${scope}`);
  }
  const token = randomBytes(24).toString('base64url');
  const account: MarketAccount = {
    id: randomBytes(8).toString('hex'),
    name: name.trim(),
    scope,
    tokenHash: hashToken(token),
    createdAt: new Date().toISOString(),
  };
  db.accounts[account.id] = account;
  saveDb(root, db);
  return { account, token };
}

export function accountForToken(root: string, token: string): MarketAccount | undefined {
  if (!token) return undefined;
  const hash = hashToken(token);
  return Object.values(loadDb(root).accounts).find((a) => a.tokenHash === hash);
}

export function recordReview(root: string, pack: string, version: string, status: 'approved' | 'rejected', note?: string): void {
  const db = loadDb(root);
  db.reviews[`${pack}@${version}`] = {
    status,
    ...(note ? { note } : {}),
    at: new Date().toISOString(),
  };
  saveDb(root, db);
}

export interface RatingSummary {
  count: number;
  average: number | null;
  comments: { by: string; score: number; comment?: string }[];
}

export function ratePack(
  root: string,
  pack: string,
  version: string,
  accountId: string,
  score: number,
  comment?: string,
): void {
  if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error('评分必须是 1..5 的整数');
  const db = loadDb(root);
  const key = `${pack}@${version}`;
  const list = db.ratings[key] ?? {};
  list[accountId] = { score, ...(comment ? { comment } : {}), at: new Date().toISOString() };
  db.ratings[key] = list;
  saveDb(root, db);
}

export function ratingSummary(root: string, pack: string, version: string): RatingSummary {
  const db = loadDb(root);
  const list = db.ratings[`${pack}@${version}`] ?? {};
  const rows = Object.entries(list);
  const names = new Map(Object.values(db.accounts).map((a) => [a.id, a.name]));
  return {
    count: rows.length,
    average: rows.length ? rows.reduce((n, [, r]) => n + r.score, 0) / rows.length : null,
    comments: rows
      .filter(([, r]) => r.comment)
      .map(([id, r]) => ({
        by: names.get(id) ?? id,
        score: r.score,
        ...(r.comment ? { comment: r.comment } : {}),
      })),
  };
}
export function bumpDownload(root: string, pack: string, version: string): number {
  const db = loadDb(root);
  const key = `${pack}@${version}`;
  const entry = db.stats[key] ?? { downloads: 0, updatedAt: '' };
  entry.downloads += 1;
  entry.updatedAt = new Date().toISOString();
  db.stats[key] = entry;
  saveDb(root, db);
  return entry.downloads;
}
