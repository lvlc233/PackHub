import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json' with { type: 'json' };
import type { Manifest } from '../src/index.ts';
import { buildLock } from '../src/index.ts';

const MANIFEST: Manifest = {
  apiVersion: 'packhub.dev/v0',
  kind: 'Pack',
  metadata: { name: 'demo/lock', version: '0.0.1', targets: ['dir'] },
  requires: { packhub: '>=0.0.1 <0.1' },
  resources: [],
};

describe('buildLock', () => {
  it('generatedBy 取仓库 package.json 的版本，不留手写字面量', () => {
    const lock = buildLock(MANIFEST);
    expect(lock.generatedBy).toBe(`packhub/${pkg.version}`);
  });

  it('contentHash 只随清单与 resolved 变，重跑 lock 不变（resolvedAt 不进哈希）', () => {
    const first = buildLock(MANIFEST, { resolvedAt: '2026-01-01T00:00:00.000Z' });
    const second = buildLock(MANIFEST, { resolvedAt: '2026-02-02T00:00:00.000Z' });
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.contentHash).toMatch(/^sha256-/);

    const changed = buildLock({
      ...MANIFEST,
      metadata: { ...MANIFEST.metadata, version: '0.0.2' },
    });
    expect(changed.contentHash).not.toBe(first.contentHash);
  });

  it('锁里没有计划字段：只有引用与内容哈希', () => {
    const lock = buildLock(MANIFEST);
    expect(Object.keys(lock).sort()).toEqual(['apiVersion', 'contentHash', 'generatedBy', 'pack', 'resolved']);
  });
});
