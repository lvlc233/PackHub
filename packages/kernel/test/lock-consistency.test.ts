import { describe, expect, it } from 'vitest';
import type { LockFile, Manifest, ResolvedRef } from '../src/index.ts';
import { checkLockConsistency, contentHashOf } from '../src/index.ts';

const MANIFEST: Manifest = {
  apiVersion: 'packhub.dev/v0',
  kind: 'Pack',
  metadata: { name: 'demo/consistency', version: '0.0.1' },
  resources: [{ id: 'guide', type: 'knowledge', source: './guide.md' }],
};

const RESOLVED: ResolvedRef[] = [
  {
    id: 'guide',
    type: 'knowledge',
    source: './guide.md',
    integrity: null,
    resolvedAt: '2026-01-01T00:00:00.000Z',
  },
];

function lock(over: Partial<LockFile> = {}): LockFile {
  return {
    apiVersion: 'packhub.dev/lock/v0',
    pack: 'demo/consistency@0.0.1',
    resolved: RESOLVED,
    contentHash: contentHashOf(MANIFEST, RESOLVED),
    generatedBy: 'packhub/0.0.1',
    ...over,
  };
}

describe('锁 ↔ 清单一致性（纯判定，比 contentHash）', () => {
  it('没有锁（undefined / null）→ missing', () => {
    expect(checkLockConsistency(undefined, MANIFEST).status).toBe('missing');
    expect(checkLockConsistency(null, MANIFEST).status).toBe('missing');
  });

  it('按清单 + 锁的 resolved 重算一致 → ok', () => {
    const check = checkLockConsistency(lock(), MANIFEST);
    expect(check.status).toBe('ok');
    expect(check.expected).toBe(contentHashOf(MANIFEST, RESOLVED));
    expect(check.actual).toBe(check.expected);
  });

  it('清单在锁定后被改过 → mismatch，expected 取锁里的、actual 取重算的', () => {
    const changed: Manifest = {
      ...MANIFEST,
      resources: [{ id: 'guide', type: 'knowledge', source: './guide-v2.md' }],
    };
    const check = checkLockConsistency(lock(), changed);
    expect(check.status).toBe('mismatch');
    expect(check.expected).toBe(contentHashOf(MANIFEST, RESOLVED));
    expect(check.actual).toBe(contentHashOf(changed, RESOLVED));
    expect(check.message).toContain('清单在锁定后被改过');
  });

  it('锁里的 resolved 被改过 → mismatch（引用属于内容）', () => {
    const tampered = lock({
      resolved: [{ ...RESOLVED[0]!, source: 'github:demo/guide@0000000' }],
    });
    expect(checkLockConsistency(tampered, MANIFEST).status).toBe('mismatch');
  });

  it('旧版锁没有 contentHash → mismatch，提示重跑 lock', () => {
    const old = { ...lock(), contentHash: undefined } as unknown as LockFile;
    const check = checkLockConsistency(old, MANIFEST);
    expect(check.status).toBe('mismatch');
    expect(check.expected).toBeUndefined();
    expect(check.message).toContain('旧格式');
  });
});
