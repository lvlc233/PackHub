import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `packhub --version` 只在进程边界上可观察：版本号必须来自仓库根的 package.json，
 * 不在 cli.ts 里手写第二份。这里真起子进程，比对 stdout 与根 package.json 的 version。
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'apps/local/src/bin.ts');
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  version: string;
};

describe('packhub --version', () => {
  it('打印仓库根 package.json 的版本并退出 0', () => {
    // vitest 把 NODE_ENV=test / TEST=true 写进环境，citty 的 consola 会静音；
    // 这里模拟用户在普通 shell 里跑，摘掉测试标记（同 launcher/test/bin.test.ts）。
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PACKHUB_HOME: join(tmpdir(), 'packhub-version-home'),
    };
    delete env.NODE_ENV;
    delete env.TEST;
    const res = spawnSync(process.execPath, ['--experimental-strip-types', BIN, '--version'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env,
    });
    expect(res.status, `stderr：${res.stderr ?? ''}`).toBe(0);
    expect(res.stdout.trim()).toBe(packageJson.version);
  }, 30_000);
});
