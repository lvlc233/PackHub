#!/usr/bin/env node
// 扫描 registry/packs，校验并生成 registry/index.json。
// 用法：node --experimental-strip-types scripts/registry/build-index.mjs [--check]
import { relative, resolve } from 'node:path';
import { writeIndex } from '../../packages/registry/src/index.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const REGISTRY = resolve(ROOT, 'registry');
const CHECK = process.argv.includes('--check');

const res = writeIndex(REGISTRY, { checkOnly: CHECK });
if (!res.ok) {
  console.error('\nregistry 有错误，索引未写入。');
  process.exit(1);
}
if (CHECK) {
  console.log(`registry ok：${res.packs} 个包`);
} else {
  console.log(`written ${relative(ROOT, res.path).replaceAll('\\', '/')}：${res.packs} 个包`);
}
