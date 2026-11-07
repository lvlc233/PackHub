#!/usr/bin/env node
// 示例包安装 + verify 矩阵：每个 examples/<name> 复制到临时目录，真装一遍再验。
// 远程 source 的示例在 --skip-network 下跳过（本机没网时仍能跑本地示例）。
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const EXAMPLES = join(ROOT, 'examples');
const BIN = join(ROOT, 'apps/local/src/bin.ts');
const skipNetwork = process.argv.includes('--skip-network');

function needsNetwork(dir) {
  const text = readFileSync(join(dir, 'packhub.yaml'), 'utf8');
  return /source:\s*["']?(npm|pypi|github|https?):/m.test(text);
}

const names = existsSync(EXAMPLES)
  ? readdirSync(EXAMPLES, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(EXAMPLES, d.name, 'packhub.yaml')))
      .map((d) => d.name)
      .sort()
  : [];

if (names.length === 0) {
  console.log('没有 examples/*/packhub.yaml');
  process.exit(0);
}

let failed = 0;
let skipped = 0;
for (const name of names) {
  const src = join(EXAMPLES, name);
  if (skipNetwork && needsNetwork(src)) {
    console.log(`\n=== examples/${name} ===`);
    console.log('- 跳过：清单里有远程引用（--skip-network）');
    skipped++;
    continue;
  }
  const work = mkdtempSync(join(tmpdir(), `packhub-example-${name}-`));
  try {
    const packDir = join(work, name);
    cpSync(src, packDir, {
      recursive: true,
      filter: (path) => !['.packhub', '.git', 'node_modules'].includes(path.split(/[\\/]/).pop() ?? ''),
    });
    console.log(`\n=== examples/${name} ===`);
    const env = { ...process.env, PACKHUB_HOME: join(work, 'home') };
    const install = spawnSync(
      process.execPath,
      ['--experimental-strip-types', BIN, 'install', packDir, '--target', 'dir'],
      { stdio: 'inherit', env },
    );
    if (install.status !== 0) {
      failed++;
      continue;
    }
    const verify = spawnSync(
      process.execPath,
      ['--experimental-strip-types', BIN, 'verify', packDir, '--target', 'dir'],
      { stdio: 'inherit', env },
    );
    if (verify.status !== 0) failed++;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`\n${failed} 个示例未通过安装 + 校验`);
  process.exit(1);
}
console.log(`\n全部 ${names.length - skipped} 个示例通过安装 + 校验${skipped ? `（跳过 ${skipped} 个远程引用示例）` : ''}`);
