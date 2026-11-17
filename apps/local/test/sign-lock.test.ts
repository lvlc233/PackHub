import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'apps/local/src/bin.ts');

function run(
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; out: string; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ['--experimental-strip-types', BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PACKHUB_HOME: join(tmpdir(), 'packhub-sign-lock-home'), PACKHUB_INDEX: '', ...env },
  });
  return {
    status: res.status,
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

const manifest = (targets: string, extraResource = ''): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/sign-lock
  version: 0.1.0
  targets: [${targets}]
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
${extraResource}`;

function makePack(dir: string, targets = 'dir', extraResource = ''): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'packhub.yaml'), manifest(targets, extraResource), 'utf8');
  writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
  writeFileSync(join(dir, 'more.md'), '# more\n', 'utf8');
}

function keygen(base: string): string {
  const key = join(base, 'signing.key');
  expect(run(['keygen', '--out', key]).status).toBe(0);
  return key;
}

describe('sign 的锁过期判断只比 dir 那份快照', () => {
  it('多 target 锁（主 target 是 dsh，plans.dir ≠ top-level planHash）能签', () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-sign-lock-multi-'));
    try {
      const pack = join(base, 'pack');
      makePack(pack, 'dsh, dir');
      expect(run(['lock', pack, '--target', 'dsh']).status).toBe(0);

      const lock = JSON.parse(readFileSync(join(pack, 'packhub.lock.json'), 'utf8')) as {
        planHash: string;
        plan?: { target?: string };
        plans?: Record<string, { planHash: string }>;
      };
      // 构造的就是「主 target 不是 dir」：旧实现拿 top-level planHash 和 dir 计划比，会误拒签
      expect(lock.plan?.target).toBe('dsh');
      expect(lock.plans?.dir?.planHash).toBeTruthy();
      expect(lock.plans!.dir!.planHash).not.toBe(lock.planHash);

      const signed = run(['sign', pack, '--key', keygen(base)]);
      expect(signed.status).toBe(0);
      expect(signed.stdout).toContain('已签名 demo/sign-lock@0.1.0');
      expect(existsSync(join(pack, 'packhub.signatures.json'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('锁确实过期（plans.dir 与当前 dir 计划不同）仍拒签，且不写签名文件', () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-sign-lock-stale-'));
    try {
      const pack = join(base, 'pack');
      makePack(pack);
      expect(run(['lock', pack]).status).toBe(0);
      // 锁之后再改清单：dir 计划变了，锁里的 dir 快照过期
      writeFileSync(
        join(pack, 'packhub.yaml'),
        manifest('dir', '  - id: more\n    type: knowledge\n    source: ./more.md\n'),
        'utf8',
      );

      const denied = run(['sign', pack, '--key', keygen(base)]);
      expect(denied.status).toBe(2);
      expect(denied.stderr).toContain('锁里的计划快照和当前清单对不上：先跑 packhub lock 再签');
      expect(existsSync(join(pack, 'packhub.signatures.json'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
