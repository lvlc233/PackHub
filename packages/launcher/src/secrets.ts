import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** URL 里这些查询参数算凭据：不写进实例记录、不出现在界面、日志里打码。 */
const SECRET_QUERY = /^(token|access_token|auth|key|apikey|api_key|secret|password|session|sig)$/i;

const SECRETS_FILE = 'secrets.json';

export interface SplitUrl {
  /** 去掉凭据后的地址 */
  url: string;
  /** 被摘下来的查询参数 */
  secrets: Record<string, string>;
}

/** 把启动输出里的地址拆成「可公开的地址」和「凭据」。 */
export function splitUrl(input: string): SplitUrl {
  try {
    const parsed = new URL(input);
    const kept = new URLSearchParams();
    const secrets: Record<string, string> = {};
    for (const [key, value] of parsed.searchParams) {
      if (SECRET_QUERY.test(key)) secrets[key] = value;
      else kept.append(key, value);
    }
    const search = kept.toString();
    parsed.search = search;
    const url = parsed.toString();
    return { url, secrets };
  } catch {
    return { url: input, secrets: {} };
  }
}

/** 打开实例时把凭据拼回去；只在服务端拼，不交给页面。 */
export function withSecrets(url: string, secrets: Record<string, string>): string {
  try {
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(secrets)) parsed.searchParams.set(key, value);
    return parsed.toString();
  } catch {
    return url;
  }
}

function secretsPath(root: string): string {
  return join(root, SECRETS_FILE);
}

export function writeSecrets(root: string, secrets: Record<string, string>): void {
  const file = secretsPath(root);
  if (Object.keys(secrets).length === 0) {
    if (existsSync(file)) writeFileSync(file, '{}\n', 'utf8');
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows 上 chmod 只是尽力而为 */
  }
}

export function readSecrets(root: string): Record<string, string> {
  const file = secretsPath(root);
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!data || typeof data !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function clearSecrets(root: string): void {
  writeSecrets(root, {});
}

/** 出现这些形态的值一律当凭据。 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  [/\b(sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[baprs])[-_][A-Za-z0-9_-]{10,}/g, '***'],
  [/([?&](?:token|access_token|auth|key|api_key|apikey|secret|password|session|sig)=)[^&\s"'<>]+/gi, '$1***'],
  [/(["']?(?:token|access_token|api[_-]?key|apikey|secret|password|passwd)["']?\s*[:=]\s*["']?)[^"'\s,;&}]+/gi, '$1***'],
  [/(--(?:token|password|secret|api-key)[= ]+)[^\s"']+/gi, '$1***'],
];

/** 日志与错误信息统一过一遍：token、密钥、用户名路径都不该出现在界面上。 */
export function redactText(text: string): string {
  let out = text;
  try {
    const home = homedir();
    if (home && home.length > 2) {
      out = out.split(home).join('~');
      out = out.split(home.replace(/\\/g, '\\\\')).join('~');
    }
    const user = process.env.USERNAME ?? process.env.USER;
    if (user && user.length > 2) out = out.split(user).join('<user>');
  } catch {
    /* 拿不到 home 就算了 */
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** 展示地址时只遮查询参数里的值，保留端口和路径。 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let touched = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY.test(key)) {
        parsed.searchParams.set(key, '***');
        touched = true;
      }
    }
    return touched ? parsed.toString() : url;
  } catch {
    return redactText(url);
  }
}
