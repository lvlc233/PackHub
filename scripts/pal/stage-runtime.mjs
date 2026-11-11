#!/usr/bin/env node
/**
 * 把打包后要随 app 带的运行时摆好：`pal.cjs` + 当前 node 可执行文件。
 *
 * electron-builder 的 extraResources 指到 `dist/pal-runtime`；先有这一份，打包才有东西可带。
 * 用当前 node 是刻意的：这是本机跑得起来的那一个，版本跟 `pal:bundle` 的 target 对得上。
 */
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
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

const pal = join(out, 'pal.cjs');
if (!existsSync(pal)) {
  console.error('x 没有产出 pal.cjs');
  process.exit(1);
}

const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
const nodeTarget = join(out, nodeName);
copyFileSync(process.execPath, nodeTarget);

console.log(`staged ${pal}`);
console.log(`staged ${nodeTarget}（来自 ${process.execPath}）`);
