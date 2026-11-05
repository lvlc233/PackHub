import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountForToken,
  bumpDownload,
  dbPath,
  downloadTrend,
  hashToken,
  legacyDbPath,
  loadDb,
  ratePack,
  recordReview,
  markYanked,
} from '../src/index.ts';

const dirs: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'packhub-market-store-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('市场 SQLite 存储', () => {
  it('首次打开时把旧 db.json 迁进 SQLite，并保留 .migrated 备份', () => {
    const root = temp();
    mkdirSync(join(root, '.market'), { recursive: true });
    const token = 'legacy-token';
    writeFileSync(
      legacyDbPath(root),
      JSON.stringify({
        apiVersion: 'packhub.dev/market/v0',
        accounts: {
          a1: { id: 'a1', name: 'Legacy', scope: 'legacy', tokenHash: hashToken(token), createdAt: '2026-01-01T00:00:00.000Z' },
        },
        stats: { 'legacy/rules@0.1.0': { downloads: 3, updatedAt: '2026-01-01T00:00:00.000Z', daily: { '2026-01-01': 3 } } },
        reviews: { 'legacy/rules@0.1.0': { status: 'approved', note: 'ok', at: '2026-01-01T00:00:00.000Z' } },
        yanked: {},
        ratings: { 'legacy/rules@0.1.0': { a1: { score: 4, comment: '好', at: '2026-01-01T00:00:00.000Z' } } },
      }),
      'utf8',
    );

    const db = loadDb(root);
    expect(Object.keys(db.accounts)).toEqual(['a1']);
    expect(db.stats['legacy/rules@0.1.0']?.downloads).toBe(3);
    expect(db.reviews['legacy/rules@0.1.0']?.status).toBe('approved');
    expect(db.ratings['legacy/rules@0.1.0']?.a1?.score).toBe(4);
    expect(accountForToken(root, token)?.scope).toBe('legacy');
    expect(existsSync(dbPath(root))).toBe(true);
    expect(existsSync(`${legacyDbPath(root)}.migrated`)).toBe(true);

    // 再读一次不会重复导入 / 覆盖新写入
    bumpDownload(root, 'legacy/rules', '0.1.0');
    const again = loadDb(root);
    expect(again.stats['legacy/rules@0.1.0']?.downloads).toBe(4);
    expect(downloadTrend(root, 'legacy/rules', '0.1.0')[6]?.downloads).toBe(1);
  });

  it('写入落到 SQLite，跨连接可见；评分一账号一票', () => {
    const root = temp();
    bumpDownload(root, 'demo/x', '0.1.0');
    bumpDownload(root, 'demo/x', '0.1.0');
    recordReview(root, 'demo/x', '0.1.0', 'pending', 'wait');
    markYanked(root, 'demo/x', '0.0.9', 'old');
    ratePack(root, 'demo/x', '0.1.0', 'a1', 5, '很好');
    ratePack(root, 'demo/x', '0.1.0', 'a1', 3, '改主意了');

    const db = loadDb(root);
    expect(db.stats['demo/x@0.1.0']?.downloads).toBe(2);
    expect(db.reviews['demo/x@0.1.0']).toEqual(
      expect.objectContaining({ status: 'pending', note: 'wait' }),
    );
    expect(db.yanked['demo/x@0.0.9']).toBe('old');
    expect(db.ratings['demo/x@0.1.0']?.a1?.score).toBe(3);
    const raw = readFileSync(dbPath(root));
    expect(raw.subarray(0, 15).toString()).toBe('SQLite format 3');
  });
});
