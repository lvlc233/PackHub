#!/usr/bin/env node
// 把本地 app 打成一个可 npx 的包：单文件 bundle + 精简 package.json。
// 产物在 dist/local/，用 `npm pack dist/local` 出 tgz，或 `npm i -g dist/local` 装两个命令。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'dist/local');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const ENTRIES = [
  { bin: 'packhub', entry: join(ROOT, 'apps/local/src/bin.ts') },
  { bin: 'pal', entry: join(ROOT, 'packages/launcher/src/bin.ts') },
];

for (const { bin, entry } of ENTRIES) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: join(OUT, `${bin}.mjs`),
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire as __cr } from 'node:module';",
        'const require = __cr(import.meta.url);',
      ].join('\n'),
    },
    external: ['node:*'],
    logLevel: 'info',
  });

  // esbuild 会把入口自带的 shebang 留在第二行，这里统一修成真正的第一行
  const bundlePath = join(OUT, `${bin}.mjs`);
  const text = readFileSync(bundlePath, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('#!'))
    .join('\n');
  writeFileSync(bundlePath, '#!/usr/bin/env node\n' + text, 'utf8');
}

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

writeFileSync(
  join(OUT, 'package.json'),
  JSON.stringify(
    {
      name: 'packhub',
      version: rootPkg.version,
      description: 'Agent 能力的整合包工具（packhub 做包，pal 装和跑）',
      type: 'module',
      bin: { packhub: './packhub.mjs', pal: './pal.mjs' },
      files: ['packhub.mjs', 'pal.mjs'],
      engines: { node: '>=22.6' },
      license: 'MIT',
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

console.log('built dist/local（packhub + pal；npm i -g dist/local 或 npm pack dist/local）');
