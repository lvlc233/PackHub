import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packArchive } from '@packhub/runtime';
import { materializePack, packCacheRoot, slug } from '../src/materialize.ts';
import { __cacheInternals, cacheStats, cleanCache, formatBytes, listCache, planClean, scanCache } from '../src/cache.ts';
import { PalError } from '../src/errors.ts';

let tmp: string;
let archive: string;
let other: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-cache-'));
  process.env.PACKHUB_HOME = tmp;
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  delete process.env.PACKHUB_INDEX;
  archive = join(tmp, 'pack.phub');
  await packArchive('examples/doc-review', { vendored: true, out: archive });
  // 同一份内容换个文件名：引用不同 → slug 不同 → 两条独立缓存
  other = join(tmp, 'other.phub');
  copyFileSync(archive, other);
});

afterEach(() => {
  delete process.env.PACKHUB_HOME;
  delete process.env.PACKHUB_INSTANCES;
  rmSync(tmp, { recursive: true, force: true });
});

async function fetchBoth(): Promise<{ a: string; b: string }> {
  const a = await materializePack(archive, { version: '0.1.0' });
  const b = await materializePack(other, { version: '0.1.0' });
  return { a, b };
}

function readMeta(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, '.pal-cache.json'), 'utf8')) as Record<string, unknown>;
}

describe('缓存条目形状', () => {
  it('取包后 meta 存在，ref / version / pack / source / fetchedAt 都对', async () => {
    const dir = await materializePack(archive, { version: '0.1.0' });
    const meta = readMeta(dir);
    expect(meta.ref).toBe(archive);
    expect(meta.version).toBe('0.1.0');
    expect(meta.pack).toBe('lvlc233/doc-review');
    expect(meta.source).toBe('archive');
    expect(String(meta.fetchedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('listCache 列出两条，大小 > 0，引用与目录对得上', async () => {
    const { a, b } = await fetchBoth();
    const entries = listCache();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.dir).sort()).toEqual([a, b].sort());
    for (const entry of entries) {
      expect(entry.meta).not.toBeNull();
      expect(entry.ref === archive || entry.ref === other).toBe(true);
      expect(entry.version).toBe('0.1.0');
      expect(entry.pack).toBe('lvlc233/doc-review');
      expect(entry.bytes).toBeGreaterThan(0);
      expect(entry.files).toBeGreaterThan(0);
      expect(entry.dir.startsWith(packCacheRoot())).toBe(true);
      expect(Number.isFinite(entry.mtimeMs)).toBe(true);
      expect(entry.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry.problems).toEqual([]);
    }
    const stats = cacheStats(entries);
    expect(stats.count).toBe(2);
    expect(stats.totalBytes).toBe(entries.reduce((sum, entry) => sum + entry.bytes, 0));
    expect(formatBytes(stats.totalBytes)).toMatch(/B|KB|MB/);
  });

  it('没有 meta 的旧目录也能列，meta 为 null、名字与版本从清单补', async () => {
    const { a } = await fetchBoth();
    const legacy = join(packCacheRoot(), 'legacy-deadbeef01', '1.0.0');
    mkdirSync(legacy, { recursive: true });
    copyFileSync(join(a, 'packhub.yaml'), join(legacy, 'packhub.yaml'));

    const entry = listCache().find((item) => item.dir === legacy);
    expect(entry).toBeDefined();
    expect(entry?.meta).toBeNull();
    expect(entry?.ref).toBeNull();
    expect(entry?.source).toBeNull();
    expect(entry?.fetchedAt).toBeNull();
    expect(entry?.pack).toBe('lvlc233/doc-review');
    expect(entry?.version).toBe('0.1.0');
    expect(entry?.bytes).toBeGreaterThan(0);
    expect(entry?.problems).toEqual([]);
  });

  it('meta 坏了照常列出条目，但把问题挂在条目上', async () => {
    const { a } = await fetchBoth();
    const legacy = join(packCacheRoot(), 'broken-meta-aaaaaaaaaa', '1.0.0');
    mkdirSync(legacy, { recursive: true });
    copyFileSync(join(a, 'packhub.yaml'), join(legacy, 'packhub.yaml'));
    writeFileSync(join(legacy, '.pal-cache.json'), '{ not json', 'utf8');

    const entry = listCache().find((item) => item.dir === legacy);
    expect(entry).toBeDefined();
    expect(entry?.meta).toBeNull();
    expect(entry?.version).toBe('0.1.0');
    expect(entry?.problems.join(' ')).toContain('JSON');
  });

  it('缓存根下的散文件 / 空 slug 目录 / 版本层是文件都跳过并报告', async () => {
    await fetchBoth();
    const root = packCacheRoot();
    writeFileSync(join(root, 'loose.txt'), 'x', 'utf8');
    mkdirSync(join(root, 'empty-slug'), { recursive: true });
    mkdirSync(join(root, 'slug-with-file'), { recursive: true });
    writeFileSync(join(root, 'slug-with-file', 'not-a-version'), 'x', 'utf8');

    const scan = scanCache();
    expect(scan.entries).toHaveLength(2);
    const dirs = scan.problems.map((problem) => problem.dir);
    expect(dirs).toContain(join(root, 'loose.txt'));
    expect(dirs).toContain(join(root, 'empty-slug'));
    expect(dirs).toContain(join(root, 'slug-with-file', 'not-a-version'));
    expect(scan.problems.every((problem) => problem.reason.length > 0)).toBe(true);
  });
});

describe('cleanCache 选择器', () => {
  it('--all 清空全部条目，并顺手删掉空的 slug 目录', async () => {
    await fetchBoth();
    const result = cleanCache({ all: true });
    expect(result.removed).toHaveLength(2);
    expect(result.kept).toBe(0);
    expect(result.errors).toEqual([]);
    expect(listCache()).toHaveLength(0);
    expect(readdirSync(packCacheRoot())).toEqual([]);
  });

  it('--ref 只清 meta.ref 匹配的那条', async () => {
    const { a, b } = await fetchBoth();
    const result = cleanCache({ ref: archive });
    expect(result.removed).toEqual([a]);
    expect(result.kept).toBe(1);
    const left = listCache();
    expect(left.map((entry) => entry.dir)).toEqual([b]);
    expect(left[0]?.ref).toBe(other);
    expect(existsSync(a)).toBe(false);
  });

  it('--ref 也认目录 slug（老缓存没有 meta 时）', async () => {
    const { a } = await fetchBoth();
    // 把 meta 删掉：模拟老缓存，只能靠目录名对上
    rmSync(join(a, '.pal-cache.json'));
    const result = cleanCache({ ref: slug(archive) });
    expect(result.removed).toEqual([a]);
    expect(listCache()).toHaveLength(1);
  });

  it('--older-than 只清目录 mtime 早于 N 天的条目', async () => {
    const { a, b } = await fetchBoth();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    // 只动目录 mtime：--older-than 的判定依据就是这个
    utimesSync(a, old, old);

    expect(planClean({ olderThanDays: 30 }).map((entry) => entry.dir)).toEqual([a]);
    const result = cleanCache({ olderThanDays: 30 });
    expect(result.removed).toEqual([a]);
    expect(result.kept).toBe(1);
    expect(listCache().map((entry) => entry.dir)).toEqual([b]);
  });

  it('没给选择器就报 invalid-input，绝不当成清全部', async () => {
    await fetchBoth();
    expect(() => cleanCache()).toThrowError(PalError);
    expect(() => planClean({})).toThrowError(PalError);
    try {
      cleanCache({});
    } catch (err) {
      expect(err).toBeInstanceOf(PalError);
      expect((err as PalError).code).toBe('invalid-input');
    }
    // 原封不动
    expect(listCache()).toHaveLength(2);
  });

  it('一次给两个选择器也不猜：直接拒绝', () => {
    expect(() => cleanCache({ all: true, ref: archive })).toThrowError(/只能给一个/);
    expect(() => cleanCache({ ref: archive, olderThanDays: 30 })).toThrowError(/只能给一个/);
    expect(() => cleanCache({ olderThanDays: -1 })).toThrowError(/非负/);
    expect(() => cleanCache({ ref: '  ' })).toThrowError(/非空/);
  });

  it('删一条失败不影响其它条目：失败收进 errors，其它照删', async () => {
    const { a, b } = await fetchBoth();
    const original = __cacheInternals.removeEntryDir;
    __cacheInternals.removeEntryDir = (dir: string) => {
      if (dir === a) throw new Error('EBUSY: 模拟被占用');
      original(dir);
    };
    try {
      const result = cleanCache({ all: true });
      expect(result.removed).toEqual([b]);
      expect(result.kept).toBe(1);
      expect(result.errors.join('\n')).toContain('EBUSY');
      expect(listCache().map((entry) => entry.dir)).toEqual([a]);
    } finally {
      __cacheInternals.removeEntryDir = original;
    }
  });

  it('clean --all 时坏目录不会被删，只作为 error 报出来', async () => {
    await fetchBoth();
    const root = packCacheRoot();
    writeFileSync(join(root, 'loose.txt'), 'x', 'utf8');
    const result = cleanCache({ all: true });
    expect(result.removed).toHaveLength(2);
    expect(result.errors.join('\n')).toContain('loose.txt');
    expect(existsSync(join(root, 'loose.txt'))).toBe(true);
  });
});
