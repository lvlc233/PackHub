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

/** 清单不声明安装形态：装到哪个宿主由命令行选，锁只认内容。 */
const manifest = (extraResource = ''): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/sign-lock
  version: 0.1.0
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
${extraResource}`;

function makePack(dir: string, extraResource = ''): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'packhub.yaml'), manifest(extraResource), 'utf8');
  writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
  writeFileSync(join(dir, 'more.md'), '# more\n', 'utf8');
}

function keygen(base: string): string {
  const key = join(base, 'signing.key');
  expect(run(['keygen', '--out', key]).status).toBe(0);
  return key;
}

describe('sign 的锁过期判断只看内容哈希', () => {
  it('清单能签：锁里没有计划快照，宿主不参与', () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-sign-lock-'));
    try {
      const pack = join(base, 'pack');
      makePack(pack);
      expect(run(['lock', pack]).status).toBe(0);

      const lock = JSON.parse(readFileSync(join(pack, 'packhub.lock.json'), 'utf8')) as {
        contentHash?: string;
        plan?: unknown;
        plans?: unknown;
      };
      // 锁只描述内容：没有 plan / plans，签的是 contentHash
      expect(lock.contentHash).toMatch(/^sha256-/);
      expect(lock.plan).toBeUndefined();
      expect(lock.plans).toBeUndefined();

      const signed = run(['sign', pack, '--key', keygen(base)]);
      expect(signed.status).toBe(0);
      expect(signed.stdout).toContain('已签名 demo/sign-lock@0.1.0');
      expect(existsSync(join(pack, 'packhub.signatures.json'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('锁确实过期（contentHash 与当前清单不同）仍拒签，且不写签名文件', () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-sign-lock-stale-'));
    try {
      const pack = join(base, 'pack');
      makePack(pack);
      expect(run(['lock', pack]).status).toBe(0);
      // 锁之后再改清单：contentHash 变了，锁过期
      writeFileSync(
        join(pack, 'packhub.yaml'),
        manifest('  - id: more\n    type: knowledge\n    source: ./more.md\n'),
        'utf8',
      );

      const denied = run(['sign', pack, '--key', keygen(base)]);
      expect(denied.status).toBe(2);
      expect(denied.stderr).toContain('锁与当前清单对不上：先跑 packhub lock 再签');
      expect(existsSync(join(pack, 'packhub.signatures.json'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
