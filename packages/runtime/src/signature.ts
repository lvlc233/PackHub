import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

/** 签名覆盖的内容：包名 + 版本 + planHash。改清单里的任何东西都会让 planHash 变。 */
export function signablePayload(pack: string, planHash: string): Buffer {
  return Buffer.from(JSON.stringify({ pack, planHash }), 'utf8');
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

export function signPlan(privatePem: string, pack: string, planHash: string): { key: string; sig: string; at: string } {
  const key = createPrivateKey(privatePem);
  const publicKey = keyIdFromPem(createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString());
  const sig = cryptoSign(null, signablePayload(pack, planHash), key).toString('base64');
  return { key: publicKey, sig, at: new Date().toISOString() };
}

export interface SignatureCheck {
  key: string;
  ok: boolean;
}

export function verifySignatures(
  signatures: { key: string; sig: string }[],
  pack: string,
  planHash: string,
): SignatureCheck[] {
  const payload = signablePayload(pack, planHash);
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
