import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertApiVersion } from './apiVersion.ts';

export interface SignatureEntry {
  key: string;
  sig: string;
  at?: string;
}

/** 签名文件 packhub.signatures.json 的格式版本：写方与读方共用这一个常量。 */
const SIGNATURE_API_VERSION = 'packhub.dev/signatures/v0';

export interface SignatureFile {
  apiVersion: typeof SIGNATURE_API_VERSION;
  signatures: SignatureEntry[];
}

export const SIGNATURE_FILE = 'packhub.signatures.json';

/** 签名放独立文件，不动 packhub.yaml——版本目录的清单要保持不变。 */
export function readSignatures(dir: string): SignatureEntry[] {
  const file = join(dir, SIGNATURE_FILE);
  if (existsSync(file)) {
    let data: Partial<SignatureFile>;
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as Partial<SignatureFile>;
    } catch {
      return [];
    }
    assertApiVersion(file, data, SIGNATURE_API_VERSION);
    return Array.isArray(data.signatures) ? data.signatures : [];
  }
  return [];
}

export function writeSignature(dir: string, entry: SignatureEntry): void {
  const current = readSignatures(dir).filter((s) => s.key !== entry.key);
  const data: SignatureFile = {
    apiVersion: SIGNATURE_API_VERSION,
    signatures: [...current, entry],
  };
  writeFileSync(join(dir, SIGNATURE_FILE), JSON.stringify(data, null, 2) + '\n', 'utf8');
}
