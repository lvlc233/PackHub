#!/usr/bin/env node
// Local link and anchor checks for a single Markdown file.
// Usage: node check-links.mjs <file.md> [--http] [--self-test]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const USAGE = 'usage: node check-links.mjs <file.md> [--http] [--self-test]';

function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function stripCode(text) {
  const withoutFences = text.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
  return withoutFences.replace(/`[^`]*`/g, '');
}

function extractLinks(text) {
  const clean = stripCode(text);
  const links = [];
  const re = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = re.exec(clean))) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.replace(/\s+"[^"]*"$/, '').trim();
    const line = clean.slice(0, match.index).split(/\r?\n/).length;
    links.push({ target, line });
  }
  return links;
}

function headings(file) {
  const text = stripCode(readFileSync(file, 'utf8'));
  return [...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slugify(m[1]));
}

function checkText(file, text, options = {}) {
  const issues = [];
  const base = dirname(resolve(file));
  const currentAnchors = headings(file);

  for (const { target, line } of extractLinks(text)) {
    if (!target) continue;
    if (/^(https?):\/\//i.test(target)) {
      if (!options.http) issues.push({ level: 'warn', line, message: `HTTP link not checked: ${target}` });
      continue;
    }
    if (/^(mailto|tel):/i.test(target)) continue;

    const [rawPath, fragment] = target.split('#');
    const path = rawPath || '';
    const targetFile = path ? resolve(base, decodeURIComponent(path)) : resolve(file);

    if (!existsSync(targetFile)) {
      issues.push({ level: 'error', line, message: `missing file: ${target}` });
      continue;
    }
    if (fragment) {
      const anchors = path ? headings(targetFile) : currentAnchors;
      if (!anchors.includes(slugify(decodeURIComponent(fragment)))) {
        issues.push({ level: 'error', line, message: `missing anchor: ${target}` });
      }
    }
  }
  return issues;
}

async function checkHttp(file, text) {
  const issues = [];
  for (const { target, line } of extractLinks(text)) {
    if (!/^https?:\/\//i.test(target)) continue;
    try {
      let res = await fetch(target, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
      if (res.status === 405 || res.status === 403) {
        res = await fetch(target, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000) });
      }
      if (!res.ok) issues.push({ level: 'error', line, message: `HTTP ${res.status}: ${target}` });
    } catch (err) {
      issues.push({ level: 'warn', line, message: `HTTP check failed: ${target} (${err.message})` });
    }
  }
  return issues;
}

if (process.argv.includes('--self-test')) {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'doc-review-'));
  writeFileSync(join(dir, 'b.md'), '# B\n', 'utf8');
  const fixture = '# Hello World\n\n[ok](./b.md)\n[bad](./nope.md)\n[anchor](#hello-world)\n';
  writeFileSync(join(dir, 'a.md'), fixture, 'utf8');
  const issues = checkText(join(dir, 'a.md'), fixture);
  const ok = issues.some((i) => i.message.includes('missing file'))
    && !issues.some((i) => i.level === 'error' && !i.message.includes('missing file'))
    && slugify('Hello World') === 'hello-world';
  rmSync(dir, { recursive: true, force: true });
  if (!ok) {
    console.error('self-test failed', issues);
    process.exit(1);
  }
  console.log('self-test ok');
  process.exit(0);
}

const file = process.argv[2];
if (!file) {
  console.error(USAGE);
  process.exit(2);
}
let text;
try {
  text = readFileSync(file, 'utf8');
} catch (err) {
  console.error(`cannot read ${file}: ${err.message}`);
  process.exit(2);
}
const issues = checkText(file, text);
if (process.argv.includes('--http')) issues.push(...(await checkHttp(file, text)));
for (const issue of issues) {
  console.log(`${issue.level === 'error' ? 'x' : '!'} line ${issue.line}: ${issue.message}`);
}
const errors = issues.filter((i) => i.level === 'error').length;
console.log(`${issues.length} issue(s), ${errors} error(s)`);
process.exit(errors > 0 ? 1 : 0);
