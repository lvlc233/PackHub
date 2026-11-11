import { existsSync } from 'node:fs';
import path from 'node:path';

/** 交给 `pal serve` 的参数：端口交给系统、输出 JSON、关 stdin 就自己退。 */
const SERVE_ARGS = ['serve', '--port', '0', '--json', '--exit-on-stdin-close'];

/**
 * 侧车怎么起。
 *
 * dev：仓库里的源码 + 实验性的 strip-types；打包：随包带的 node 与 `runtime/pal.cjs`。
 * 打包侧缺文件时直接说缺哪个，而不是让 spawn 在启动那一刻才炸出一行 ENOENT。
 */
export function sidecarCommand({ packaged, repoRoot, resourcesPath, env = process.env }) {
  if (!packaged) {
    return {
      command: env.PAL_NODE ?? 'node',
      args: [
        '--experimental-strip-types',
        path.join(repoRoot, 'packages', 'launcher', 'src', 'bin.ts'),
        ...SERVE_ARGS,
      ],
      cwd: repoRoot,
    };
  }

  const runtime = path.join(resourcesPath, 'runtime');
  const node = env.PAL_NODE ?? path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node');
  const pal = path.join(runtime, 'pal.cjs');
  const missing = [node, pal].filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      `打包缺 ${missing.join('、')}：打包后要带 runtime/node 与 runtime/pal.cjs；现在只支持仓库内运行`,
    );
  }
  return { command: node, args: [pal, ...SERVE_ARGS], cwd: runtime };
}
