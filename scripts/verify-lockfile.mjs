#!/usr/bin/env node
/**
 * 锁文件完整性门禁：`pnpm-lock.yaml` 里每条 resolution 都要带 integrity。
 *
 * 为什么要单独查：registry 装的包默认带 sha512，但 git / tarball 来源不会带；一旦有人加了一个
 * 没有字节校验的依赖，`--frozen-lockfile` 照样过，装到的东西却没法核对。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const file = process.argv[2] ?? join(root, 'pnpm-lock.yaml');
const lines = readFileSync(file, 'utf8').split(/\r?\n/);

if (!/^lockfileVersion:/m.test(lines.join('\n'))) {
  console.error('x 没有 lockfileVersion，这不是一份 pnpm 锁文件');
  process.exit(1);
}

const missing = [];
let current = '(unknown)';
let resolutions = 0;
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const key = line.match(/^ {2}(\S.*):$/);
  if (key) current = key[1];
  if (!/^\s+resolution:/.test(line)) continue;
  resolutions += 1;
  if (/integrity:/.test(line)) continue;
  const block = lines.slice(i, i + 4).join('\n');
  if (!block.includes('integrity:')) missing.push(current);
}

if (missing.length > 0) {
  console.error(`x ${missing.length} 条 resolution 没有 integrity：`);
  for (const name of missing.slice(0, 20)) console.error(`  ${name}`);
  process.exit(1);
}

console.log(`${resolutions} 条 resolution 全部带 integrity（${file}）`);
