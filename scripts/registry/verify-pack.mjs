#!/usr/bin/env node
// 干净目录里装一遍并校验；默认把报告写回版本目录，CI 用 --out 写到临时位置。
// 真正的执行在 @packhub/runner，这里只是给 CI 用的薄壳。
import { resolve } from 'node:path';
import { runPack } from '../../packages/runner/src/index.ts';

const args = process.argv.slice(2);
let out;
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') {
    out = args[++i];
    if (!out) {
      console.error('--out 需要路径');
      process.exit(2);
    }
  } else {
    positional.push(args[i]);
  }
}

const arg = positional[0];
if (!arg) {
  console.error('usage: verify-pack.mjs <pack-version-dir> [--out <report.json>]');
  process.exit(2);
}

const dir = resolve(arg);
try {
  const { report } = await runPack(dir, {
    out: out ? resolve(out) : resolve(dir, 'verify.json'),
    log: (line) => console.log(line),
  });
  process.exit(report.ok ? 0 : 1);
} catch (err) {
  console.error(`x ${err && err.message ? err.message : err}`);
  process.exit(1);
}
