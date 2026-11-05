import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface AuditEntry {
  at: string;
  action: string;
  pack?: string;
  version?: string;
  planHash?: string;
  ok?: boolean;
  root?: string;
  detail?: string;
}

/** 安装审计落点：默认 ~/.packhub/audit.jsonl，PACKHUB_HOME 可覆盖。 */
export function auditPath(): string {
  const home = process.env.PACKHUB_HOME ?? join(homedir(), '.packhub');
  return join(home, 'audit.jsonl');
}

/** 追加一行；审计写失败不能把安装带崩，调用方只提示。 */
export function appendAudit(entry: Omit<AuditEntry, 'at'>): void {
  const file = auditPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
}

/** 读最近 N 条；坏行跳过，不让一行脏数据挡住整个审计。 */
export function readAudit(limit = 50): AuditEntry[] {
  const file = auditPath();
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const out: AuditEntry[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}
