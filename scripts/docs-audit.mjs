#!/usr/bin/env node
/**
 * 文档体检：分类、保质期、链接、占位标记。
 *
 * 规则来自 docs/README.md 与 AGENTS.md：
 * - 每篇 docs 必须带 front matter：kind + verified；snapshot / research 不许留在 docs/。
 * - verified 是「最后一次对着代码核过」的日期，不是最后修改日期；超过 decay 天算过期。
 * - 文档之间的相对链接必须能打开。
 * - 正文不许出现「待更新」这类占位标记（代码块里的示例不算）。
 *
 * 用途：CI 里跑，防止文档悄悄过期；本地改完文档也跑一次。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const KINDS = new Set(['contract', 'decision', 'ledger', 'concept', 'pointer']);
const FORBIDDEN_KINDS = new Set(['snapshot', 'research']);
const DEFAULT_DECAY = 180;
const PLACEHOLDERS = [/\[待更新\]/, /\[待消费\]/, /\bTBD\b/, /待补充/];

const errors = [];
const warnings = [];

function err(file, msg) {
  errors.push(`${relative(ROOT, file)}: ${msg}`);
}

function warn(file, msg) {
  warnings.push(`${relative(ROOT, file)}: ${msg}`);
}

function read(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/** 代码块与行内代码里的方括号是示例，不参与占位标记与链接检查。 */
function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else if (entry.endsWith('.md')) out.push(abs);
  }
  return out;
}

/** 只认 `key: value` 这种平铺 front matter；需要嵌套说明设计有问题。 */
function parseFrontMatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const raw = text.slice(text.indexOf('\n') + 1, end);
  const meta = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([a-z-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    meta[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: text.slice(end + 4) };
}

function toDate(value) {
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const now = new Date();
const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

// 1. front matter + 保质期
const docs = walk(DOCS);
for (const file of docs) {
  const text = read(file);
  const parsed = parseFrontMatter(text);
  if (!parsed) {
    err(file, '缺少 front matter：至少写 kind 和 verified（规则见 docs/README.md）');
    continue;
  }
  const { meta } = parsed;
  const kind = meta.kind;
  if (!kind) err(file, 'front matter 缺 kind');
  else if (FORBIDDEN_KINDS.has(kind)) {
    err(file, `kind=${kind} 不许留在 docs/：结论并进台账后删掉，草稿放 tmp/`);
  } else if (!KINDS.has(kind)) {
    err(file, `未知 kind=${kind}（可用：${[...KINDS].join(' / ')}）`);
  }

  const verified = meta.verified ? toDate(meta.verified) : null;
  if (!verified) {
    err(file, 'front matter 缺 verified（YYYY-MM-DD，最后一次对代码核对的日期）');
    continue;
  }

  const decay = Number(meta.decay ?? DEFAULT_DECAY);
  const explicit = meta.expires ? toDate(meta.expires) : null;
  const deadline = explicit ?? new Date(verified.getTime() + decay * 86_400_000);
  const left = Math.floor((deadline - today) / 86_400_000);
  if (left < 0) {
    err(
      file,
      `过期 ${-left} 天：重核后更新 verified${explicit ? ' / expires' : ` / decay（当前 ${decay} 天）`}，或把它删掉`,
    );
  } else {
    console.log(`ok   ${relative(ROOT, file)}  kind=${kind}  还剩 ${left} 天`);
  }
}

// 2. 占位标记（跳过代码）
for (const file of docs) {
  const body = stripCode(parseFrontMatter(read(file))?.body ?? read(file));
  for (const pattern of PLACEHOLDERS) {
    if (pattern.test(body)) err(file, `正文里有占位标记 ${pattern}：写不准就别写，要跟随就用指针`);
  }
}

// 3. 相对链接（跳过代码）
for (const file of [join(ROOT, 'README.md'), ...docs]) {
  if (!existsSync(file)) continue;
  const text = stripCode(read(file));
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const clean = target.split('#')[0];
    if (!clean) continue;
    if (!existsSync(resolve(dirname(file), clean))) err(file, `链接打不开：${target}`);
  }
}

// 4. 孤儿文档（docs/README.md 里没提到）
const index = join(DOCS, 'README.md');
if (existsSync(index)) {
  const indexText = read(index);
  for (const file of docs) {
    if (file === index) continue;
    if (!indexText.includes(relative(DOCS, file).replaceAll('\\', '/'))) {
      warn(file, 'docs/README.md 没有指向它：要么加进索引，要么删掉');
    }
  }
}

for (const line of warnings) console.log(`warn ${line}`);
if (errors.length > 0) {
  console.log('');
  for (const line of errors) console.log(`x    ${line}`);
  console.log(`\n文档体检失败：${errors.length} 个问题。`);
  process.exit(1);
}
console.log('\n文档体检通过。');
