#!/usr/bin/env node
// 对 registry 里每个版本目录真装一遍并校验（CI 用）。
// 报告写到临时目录：registry 版本目录是不可变的，CI 不能每次改 verify.json 的时间戳。
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const PACKS = join(ROOT, 'registry/packs');
const skipNetwork = process.argv.includes('--skip-network');

function dirs(p) {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

/** 清单里有没有安装期必须联网取的东西（远程 source / 远程 extends）。 */
function needsNetwork(dir) {
  const file = join(dir, 'packhub.yaml');
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  return /source:\s*["']?(npm|pypi|github|https?):/m.test(text) || /extends:\s*["']?packhub:\/\//m.test(text);
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
let skipped = 0;
const reports = mkdtempSync(join(tmpdir(), 'packhub-verify-all-'));
try {
  for (const dir of targets) {
    const label = dir.replace(ROOT + '/', '').replace(ROOT + '\\', '');
    if (skipNetwork && needsNetwork(dir)) {
      console.log(`\n=== ${label} ===`);
      console.log('- 跳过：清单里有远程引用（--skip-network）');
      skipped++;
      continue;
    }
    console.log(`\n=== ${label} ===`);
    const report = join(reports, `${label.replace(/[\\/]/g, '-')}.json`);
    const res = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        join(ROOT, 'scripts/registry/verify-pack.mjs'),
        dir,
        '--out',
        report,
      ],
      { stdio: 'inherit', env: process.env },
    );
    if (res.status !== 0) failed++;
  }
} finally {
  rmSync(reports, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} 个版本未通过验证`);
  process.exit(1);
}
console.log(`\n全部 ${targets.length - skipped} 个版本验证通过${skipped ? `（跳过 ${skipped} 个远程引用版本）` : ''}`);
