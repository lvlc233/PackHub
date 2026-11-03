#!/usr/bin/env node
// 对 registry 里每个版本目录真装一遍并校验（CI 用）。
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const PACKS = join(ROOT, 'registry/packs');

function dirs(p) {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

const targets = [];
for (const scope of dirs(PACKS)) {
  for (const name of dirs(join(PACKS, scope))) {
    for (const version of dirs(join(PACKS, scope, name))) {
      if (!/^\d+\.\d+\.\d+/.test(version)) continue;
      targets.push(join(PACKS, scope, name, version));
    }
  }
}

if (targets.length === 0) {
  console.log('registry 里没有可验证的版本');
  process.exit(0);
}

let failed = 0;
for (const dir of targets) {
  console.log(`\n=== ${dir.replace(ROOT + '/', '').replace(ROOT + '\\', '')} ===`);
  const res = spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(ROOT, 'scripts/registry/verify-pack.mjs'), dir],
    { stdio: 'inherit', env: process.env },
  );
  if (res.status !== 0) failed++;
}

if (failed > 0) {
  console.error(`\n${failed} 个版本未通过验证`);
  process.exit(1);
}
console.log(`\n全部 ${targets.length} 个版本验证通过`);
