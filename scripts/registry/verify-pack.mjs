#!/usr/bin/env node
// 干净目录里装一遍并校验，结果写 verify.json。
// 真正的执行在 @packhub/runner，这里只是给 CI 用的薄壳。
import { resolve } from 'node:path';
import { runPack } from '../../packages/runner/src/index.ts';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: verify-pack.mjs <pack-version-dir>');
  process.exit(2);
}

const dir = resolve(arg);
try {
  const { report } = await runPack(dir, {
    out: resolve(dir, 'verify.json'),
    log: (line) => console.log(line),
  });
  process.exit(report.ok ? 0 : 1);
} catch (err) {
  console.error(`x ${err && err.message ? err.message : err}`);
  process.exit(1);
}
