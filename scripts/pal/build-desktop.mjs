import { build } from 'esbuild';
import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * 打包 Windows 启动器：Pal.exe（自包含单文件）+ runtime（node.exe + 打包后的 pal.cjs）+ web。
 * 产出 dist/pal-desktop 可以整个拷走双击运行。
 */
const root = process.cwd();
const out = join(root, 'dist', 'pal-desktop');

rmSync(out, { recursive: true, force: true });

const publish = spawnSync(
  'dotnet',
  [
    'publish',
    'apps/pal-desktop',
    '-c',
    'Release',
    '-r',
    'win-x64',
    '--self-contained',
    'true',
    '-p:PublishSingleFile=true',
    '-p:IncludeNativeLibrariesForSelfExtract=true',
    '-o',
    out,
  ],
  { cwd: root, stdio: 'inherit' },
);
if (publish.status !== 0) process.exit(publish.status ?? 1);

mkdirSync(join(out, 'runtime'), { recursive: true });

await build({
  entryPoints: [join(root, 'packages', 'launcher', 'src', 'bin.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: join(out, 'runtime', 'pal.cjs'),
  logLevel: 'warning',
});

cpSync(join(root, 'packages', 'launcher', 'web'), join(out, 'web'), { recursive: true });
copyFileSync(process.execPath, join(out, 'runtime', 'node.exe'));

const license = join(dirname(process.execPath), 'LICENSE');
if (existsSync(license)) copyFileSync(license, join(out, 'runtime', 'NODE-LICENSE'));

console.log(`built ${out}`);
