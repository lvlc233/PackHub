import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generateKeyPair,
  readSignatures,
  signPlan,
  verifySignatures,
  writeSignature,
} from '../src/index.ts';


describe('签名', () => {
  it('签出的签名能验过', () => {
    const { privatePem, publicKey } = generateKeyPair();
    const sig = signPlan(privatePem, 'demo/x@0.0.1', 'sha256-abc');
    expect(sig.key).toBe(publicKey);
    expect(verifySignatures([sig], 'demo/x@0.0.1', 'sha256-abc')).toEqual([
      { key: publicKey, ok: true },
    ]);
  });

  it('计划变了签名就失效', () => {
    const { privatePem } = generateKeyPair();
    const sig = signPlan(privatePem, 'demo/x@0.0.1', 'sha256-abc');
    expect(verifySignatures([sig], 'demo/x@0.0.1', 'sha256-other')[0]!.ok).toBe(false);
  });

  it('包名变了也算篡改', () => {
    const { privatePem } = generateKeyPair();
    const sig = signPlan(privatePem, 'demo/x@0.0.1', 'sha256-abc');
    expect(verifySignatures([sig], 'demo/y@0.0.1', 'sha256-abc')[0]!.ok).toBe(false);
  });

  it('别人的签名验不过', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const sig = signPlan(a.privatePem, 'demo/x@0.0.1', 'sha256-abc');
    const forged = { ...sig, key: b.publicKey };
    expect(verifySignatures([forged], 'demo/x@0.0.1', 'sha256-abc')[0]!.ok).toBe(false);
  });

  it('坏签名不抛错，只返回 false', () => {
    const { publicKey } = generateKeyPair();
    expect(verifySignatures([{ key: publicKey, sig: 'not-base64!!' }], 'x', 'y')[0]!.ok).toBe(false);
  });
});
describe('签名旁挂文件', () => {
  it('写进 packhub.signatures.json，不改清单', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-sigfile-'));
    const { privatePem } = generateKeyPair();
    const sig = signPlan(privatePem, 'demo/x@0.0.1', 'sha256-abc');
    writeSignature(dir, sig);
    const read = readSignatures(dir);
    expect(read).toHaveLength(1);
    expect(read[0]!.key).toBe(sig.key);
    // 同一个 key 再签一次是覆盖，不是追加
    writeSignature(dir, { ...sig, sig: sig.sig + 'x' });
    expect(readSignatures(dir)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});