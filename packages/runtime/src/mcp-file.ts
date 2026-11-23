import { parse as parseYaml, parseDocument, isMap, isSeq, stringify as stringifyYaml, type YAMLSeq } from 'yaml';
import { isPlainObject } from '@packhub/kernel';

// MCP 配置文件里「一条登记」的读 / 写 / 摘：对象文件按对象路径 + 键合并，数组文件（dsh 的
// profile patch）按条目 `id` 认领。执行器、卸载、升级清理与漂移检查都走这一份，避免四处
// 各写一遍 YAML/JSON 合并。
//
// 文本进、文本出：调用方自己决定备份与原子写，也能拿「写之前的正文」做 noop 判断。

export type McpFormat = 'json' | 'yaml';

/** 文件顶层是数组时的合并规则（见 kernel `McpDialect.list`）。 */
export interface McpListMerge {
  /** 放条目的键（dsh 是 insert） */
  field: string;
  /** 条目 `id` 以它开头的才是本工具写的 */
  ownerPrefix: string;
}

/** 一个 MCP 落点的文件形状：条目挂哪、什么格式、顶层是不是数组。 */
export interface McpLayout {
  /** 对象文件的条目路径；顶层是数组时不看 */
  configPath: string[];
  format: McpFormat;
  list?: McpListMerge;
}

/** 文件里有没有本工具登记的那条（漂移检查用；正文坏了按「没有」处理，不抛）。 */
export function mcpFileHasEntry(text: string, layout: McpLayout, key: string): boolean {
  if (!text.trim()) return false;
  try {
    return layout.list
      ? listRows(text, layout.list).some((row) => row.id === key)
      : getPath(readObject(text, layout.format), [...layout.configPath, key]) !== undefined;
  } catch {
    return false;
  }
}

/** 把条目写进正文：已有同名条目就替换，没有就追加。 */
export function withMcpEntry(text: string, layout: McpLayout, key: string, spec: unknown): string {
  if (layout.list) return upsertListRow(text, layout.list, key, spec);
  const data = readObject(text, layout.format);
  let cursor: Record<string, unknown> = data;
  for (const part of layout.configPath) {
    const next = cursor[part];
    if (isPlainObject(next)) {
      cursor = next;
    } else {
      const created: Record<string, unknown> = {};
      cursor[part] = created;
      cursor = created;
    }
  }
  const existing = cursor[key];
  cursor[key] = { ...(isPlainObject(existing) ? existing : {}), ...(isPlainObject(spec) ? spec : {}) };
  return serializeObject(data, layout.format);
}

/** 从正文里摘掉条目；摘完文件里什么都没有时返回空串（调用方据此删文件）。 */
export function withoutMcpEntry(text: string, layout: McpLayout, key: string): string {
  if (!text.trim()) return text;
  if (layout.list) return removeListRow(text, layout.list, key);
  const data = readObject(text, layout.format);
  let cursor: Record<string, unknown> | undefined = data;
  for (const part of layout.configPath) {
    const next: unknown = cursor[part];
    if (!isPlainObject(next)) return text;
    cursor = next;
  }
  delete cursor[key];
  const pruned = pruneEmpty(data);
  if (Object.keys(pruned).length === 0) return '';
  return serializeObject(pruned, layout.format);
}

/* ---------- 对象文件 ---------- */

function readObject(text: string, format: McpFormat): Record<string, unknown> {
  if (!text.trim()) return {};
  const data = format === 'yaml' ? (parseYaml(text) ?? {}) : JSON.parse(text);
  return isPlainObject(data) ? (data as Record<string, unknown>) : {};
}

function serializeObject(data: Record<string, unknown>, format: McpFormat): string {
  return format === 'yaml' ? stringifyYaml(data).trimEnd() + '\n' : JSON.stringify(data, null, 2) + '\n';
}

function getPath(data: unknown, path: readonly string[]): unknown {
  let cur: unknown = data;
  for (const part of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** 摘键后收掉空对象（一条登记都没有的容器不留在文件里）。 */
function pruneEmpty(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (isPlainObject(v)) {
      const pruned = pruneEmpty(v);
      if (Object.keys(pruned).length > 0) out[k] = pruned;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/* ---------- 数组文件（dsh 的 profile patch） ---------- */

function rowId(row: unknown): string | undefined {
  if (!isMap(row)) return undefined;
  const id = row.get('id');
  return typeof id === 'string' ? id : undefined;
}

/** 解析一份 patch 文件；YAML 有错就报错，不拿半份文档去改写用户的文件。 */
function parsePatchDoc(text: string): ReturnType<typeof parseDocument> {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(`MCP 配置文件不是合法 YAML：${doc.errors[0]?.message ?? ''}`);
  }
  return doc;
}

/** 数组文件里所有 loader 行的 `id`（读不出数组就当没有）。 */
function listRows(text: string, list: McpListMerge): { id: string }[] {
  const doc = parsePatchDoc(text);
  if (!isSeq(doc.contents)) return [];
  const out: { id: string }[] = [];
  for (const item of doc.contents.items) {
    if (!isMap(item)) continue;
    const rows = item.get(list.field);
    if (!isSeq(rows)) continue;
    for (const row of rows.items) {
      const id = rowId(row);
      if (id) out.push({ id });
    }
  }
  return out;
}

/**
 * 顶层的 patch 数组；空文件造一个空数组（dsh 自己写的 patch 文件顶层就是数组）。
 * 顶层是别的形状说明文件不是 dsh 的 patch 层：报错让安装回滚，别把人家的内容重写掉。
 */
function ensureSeq(doc: ReturnType<typeof parseDocument>): YAMLSeq {
  if (isSeq(doc.contents)) return doc.contents;
  if (doc.contents !== null) {
    throw new Error('MCP 配置文件顶层不是数组（dsh 的 patch 层要一组 patch 条目）；先修好文件再装');
  }
  const seq = doc.createNode([]) as YAMLSeq;
  doc.contents = seq;
  return seq;
}

/**
 * 我们自己的 insert 条目：`field` 数组里的行全是 `ownerPrefix` 开头的那一条。
 * 用户自己的 insert（含别的 loader）不往里塞，另起一条。
 */
function ownedBucket(seq: YAMLSeq, list: McpListMerge): YAMLSeq | undefined {
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const rows = item.get(list.field);
    if (!isSeq(rows) || rows.items.length === 0) continue;
    if (rows.items.every((row) => (rowId(row) ?? '').startsWith(list.ownerPrefix))) return rows;
  }
  return undefined;
}

function upsertListRow(text: string, list: McpListMerge, key: string, spec: unknown): string {
  const doc = parsePatchDoc(text);
  const seq = ensureSeq(doc);
  const bucket = ownedBucket(seq, list);
  const node = doc.createNode(spec);
  if (bucket) {
    const index = bucket.items.findIndex((row) => rowId(row) === key);
    if (index >= 0) bucket.items[index] = node;
    else bucket.items.push(node);
  } else {
    seq.items.push(doc.createNode({ [list.field]: [spec] }));
  }
  return stringifyDoc(doc);
}

function removeListRow(text: string, list: McpListMerge, key: string): string {
  const doc = parsePatchDoc(text);
  if (!isSeq(doc.contents)) return text;
  const seq = doc.contents;
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const item = seq.items[i];
    if (!isMap(item)) continue;
    const rows = item.get(list.field);
    if (!isSeq(rows)) continue;
    const kept = rows.items.filter((row) => rowId(row) !== key);
    if (kept.length === rows.items.length) continue;
    if (kept.length > 0) {
      rows.items = kept;
    } else if (item.items.length === 1) {
      // 这条 insert 只剩我们的空壳：整条摘掉（用户自己的 insert 不会走到这里）
      seq.items.splice(i, 1);
    } else {
      rows.items = [];
    }
  }
  if (seq.items.length === 0) return '';
  return stringifyDoc(doc);
}

function stringifyDoc(doc: ReturnType<typeof parseDocument>): string {
  const out = String(doc);
  return out.endsWith('\n') ? out : `${out}\n`;
}
