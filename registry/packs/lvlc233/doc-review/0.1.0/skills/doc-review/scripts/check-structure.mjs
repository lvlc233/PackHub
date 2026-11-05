#!/usr/bin/env node
// Structural checks for a single Markdown file.
// Usage: node check-structure.mjs <file.md> [--self-test]
import { readFileSync } from 'node:fs';

const USAGE = 'usage: node check-structure.mjs <file.md> [--self-test]';

function checkText(text) {
  const lines = text.split(/\r?\n/);
  const issues = [];
  const headings = [];
  let inFence = false;
  let fenceMark = '';
  let fenceStart = 0;
  let fenceCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMark = fence[1];
        fenceStart = i + 1;
        fenceCount++;
      } else if (fence[1] === fenceMark) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      headings.push({ level: heading[1].length, text: heading[2], line: i + 1 });
    }
  }

  if (fenceCount % 2 !== 0) {
    issues.push({ level: 'error', line: fenceStart, message: 'code fence is not closed' });
  }
  const h1 = headings.filter((h) => h.level === 1);
  if (h1.length === 0) issues.push({ level: 'warn', line: 1, message: 'no H1 heading' });
  if (h1.length > 1) {
    for (const h of h1.slice(1)) issues.push({ level: 'error', line: h.line, message: `multiple H1: ${h.text}` });
  }
  const seen = new Map();
  for (const h of headings) {
    const key = h.text.trim().toLowerCase();
    if (seen.has(key)) {
      issues.push({ level: 'warn', line: h.line, message: `duplicate heading: ${h.text}` });
    }
    seen.set(key, h.line);
  }
  for (let i = 1; i < headings.length; i++) {
    const prev = headings[i - 1];
    const cur = headings[i];
    if (cur.level - prev.level > 1) {
      issues.push({ level: 'warn', line: cur.line, message: `heading jumps H${prev.level} → H${cur.level}` });
    }
  }

  // Table blocks: contiguous lines starting and ending with a pipe (outside code fences).
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) continue;
    const block = [];
    let j = i;
    while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
      block.push({ line: j + 1, text: lines[j] });
      j++;
    }
    const widths = block.map((b) => b.text.trim().slice(1, -1).split('|').length);
    const width = widths[0];
    if (widths.some((w) => w !== width)) {
      issues.push({ level: 'warn', line: block[0].line, message: `table columns differ: ${widths.join('/')}` });
    }
    i = j - 1;
  }

  return issues;
}

if (process.argv.includes('--self-test')) {
  const fixture = `# Title\n\n\`\`\`js\n# not a heading\n\`\`\`\n\n### Jump\n\n| a | b |\n|---|---|\n| 1 |\n`;
  const issues = checkText(fixture);
  const has = (msg) => issues.some((i) => i.message.includes(msg));
  if (!has('heading jumps') || !has('table columns')) {
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
const issues = checkText(text);
for (const issue of issues) {
  console.log(`${issue.level === 'error' ? 'x' : '!'} line ${issue.line}: ${issue.message}`);
}
const errors = issues.filter((i) => i.level === 'error').length;
console.log(`${issues.length} issue(s), ${errors} error(s)`);
process.exit(errors > 0 ? 1 : 0);
