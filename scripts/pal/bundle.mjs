#!/usr/bin/env node
/**
 * 只打包 launcher（pal.cjs）：CI 与本地快速验证分发形态，不需要 .NET。
 */
import { build } from 'esbuild';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const out = join(root, 'dist', 'pal-runtime');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, 'packages', 'launcher', 'src', 'bin.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: join(out, 'pal.cjs'),
  logLevel: 'warning',
});

const file = join(out, 'pal.cjs');
if (!existsSync(file)) {
  console.error('x 没有产出 pal.cjs');
  process.exit(1);
}
console.log(`built ${file}`);
