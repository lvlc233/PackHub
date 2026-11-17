import { describe, expect, it } from 'vitest';
import { PACK_NAME_PATTERN as KERNEL_NAME_PATTERN } from '@packhub/kernel';
import { PACK_NAME_PATTERN, PACK_VERSION_PATTERN } from '../src/index.ts';

describe('Hub 的包名 / 版本号判据', () => {
  it('包名直接用 kernel 的那一条，不另写正则', () => {
    expect(PACK_NAME_PATTERN).toBe(KERNEL_NAME_PATTERN);
  });

  it('版本号从 schema 取，两端锚定（不是前缀匹配）', () => {
    expect(PACK_VERSION_PATTERN.test('0.1.0')).toBe(true);
    expect(PACK_VERSION_PATTERN.test('0.1.0-beta.1')).toBe(true);
    // 旧的前缀正则会把这三个都放过
    expect(PACK_VERSION_PATTERN.test('0.1.0beta')).toBe(false);
    expect(PACK_VERSION_PATTERN.test('0.1.0/..')).toBe(false);
    expect(PACK_VERSION_PATTERN.test('1.2')).toBe(false);
  });
});
