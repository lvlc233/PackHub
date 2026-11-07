import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { redactText } from './secrets.ts';
import { stamp } from './paths.ts';

const CURRENT = 'start.log';
const ARCHIVE = /^start\.\d+(-\d+)?\.log$/;
const KEEP = 5;

export interface LogFileInfo {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
}

export function logsDir(root: string): string {
  return join(root, 'logs');
}

export function ensureLogsDir(root: string): string {
  const dir = logsDir(root);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function listArchives(root: string): LogFileInfo[] {
  const dir = logsDir(root);
  if (!existsSync(dir)) return [];
  const out: LogFileInfo[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!ARCHIVE.test(name)) continue;
    try {
      const stat = statSync(join(dir, name));
      out.push({ name, path: join(dir, name), size: stat.size, modifiedAt: stat.mtime.toISOString() });
    } catch {
      /* 跳过 */
    }
  }
  // 文件名里带时间戳，倒序就是新到旧
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/** 每次启动前把上一轮输出归档：start.log 只放本次运行，历史按时间留着。 */
export function rotateLogs(root: string, keep = KEEP): string | undefined {
  const dir = ensureLogsDir(root);
  const current = join(dir, CURRENT);
  if (!existsSync(current)) return undefined;
  const base = join(dir, `start.${stamp()}`);
  let target = `${base}.log`;
  let ordinal = 1;
  while (existsSync(target)) target = `${base}-${ordinal++}.log`;
  try {
    renameSync(current, target);
  } catch {
    return undefined;
  }
  for (const old of listArchives(root).slice(keep)) {
    try {
      rmSync(old.path, { force: true });
    } catch {
      /* 删不掉就留着 */
    }
  }
  return target;
}

export function listLogs(root: string): LogFileInfo[] {
  const dir = logsDir(root);
  const out: LogFileInfo[] = [];
  for (const file of [join(dir, CURRENT), ...listArchives(root).map((a) => a.path)]) {
    if (!existsSync(file)) continue;
    try {
      const stat = statSync(file);
      out.push({
        name: file.split(/[\\/]/).pop() ?? CURRENT,
        path: file,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      /* 跳过 */
    }
  }
  return out;
}

/** 以追加方式打开日志，返回 fd：spawn 的 stdio 直接用它，不再拼 shell 重定向。 */
export function openLog(root: string): { fd: number; file: string } {
  const dir = ensureLogsDir(root);
  rotateLogs(root);
  const file = join(dir, CURRENT);
  const fd = openSync(file, 'a');
  return { fd, file };
}

export function closeLog(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* 已关闭 */
  }
}

export function appendEvent(root: string, event: Record<string, unknown>): void {
  try {
    const dir = ensureLogsDir(root);
    appendFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n',
      'utf8',
    );
  } catch {
    /* 诊断日志写不进去不影响主流程 */
  }
}

export function readEvents(root: string, limit = 50): Array<Record<string, unknown>> {
  const file = join(logsDir(root), 'events.jsonl');
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return { at: '', raw: line };
        }
      });
  } catch {
    return [];
  }
}

/** 读日志尾部；默认只读最后 256KB，避免大日志把界面卡住。 */
export function readLog(
  root: string,
  opts: { file?: string; maxBytes?: number } = {},
): {
  file: string;
  text: string;
  truncated: boolean;
  files: LogFileInfo[];
} {
  const dir = logsDir(root);
  const name = opts.file && /^[\w.-]+\.log$/.test(opts.file) ? opts.file : CURRENT;
  const file = join(dir, name);
  if (!existsSync(file)) return { file: name, text: '', truncated: false, files: listLogs(root) };
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  let text = '';
  let truncated = false;
  try {
    const size = statSync(file).size;
    if (size > maxBytes) {
      truncated = true;
      const fd = openSync(file, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        readSync(fd, buf, 0, maxBytes, size - maxBytes);
        text = buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } else {
      text = readFileSync(file, 'utf8');
    }
  } catch {
    text = '';
  }
  return { file: name, text: redactText(text), truncated, files: listLogs(root) };
}

/** 失败时回日志尾部，不让人再去找文件。 */
export function tailLog(root: string, lines = 15): string {
  const { text } = readLog(root);
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-lines)
    .join('\n');
}
