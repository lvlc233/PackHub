import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertApiVersion } from './apiVersion.ts';

export interface TrustedKey {
  key: string;
  label?: string;
  addedAt: string;
}

export interface TrustFile {
  apiVersion: 'packhub.dev/trust/v0';
  keys: TrustedKey[];
  /** 有信任列表时，默认只接受列表内签名 */
  requireSignature?: boolean;
}

const API = 'packhub.dev/trust/v0';

export function trustPath(): string {
  const home = process.env.PACKHUB_HOME ?? join(homedir(), '.packhub');
  return join(home, 'trust.json');
}

export function readTrust(): TrustFile {
  const file = trustPath();
  if (!existsSync(file)) return { apiVersion: API, keys: [] };
  let parsed: Partial<TrustFile>;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<TrustFile>;
  } catch {
    return { apiVersion: API, keys: [] };
  }
  assertApiVersion(file, parsed, API);
  return {
    apiVersion: API,
    keys: Array.isArray(parsed.keys) ? parsed.keys.filter((k) => k?.key) : [],
    ...(parsed.requireSignature === undefined ? {} : { requireSignature: parsed.requireSignature }),
  };
}

function writeTrust(data: TrustFile): void {
  const file = trustPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function addTrustedKey(key: string, label?: string): TrustedKey {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('公钥 id 不能为空');
  const data = readTrust();
  const existing = data.keys.find((k) => k.key === trimmed);
  if (existing) {
    if (label) existing.label = label;
  } else {
    data.keys.push({ key: trimmed, ...(label ? { label } : {}), addedAt: new Date().toISOString() });
  }
  writeTrust(data);
  return data.keys.find((k) => k.key === trimmed)!;
}

export function removeTrustedKey(key: string): boolean {
  const data = readTrust();
  const before = data.keys.length;
  data.keys = data.keys.filter((k) => k.key !== key);
  if (data.keys.length === before) return false;
  writeTrust(data);
  return true;
}

export function trustedKeyIds(): string[] {
  return readTrust().keys.map((k) => k.key);
}

/**
 * 要不要强制签名：
 * 显式 --require-signature > 显式 --allow-unsigned > trust.json.requireSignature > 有信任列表 > 不强制。
 * 有信任列表就只用列表里的公钥，绝不“任意签名都算”。
 */
export function signaturePolicy(explicit?: { require?: boolean; allowUnsigned?: boolean }): {
  require: boolean;
  trusted?: string[];
} {
  const trust = readTrust();
  const keys = trust.keys.map((k) => k.key);
  const require =
    explicit?.require === true
      ? true
      : explicit?.allowUnsigned === true
        ? false
        : trust.requireSignature === true || keys.length > 0;
  return { require, ...(keys.length > 0 ? { trusted: keys } : {}) };
}
