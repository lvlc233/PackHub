import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as Database } from 'node:sqlite';

// 走 require 而不是静态 import：Vite 5 的内置模块表不认识 node:sqlite，
// 测试里静态导入会被当成普通 npm 包去解析。
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface MarketAccount {
  id: string;
  name: string;
  /** 该账号只能发布自己 scope 下的包 */
  scope: string;
  tokenHash: string;
  createdAt: string;
}

/** 读侧快照：管理接口与搜索一次拿全，写侧不再整库覆盖。 */
export interface MarketDb {
  apiVersion: 'packhub.dev/market/v0';
  accounts: Record<string, MarketAccount>;
  /** name@version → 下载次数 */
  stats: Record<string, { downloads: number; updatedAt: string; daily?: Record<string, number> }>;
  /** name@version → 审核状态 */
  reviews: Record<string, { status: 'approved' | 'pending' | 'rejected'; note?: string; at: string }>;
  /** name@version → 下架原因 */
  yanked: Record<string, string>;
  /** name@version → 每个账号一票的评分与评论 */
  ratings: Record<string, Record<string, { score: number; comment?: string; at: string }>>;
}

const API = 'packhub.dev/market/v0';

export function dbPath(root: string): string {
  return join(root, '.market', 'market.db');
}

/** 旧版单文件 JSON；首次打开新库时导入并改名，保留作回滚证据。 */
export function legacyDbPath(root: string): string {
  return join(root, '.market', 'db.json');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stats (
  pack_version TEXT PRIMARY KEY,
  downloads INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stats_daily (
  pack_version TEXT NOT NULL,
  day TEXT NOT NULL,
  downloads INTEGER NOT NULL,
  PRIMARY KEY (pack_version, day)
);
CREATE TABLE IF NOT EXISTS reviews (
  pack_version TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  note TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS yanked (
  pack_version TEXT PRIMARY KEY,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ratings (
  pack_version TEXT NOT NULL,
  account_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  comment TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (pack_version, account_id)
);
`;

interface LegacyMarketDb extends Partial<MarketDb> {}

/**
 * 每次操作开一个连接：单机市场写入不频繁，换来的是没有长连接占着文件
 * （Windows 上测试/卸载目录时尤其重要）。WAL 让读不会被写卡住。
 */
function withDb<T>(root: string, fn: (db: Database) => T): T {
  mkdirSync(join(root, '.market'), { recursive: true });
  const db = new DatabaseSync(dbPath(root));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);
    migrateLegacy(root, db);
    return fn(db);
  } finally {
    db.close();
  }
}

function tableEmpty(db: Database, table: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return Number(row?.n ?? 0) === 0;
}

/** 只在所有表都空时导入旧 JSON，避免覆盖已经在用的 SQLite 数据。 */
function migrateLegacy(root: string, db: Database): void {
  const legacy = legacyDbPath(root);
  if (!existsSync(legacy)) return;
  if (!tableEmpty(db, 'accounts') || !tableEmpty(db, 'reviews') || !tableEmpty(db, 'stats')) return;
  let parsed: LegacyMarketDb;
  try {
    parsed = JSON.parse(readFileSync(legacy, 'utf8')) as LegacyMarketDb;
  } catch {
    return;
  }
  const insertAccount = db.prepare(
    'INSERT OR IGNORE INTO accounts (id, name, scope, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertStats = db.prepare(
    'INSERT OR REPLACE INTO stats (pack_version, downloads, updated_at) VALUES (?, ?, ?)',
  );
  const insertDaily = db.prepare(
    'INSERT OR REPLACE INTO stats_daily (pack_version, day, downloads) VALUES (?, ?, ?)',
  );
  const insertReview = db.prepare(
    'INSERT OR REPLACE INTO reviews (pack_version, status, note, at) VALUES (?, ?, ?, ?)',
  );
  const insertYanked = db.prepare('INSERT OR REPLACE INTO yanked (pack_version, reason) VALUES (?, ?)');
  const insertRating = db.prepare(
    'INSERT OR REPLACE INTO ratings (pack_version, account_id, score, comment, at) VALUES (?, ?, ?, ?, ?)',
  );

  db.exec('BEGIN');
  try {
    for (const account of Object.values(parsed.accounts ?? {})) {
      insertAccount.run(account.id, account.name, account.scope, account.tokenHash, account.createdAt);
    }
    for (const [key, stat] of Object.entries(parsed.stats ?? {})) {
      insertStats.run(key, stat.downloads, stat.updatedAt);
      for (const [day, downloads] of Object.entries(stat.daily ?? {})) insertDaily.run(key, day, downloads);
    }
    for (const [key, review] of Object.entries(parsed.reviews ?? {})) {
      insertReview.run(key, review.status, review.note ?? null, review.at);
    }
    for (const [key, reason] of Object.entries(parsed.yanked ?? {})) insertYanked.run(key, reason);
    for (const [key, votes] of Object.entries(parsed.ratings ?? {})) {
      for (const [accountId, vote] of Object.entries(votes)) {
        insertRating.run(key, accountId, vote.score, vote.comment ?? null, vote.at);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  // 导入成功才改名；失败时旧文件还在，下次还能重试
  renameSync(legacy, `${legacy}.migrated`);
}

/** 读侧快照；数据量是「一个市场的包与账号」，一次读全比维护两套查询简单。 */
export function loadDb(root: string): MarketDb {
  const out: MarketDb = {
    apiVersion: API,
    accounts: {},
    stats: {},
    reviews: {},
    yanked: {},
    ratings: {},
  };
  return withDb(root, (db) => {
    for (const row of db.prepare('SELECT * FROM accounts').all() as Record<string, string>[]) {
      out.accounts[row.id!] = {
        id: row.id!,
        name: row.name!,
        scope: row.scope!,
        tokenHash: row.token_hash!,
        createdAt: row.created_at!,
      };
    }
    for (const row of db.prepare('SELECT * FROM stats').all() as Record<string, string | number>[]) {
      out.stats[String(row.pack_version)] = {
        downloads: Number(row.downloads),
        updatedAt: String(row.updated_at),
        daily: {},
      };
    }
    for (const row of db.prepare('SELECT * FROM stats_daily').all() as Record<string, string | number>[]) {
      const key = String(row.pack_version);
      const entry = out.stats[key] ?? { downloads: 0, updatedAt: '' };
      entry.daily = { ...(entry.daily ?? {}), [String(row.day)]: Number(row.downloads) };
      out.stats[key] = entry;
    }
    for (const row of db.prepare('SELECT * FROM reviews').all() as Record<string, string | null>[]) {
      out.reviews[String(row.pack_version)] = {
        status: String(row.status) as 'approved' | 'pending' | 'rejected',
        ...(row.note ? { note: row.note } : {}),
        at: String(row.at),
      };
    }
    for (const row of db.prepare('SELECT * FROM yanked').all() as Record<string, string>[]) {
      out.yanked[row.pack_version!] = row.reason!;
    }
    for (const row of db.prepare('SELECT * FROM ratings').all() as Record<string, string | number | null>[]) {
      const key = String(row.pack_version);
      const list = out.ratings[key] ?? {};
      list[String(row.account_id)] = {
        score: Number(row.score),
        ...(row.comment ? { comment: String(row.comment) } : {}),
        at: String(row.at),
      };
      out.ratings[key] = list;
    }
    return out;
  });
}

/** 兼容旧调用：整库落盘只在测试/维护脚本里用，正常写入走下面的单条语句。 */
export function saveDb(root: string, data: MarketDb): void {
  withDb(root, (db) => {
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM accounts; DELETE FROM stats; DELETE FROM stats_daily; DELETE FROM reviews; DELETE FROM yanked; DELETE FROM ratings;');
      for (const account of Object.values(data.accounts)) {
        db.prepare(
          'INSERT INTO accounts (id, name, scope, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(account.id, account.name, account.scope, account.tokenHash, account.createdAt);
      }
      for (const [key, stat] of Object.entries(data.stats)) {
        db.prepare('INSERT INTO stats (pack_version, downloads, updated_at) VALUES (?, ?, ?)').run(
          key,
          stat.downloads,
          stat.updatedAt,
        );
        for (const [day, downloads] of Object.entries(stat.daily ?? {})) {
          db.prepare(
            'INSERT INTO stats_daily (pack_version, day, downloads) VALUES (?, ?, ?)',
          ).run(key, day, downloads);
        }
      }
      for (const [key, review] of Object.entries(data.reviews)) {
        db.prepare('INSERT INTO reviews (pack_version, status, note, at) VALUES (?, ?, ?, ?)').run(
          key,
          review.status,
          review.note ?? null,
          review.at,
        );
      }
      for (const [key, reason] of Object.entries(data.yanked)) {
        db.prepare('INSERT INTO yanked (pack_version, reason) VALUES (?, ?)').run(key, reason);
      }
      for (const [key, votes] of Object.entries(data.ratings)) {
        for (const [accountId, vote] of Object.entries(votes)) {
          db.prepare(
            'INSERT INTO ratings (pack_version, account_id, score, comment, at) VALUES (?, ?, ?, ?, ?)',
          ).run(key, accountId, vote.score, vote.comment ?? null, vote.at);
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });
}

export { hashToken };

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
  const scope = scopeOf(name);
  if (!scope) throw new Error('账号名至少要有一个字母或数字');
  const existing = withDb(root, (db) =>
    db.prepare('SELECT id FROM accounts WHERE scope = ?').get(scope),
  );
  if (existing) throw new Error(`这个 scope 已经被占用：${scope}`);

  const token = randomBytes(24).toString('base64url');
  const account: MarketAccount = {
    id: randomBytes(8).toString('hex'),
    name: name.trim(),
    scope,
    tokenHash: hashToken(token),
    createdAt: new Date().toISOString(),
  };
  try {
    withDb(root, (db) =>
      db
        .prepare('INSERT INTO accounts (id, name, scope, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(account.id, account.name, account.scope, account.tokenHash, account.createdAt),
    );
  } catch {
    throw new Error(`这个 scope 已经被占用：${scope}`);
  }
  return { account, token };
}

export function accountForToken(root: string, token: string): MarketAccount | undefined {
  if (!token) return undefined;
  const hash = hashToken(token);
  const row = withDb(root, (db) =>
    db.prepare('SELECT * FROM accounts WHERE token_hash = ?').get(hash),
  ) as Record<string, string> | undefined;
  if (!row) return undefined;
  return {
    id: row.id!,
    name: row.name!,
    scope: row.scope!,
    tokenHash: row.token_hash!,
    createdAt: row.created_at!,
  };
}

export function recordReview(
  root: string,
  pack: string,
  version: string,
  status: 'approved' | 'rejected' | 'pending',
  note?: string,
): void {
  withDb(root, (db) =>
    db
      .prepare('INSERT OR REPLACE INTO reviews (pack_version, status, note, at) VALUES (?, ?, ?, ?)')
      .run(`${pack}@${version}`, status, note ?? null, new Date().toISOString()),
  );
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
  withDb(root, (db) =>
    db
      .prepare(
        'INSERT OR REPLACE INTO ratings (pack_version, account_id, score, comment, at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(`${pack}@${version}`, accountId, score, comment ?? null, new Date().toISOString()),
  );
}

export function ratingSummary(root: string, pack: string, version: string): RatingSummary {
  return withDb(root, (db) => {
    const rows = db
      .prepare(
        `SELECT r.score AS score, r.comment AS comment, a.name AS name
         FROM ratings r LEFT JOIN accounts a ON a.id = r.account_id
         WHERE r.pack_version = ? ORDER BY r.at DESC`,
      )
      .all(`${pack}@${version}`) as { score: number; comment: string | null; name: string | null }[];
    return {
      count: rows.length,
      average: rows.length ? rows.reduce((n, r) => n + Number(r.score), 0) / rows.length : null,
      comments: rows
        .filter((r) => r.comment)
        .map((r) => ({
          by: r.name ?? '已注销账号',
          score: Number(r.score),
          ...(r.comment ? { comment: r.comment } : {}),
        })),
    };
  });
}

export interface DailyDownloads {
  day: string;
  downloads: number;
}

/** 最近 N 天的下载趋势（没有记录的日期补 0）。 */
export function downloadTrend(
  root: string,
  pack: string,
  version: string,
  days = 7,
): DailyDownloads[] {
  const rows = withDb(root, (db) =>
    db
      .prepare('SELECT day, downloads FROM stats_daily WHERE pack_version = ?')
      .all(`${pack}@${version}`),
  ) as { day: string; downloads: number }[];
  const byDay = new Map(rows.map((r) => [String(r.day), Number(r.downloads)]));
  const out: DailyDownloads[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, downloads: byDay.get(day) ?? 0 });
  }
  return out;
}

export function bumpDownload(root: string, pack: string, version: string): number {
  const key = `${pack}@${version}`;
  const day = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  return withDb(root, (db) => {
    db.exec('BEGIN');
    try {
      const row = db.prepare('SELECT downloads FROM stats WHERE pack_version = ?').get(key) as
        | { downloads: number }
        | undefined;
      const downloads = Number(row?.downloads ?? 0) + 1;
      db.prepare('INSERT OR REPLACE INTO stats (pack_version, downloads, updated_at) VALUES (?, ?, ?)').run(
        key,
        downloads,
        now,
      );
      db.prepare(
        `INSERT INTO stats_daily (pack_version, day, downloads) VALUES (?, ?, 1)
         ON CONFLICT(pack_version, day) DO UPDATE SET downloads = downloads + 1`,
      ).run(key, day);
      db.exec('COMMIT');
      return downloads;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });
}

export function markYanked(root: string, pack: string, version: string, reason: string): void {
  withDb(root, (db) =>
    db
      .prepare('INSERT OR REPLACE INTO yanked (pack_version, reason) VALUES (?, ?)')
      .run(`${pack}@${version}`, reason),
  );
}
