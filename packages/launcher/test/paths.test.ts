import { describe, expect, it } from 'vitest';
import { newId, stamp } from '../src/paths.ts';

// 固定毫秒：让「同一毫秒」的用例可复现，不用 sleep 也不用假时钟
const FIXED = new Date('2026-01-01T00:00:00.000Z');
const PREFIX = '20260101000000-';

/** id = 14 位时间戳 + `-` + 至少 8 位小写字母/数字 */
const ID_RE = /^\d{14}-[a-z0-9]{8,}$/;

function suffixOf(id: string): string {
  return id.slice(PREFIX.length);
}

describe('实例 id', () => {
  it('格式是 14 位时间戳 + 8 位以上随机后缀', () => {
    const id = newId(FIXED);
    expect(id).toMatch(ID_RE);
    expect(id.startsWith(PREFIX)).toBe(true);
    expect(suffixOf(id).length).toBeGreaterThanOrEqual(8);
    // 真实时间也一样：前缀就是当前的 stamp()
    expect(newId().startsWith(`${stamp()}-`)).toBe(true);
  });

  it('连续两次不同', () => {
    expect(newId(FIXED)).not.toBe(newId(FIXED));
    expect(newId()).not.toBe(newId());
  });

  it('同一毫秒生成 1000 个不重复', () => {
    const ids = Array.from({ length: 1000 }, () => newId(FIXED));
    expect(new Set(ids).size).toBe(1000);
    // 同一毫秒的 id 前缀一致，差异全在后缀
    for (const id of ids) expect(id.startsWith(PREFIX)).toBe(true);
  });

  it('后缀只含合法目录字符', () => {
    for (let i = 0; i < 200; i += 1) {
      const suffix = suffixOf(newId(FIXED));
      expect(suffix).toMatch(/^[a-z0-9]+$/);
      // 不出现路径分隔符、点、盘符等会让「id 当目录名/文件名」出事的东西
      expect(suffix).not.toMatch(/[\\/:*?"<>|.\s]/);
    }
  });

  it('前缀保持时间序：字符串排序等于时间排序', () => {
    const dates = [
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-01T00:00:01.000Z'),
      new Date('2025-12-31T23:59:59.000Z'),
    ];
    const ids = dates.map((d) => newId(d));
    expect([...ids].sort()).toEqual([ids[2], ids[0], ids[1]]);
  });

  it('stamp 语义不变：仍是 14 位、毫秒与分隔符都被去掉', () => {
    expect(stamp(FIXED)).toBe('20260101000000');
    expect(stamp(new Date('2026-11-09T19:00:23.456+08:00'))).toBe('20261109110023');
    expect(stamp(FIXED)).toMatch(/^\d{14}$/);
  });
});
