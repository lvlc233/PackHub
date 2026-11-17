import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * 签名覆盖的内容：包名 + 版本 + `contentHash`。
 * contentHash 由 kernel 的 `contentHashOf(清单, 锁的 resolved)` 算出：改清单或改锁里的引用都会让它变。
 * 安装 target 不在载荷里——它是安装期参数，不是内容。
 */
export function signablePayload(pack: string, contentHash: string): Buffer {
  return Buffer.from(JSON.stringify({ pack, contentHash }), 'utf8');
}

export interface KeyPair {
  privatePem: string;
  /** 32 字节公钥的 base64，用作 key id */
  publicKey: string;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: Buffer.from(spki.subarray(spki.length - 32)).toString('base64'),
  };
}

export function keyIdFromPem(publicPem: string): string {
  const key = createPublicKey(publicPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(der.length - 32)).toString('base64');
}

/**
 * 用私钥签 `{pack, contentHash}`。
 *
 * 旧名 `signPlan`：计划不再进锁，锁只描述内容，签的就是锁的 contentHash（口径见 kernel
 * `contentHashOf`）。调用方必须先拿到锁再签，不要把安装期现算的计划哈希签进来。
 */
export function signContentHash(
  privatePem: string,
  pack: string,
  contentHash: string,
): { key: string; sig: string; at: string } {
  const key = createPrivateKey(privatePem);
  const publicKey = keyIdFromPem(createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString());
  const sig = cryptoSign(null, signablePayload(pack, contentHash), key).toString('base64');
  return { key: publicKey, sig, at: new Date().toISOString() };
}

export interface SignatureCheck {
  key: string;
  ok: boolean;
}

export function verifySignatures(
  signatures: { key: string; sig: string }[],
  pack: string,
  contentHash: string,
): SignatureCheck[] {
  const payload = signablePayload(pack, contentHash);
  return signatures.map(({ key, sig }) => {
    try {
      const der = Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(key, 'base64'),
      ]);
      const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
      return { key, ok: cryptoVerify(null, payload, publicKey, Buffer.from(sig, 'base64')) };
    } catch {
      return { key, ok: false };
    }
  });
}

export function loadPrivateKey(path: string): string {
  return readFileSync(path, 'utf8');
}
