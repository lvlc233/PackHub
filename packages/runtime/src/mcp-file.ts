import { parse as parseYaml, parseDocument, isMap, isSeq, stringify as stringifyYaml, visit, type YAMLSeq } from 'yaml';
import { isPlainObject } from '@packhub/kernel';

// MCP 配置文件里「一条登记」的读 / 写 / 摘：对象文件按对象路径 + 键合并，数组文件（dsh 的
// profile patch）按条目 `id` 认领。执行器、卸载、升级清理与漂移检查都走这一份，避免四处
// 各写一遍 YAML/JSON 合并。
//
// 文本进、文本出：调用方自己决定备份与原子写，也能拿「写之前的正文」做 noop 判断。
//
// 数组文件（dsh 的 `cordis.patch.yml`）尽量做文本级编辑：只追加 / 摘掉自己的列表项块，用户的
// 行、注释、空行与缩进逐字节不动。结构不是预期的顶层块数组（解析失败、锚点 / 别名、顶层是
// 流式数组且非空）时退回「按文档树整份重写」，并通过 `onNote` 报一条提示——不能静默改排版。

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

/** 文本级编辑不适用、退回整份重写时给出的提示（调用方补上文件名再报出去）。 */
export const MCP_TEXT_EDIT_FALLBACK =
  'MCP 配置文件不是预期的顶层块数组（解析失败 / 锚点 / 流式写法），改用整份重写：缩进、引号与注释位置可能变';

/** 提示回调：不去猜调用方的日志面，安装 / 升级清理 / 卸载各自决定报在哪。 */
export type McpNote = (line: string) => void;

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
export function withMcpEntry(
  text: string,
  layout: McpLayout,
  key: string,
  spec: unknown,
  onNote?: McpNote,
): string {
  if (layout.list) return upsertListRow(text, layout.list, key, spec, onNote);
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
export function withoutMcpEntry(
  text: string,
  layout: McpLayout,
  key: string,
  onNote?: McpNote,
): string {
  if (!text.trim()) return text;
  if (layout.list) return removeListRow(text, layout.list, key, onNote);
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ----- 文本模型：按行保留每行自己的换行符，摘行只摘整行，其余字节不动 ----- */

interface TextModel {
  lines: string[];
  /** 第 i 行末尾的换行符（最后一行也可以是没有换行的空串） */
  ends: string[];
}

function splitLines(text: string): TextModel {
  const lines: string[] = [];
  const ends: string[] = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) {
      lines.push(text.slice(at));
      ends.push('');
      break;
    }
    const raw = text.slice(at, nl);
    if (raw.endsWith('\r')) {
      lines.push(raw.slice(0, -1));
      ends.push('\r\n');
    } else {
      lines.push(raw);
      ends.push('\n');
    }
    at = nl + 1;
  }
  return { lines, ends };
}

function joinLines(model: TextModel): string {
  let out = '';
  for (let i = 0; i < model.lines.length; i++) out += model.lines[i]! + (model.ends[i] ?? '');
  return out;
}

/** 文件自己的换行符：追加的行跟着它，不把 CRLF 文件写成混合换行。 */
function primaryEol(model: TextModel): string {
  return model.ends.find((end) => end !== '') ?? '\n';
}

/** 把 [start, end) 整段换成 newLines；新行沿用被替换段最后一行的换行符。 */
function spliceLines(model: TextModel, start: number, end: number, newLines: string[]): TextModel {
  const eol = primaryEol(model);
  const tail = end > start ? (model.ends[end - 1] ?? eol) : eol;
  const lines = [...model.lines.slice(0, start)];
  const ends = [...model.ends.slice(0, start)];
  newLines.forEach((line, index) => {
    lines.push(line);
    ends.push(index === newLines.length - 1 ? tail : eol);
  });
  lines.push(...model.lines.slice(end));
  ends.push(...model.ends.slice(end));
  return { lines, ends };
}

/** 在文件末尾追加一个列表项块；块本身以换行结尾（与之前写盘的行为一致）。 */
function appendLines(model: TextModel, block: string[]): string {
  const eol = primaryEol(model);
  const lines = [...model.lines];
  const ends = [...model.ends];
  // 原来最后一行没有换行：补一个，追加的块要从新的一行开始
  if (lines.length > 0 && ends[ends.length - 1] === '') ends[ends.length - 1] = eol;
  for (const line of block) {
    lines.push(line);
    ends.push(eol);
  }
  return joinLines({ lines, ends });
}

/** 渲染「一条 patch 项」：`- <field>:` + 一行 loader；缩进只用顶层前缀。 */
function renderItemBlock(field: string, spec: unknown, indent: string): string[] {
  const body = stringifyYaml([{ [field]: [spec] }]).replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return body.split('\n').map((line) => (line ? `${indent}${line}` : line));
}

/** 渲染「一条 loader 行」（含它自己的 `- `）：用于替换已有条目。 */
function renderRowBlock(spec: unknown, indent: string): string[] {
  const body = stringifyYaml([spec]).replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return body.split('\n').map((line) => (line ? `${indent}${line}` : line));
}

/** 顶层列表项的缩进（文件自己怎么缩进就跟着它）；混用 tab 缩进时不猜，回退整份重写。 */
function topIndent(lines: string[]): string | undefined {
  let width: number | undefined;
  for (const line of lines) {
    const m = /^([ \t]*)-[ \t]/.exec(line);
    if (!m) continue;
    if (m[1]!.includes('\t')) return undefined;
    const len = m[1]!.length;
    if (width === undefined || len < width) width = len;
  }
  return ' '.repeat(width ?? 0);
}

interface RowHit {
  index: number;
  indent: number;
}

/** 找 `- id: <key>` 这一行的起始位置（引用形式也认）；`last` 为真时从后往前找。 */
function findRow(lines: readonly string[], key: string, last = false): RowHit | undefined {
  const re = new RegExp(`^([ \\t]*)-[ \\t]+id:[ \\t]*(['"]?)${escapeRe(key)}\\2[ \\t]*(?:#.*)?$`);
  const start = last ? lines.length - 1 : 0;
  const step = last ? -1 : 1;
  for (let index = start; index >= 0 && index < lines.length; index += step) {
    const m = re.exec(lines[index]!);
    if (m) return { index, indent: m[1]!.length };
  }
  return undefined;
}

/**
 * 一行块的结束位置（不含）：从起始行往下到这一段最后一个内容行。
 * 遇到空行 / 注释不算内容（它们不属于我们写的那几行，摘除时留在原处，不吞用户的注释），
 * 遇到缩进不大于起始行的内容行就停——下一个列表项或更外层的键。
 */
function blockEnd(lines: readonly string[], start: number, indent: number): number {
  let lastContent = start;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    const content = line.trim();
    if (content === '' || content.startsWith('#')) continue;
    const leading = /^[ \t]*/.exec(line)![0].length;
    if (leading <= indent) break;
    lastContent = index;
  }
  return lastContent + 1;
}

/** 包着这一行的上一层列表项（`- insert:`）位置；它必须比行缩进更浅。 */
function enclosingItem(lines: readonly string[], rowIndex: number, rowIndent: number): RowHit | undefined {
  for (let index = rowIndex - 1; index >= 0; index--) {
    const m = /^([ \t]*)-[ \t]/.exec(lines[index]!);
    if (!m) continue;
    const indent = m[1]!.length;
    if (indent < rowIndent) return { index, indent };
  }
  return undefined;
}

/**
 * 文本级编辑的前提：顶层是非流式数组，文件里没有锚点 / 别名 / 显式标签，也没有 tab 缩进。
 * 不满足就返回 undefined，调用方回退整份重写并报提示。
 * 顶层是 `[]`（流式空数组）放行：它是安装前 dsh 常见形态，替换掉这个记号即可。
 */
function editableDoc(text: string): ReturnType<typeof parseDocument> | undefined {
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(text);
  } catch {
    return undefined;
  }
  if (doc.errors.length > 0) return undefined;
  if (doc.contents === null) return doc;
  if (!isSeq(doc.contents)) return undefined;
  if (doc.contents.flow && doc.contents.items.length > 0) return undefined;
  let complex = false;
  visit(doc, {
    Alias: () => {
      complex = true;
    },
    Node: (_key, node) => {
      const named = node as { anchor?: string; tag?: string };
      if (named.anchor || named.tag) complex = true;
    },
  });
  return complex ? undefined : doc;
}

/**
 * 写：已有同名行就只换那一行块（行内缩进跟着原行），否则在文件末尾追加一个 `- insert:` 项。
 * 文本级编辑做不到时返回 undefined。
 */
function upsertListRowText(text: string, list: McpListMerge, key: string, spec: unknown): string | undefined {
  const doc = editableDoc(text);
  if (!doc) return undefined;
  const model = splitLines(text);
  const row = findRow(model.lines, key);
  if (row) {
    const end = blockEnd(model.lines, row.index, row.indent);
    const block = renderRowBlock(spec, ' '.repeat(row.indent));
    return joinLines(spliceLines(model, row.index, end, block));
  }
  let base = model;
  if (isSeq(doc.contents) && doc.contents.flow) {
    // 流式空数组：把 `[]` 这个记号从它独占的那行里去掉（同行的注释留着）
    const index = base.lines.findIndex((line) => /^[ \t]*\[\s*\][ \t]*(?:#.*)?$/.test(line));
    if (index < 0) return undefined;
    const rest = base.lines[index]!.replace(/^[ \t]*\[\s*\][ \t]*/, '').trimEnd();
    base =
      rest === ''
        ? spliceLines(base, index, index + 1, [])
        : spliceLines(base, index, index + 1, [rest]);
  }
  const indent = topIndent(base.lines);
  if (indent === undefined) return undefined;
  return appendLines(base, renderItemBlock(list.field, spec, indent));
}

/**
 * 摘：从 `- id: <key>` 所在行删到下一个同层 / 更外层内容行之前；包着它的 `- insert:` 项
 * 只剩空壳时一起摘掉，用户的注释与空行原位保留。摘不到或摘完不是合法顶层数组时返回 undefined。
 */
function removeListRowText(text: string, list: McpListMerge, key: string): string | undefined {
  const doc = editableDoc(text);
  if (!doc) return undefined;
  if (!isSeq(doc.contents)) return text;
  let current = text;
  let removedAny = false;
  for (;;) {
    const model = splitLines(current);
    const row = findRow(model.lines, key, true);
    if (!row) break;
    const end = blockEnd(model.lines, row.index, row.indent);
    const shell = enclosingItem(model.lines, row.index, row.indent);
    let next = spliceLines(model, row.index, end, []);
    removedAny = true;
    if (shell && shellHasNoOtherContent(model.lines, shell, row, end, list.field)) {
      // 只摘 shell 那一行（行块已从 next 里删掉，shell 在它前面，下标不变）；
      // 里面的注释 / 空行留在原处
      next = spliceLines(next, shell.index, shell.index + 1, []);
    }
    current = joinLines(next);
  }
  if (!removedAny) return text;
  if (current.trim() === '') return '';
  const parsed = parseDocument(current);
  if (parsed.errors.length > 0) return undefined;
  if (isSeq(parsed.contents) && parsed.contents.items.length === 0) return '';
  return current;
}

/** shell 项在摘掉行块之后是否只剩空壳（空行 / 注释不算内容）。 */
function shellHasNoOtherContent(
  lines: readonly string[],
  shell: RowHit,
  row: RowHit,
  rowEnd: number,
  field: string,
): boolean {
  // shell 行本身必须是 `- <field>:`（值在下面的行里）
  const head = lines[shell.index]!;
  const headRe = new RegExp(`^[ \\t]*-[ \\t]+${escapeRe(field)}:[ \\t]*(?:#.*)?$`);
  if (!headRe.test(head)) return false;
  const shellEnd = blockEnd(lines, shell.index, shell.indent);
  for (let index = shell.index + 1; index < shellEnd; index++) {
    if (index >= row.index && index < rowEnd) continue;
    const content = lines[index]!.trim();
    if (content === '' || content.startsWith('#')) continue;
    return false;
  }
  return true;
}

function upsertListRow(
  text: string,
  list: McpListMerge,
  key: string,
  spec: unknown,
  onNote?: McpNote,
): string {
  const edited = upsertListRowText(text, list, key, spec);
  if (edited !== undefined) return edited;
  onNote?.(MCP_TEXT_EDIT_FALLBACK);
  return upsertListRowDoc(text, list, key, spec);
}

function removeListRow(text: string, list: McpListMerge, key: string, onNote?: McpNote): string {
  const edited = removeListRowText(text, list, key);
  if (edited !== undefined) return edited;
  onNote?.(MCP_TEXT_EDIT_FALLBACK);
  return removeListRowDoc(text, list, key);
}

/* ----- 回退路径：按文档树整份重写（结构与旧实现一致） ----- */

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

function upsertListRowDoc(text: string, list: McpListMerge, key: string, spec: unknown): string {
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

function removeListRowDoc(text: string, list: McpListMerge, key: string): string {
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
