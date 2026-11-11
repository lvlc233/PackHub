import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/verify-lockfile.mjs');

function run(args: string[] = []): { status: number | null; out: string } {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

describe('锁文件完整性门禁', () => {
  it('仓库锁文件里每条 resolution 都带 integrity', () => {
    const res = run();
    expect(res.status).toBe(0);
    expect(res.out).toContain('全部带 integrity');
  });

  it('缺 integrity 时退出 1 并点名是哪个包', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-lock-'));
    const file = join(dir, 'pnpm-lock.yaml');
    writeFileSync(
      file,
      `lockfileVersion: '9.0'

packages:

  foo@1.0.0:
    resolution: {tarball: https://example.test/foo.tgz}
`,
      'utf8',
    );

    const res = run([file]);
    expect(res.status).toBe(1);
    expect(res.out).toContain('foo@1.0.0');
    expect(res.out).toContain('没有 integrity');

    rmSync(dir, { recursive: true, force: true });
  });
});
