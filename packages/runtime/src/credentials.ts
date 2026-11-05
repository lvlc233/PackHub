import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CredentialEntry {
  value: string;
  updatedAt: string;
}

export interface CredentialFile {
  apiVersion: 'packhub.dev/credentials/v0';
  tokens: Record<string, CredentialEntry>;
}

const API = 'packhub.dev/credentials/v0';

/** 凭据库位置：默认 ~/.packhub/credentials.json，PACKHUB_HOME 可覆盖（测试与多环境）。 */
export function credentialsPath(): string {
  const home = process.env.PACKHUB_HOME ?? join(homedir(), '.packhub');
  return join(home, 'credentials.json');
}

export function readCredentials(): CredentialFile {
  const file = credentialsPath();
  if (!existsSync(file)) return { apiVersion: API, tokens: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CredentialFile>;
    return { apiVersion: API, tokens: parsed.tokens ?? {} };
  } catch {
    return { apiVersion: API, tokens: {} };
  }
}

function writeCredentials(data: CredentialFile): void {
  const file = credentialsPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  // Windows 上 mode 基本是提示；POSIX 上收紧到 0600
  try {
    chmodSync(file, 0o600);
  } catch {
    /* 平台不支持就算了 */
  }
}

export function setToken(name: string, value: string): CredentialEntry {
  const data = readCredentials();
  const entry: CredentialEntry = { value, updatedAt: new Date().toISOString() };
  data.tokens[name] = entry;
  writeCredentials(data);
  return entry;
}

export function removeToken(name: string): boolean {
  const data = readCredentials();
  if (!(name in data.tokens)) return false;
  delete data.tokens[name];
  writeCredentials(data);
  return true;
}

export interface TokenInfo {
  name: string;
  /** 掩码后的值，够人认出是哪把钥匙就行 */
  masked: string;
  updatedAt: string;
  /** 同名环境变量是否也在起作用（环境变量优先） */
  fromEnv: boolean;
}

export function listTokens(): TokenInfo[] {
  const data = readCredentials();
  return Object.entries(data.tokens)
    .map(([name, entry]) => ({
      name,
      masked: mask(entry.value),
      updatedAt: entry.updatedAt,
      fromEnv: Boolean(process.env[name]),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 取一把钥匙：环境变量优先，其次凭据库。
 * 顺序固定，免得上一次装的时候行为和这一次不一样。
 */
export function resolveToken(name: string): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  return readCredentials().tokens[name]?.value;
}

export function mask(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-4)}（${value.length} 位）`;
}
