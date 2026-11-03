import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SignatureEntry {
  key: string;
  sig: string;
  at?: string;
}

export interface SignatureFile {
  apiVersion: 'packhub.dev/signatures/v0';
  signatures: SignatureEntry[];
}

export const SIGNATURE_FILE = 'packhub.signatures.json';

/** 签名放独立文件，不动 packhub.yaml——版本目录的清单要保持不变。 */
export function readSignatures(dir: string): SignatureEntry[] {
  const file = join(dir, SIGNATURE_FILE);
  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<SignatureFile>;
      return Array.isArray(data.signatures) ? data.signatures : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function writeSignature(dir: string, entry: SignatureEntry): void {
  const current = readSignatures(dir).filter((s) => s.key !== entry.key);
  const data: SignatureFile = {
    apiVersion: 'packhub.dev/signatures/v0',
    signatures: [...current, entry],
  };
  writeFileSync(join(dir, SIGNATURE_FILE), JSON.stringify(data, null, 2) + '\n', 'utf8');
}
