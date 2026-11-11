import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLock, loadPack, planFor } from '@packhub/kernel';
import {
  generateKeyPair,
  inspectPack,
  signPlan,
  writeSignature,
} from '../src/index.ts';

const BODY = (extra: string): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/consume, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./resources/rules.md
${extra}`;

function pack(extra = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-consume-'));
  mkdirSync(join(dir, 'resources'), { recursive: true });
  writeFileSync(join(dir, 'packhub.yaml'), BODY(extra), 'utf8');
  writeFileSync(join(dir, 'resources/rules.md'), '# rules\n', 'utf8');
  const ctx = loadPack(dir);
  const { plan } = planFor(ctx);
  writeFileSync(join(dir, 'packhub.lock.json'), JSON.stringify(buildLock(ctx.manifest!, plan!), null, 2), 'utf8');
  return dir;
}

function lockPlan(dir: string) {
  const ctx = loadPack(dir);
  return { ctx, plan: planFor(ctx, { target: 'dir' }).plan! };
}

describe('消费端核对', () => {
  it('锁与清单一致时没有 error', () => {
    const dir = pack();
    const { ctx, plan } = lockPlan(dir);
    const res = inspectPack(dir, ctx.manifest!, plan);
    expect(res.lockMatches).toBe(true);
    expect(res.issues.filter((i) => i.severity === 'error')).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('清单在锁定后被改过 → lock-mismatch（error）', () => {
    const dir = pack();
    const { ctx } = lockPlan(dir);
    writeFileSync(join(dir, 'resources/rules.md'), '# rules\n', 'utf8');
    writeFileSync(join(dir, 'resources/other.md'), '# other\n', 'utf8');
    writeFileSync(
      join(dir, 'packhub.yaml'),
      BODY(`  - id: more
    type: knowledge
    source: ./resources/other.md
`),
      'utf8',
    );
    const fresh = loadPack(dir);
    const freshPlan = planFor(fresh).plan!;
    const res = inspectPack(dir, fresh.manifest!, freshPlan);
    expect(res.lockMatches).toBe(false);
    expect(res.issues.map((i) => i.code)).toContain('lock-mismatch');
    expect(res.issues.find((i) => i.code === 'lock-mismatch')?.severity).toBe('error');
    expect(ctx.manifest!.resources).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('没有锁是 warning，不是 error', () => {
    const dir = pack();
    rmSync(join(dir, 'packhub.lock.json'), { force: true });
    const { ctx, plan } = lockPlan(dir);
    const res = inspectPack(dir, ctx.manifest!, plan);
    expect(res.issues.map((i) => i.code)).toContain('lock-missing');
    expect(res.issues.filter((i) => i.severity === 'error')).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('锁的主版本不认识 → lock-version（error），不拿里面的结果装', () => {
    const dir = pack();
    const file = join(dir, 'packhub.lock.json');
    const lock = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...lock, apiVersion: 'packhub.dev/lock/v1' }, null, 2), 'utf8');

    const { ctx, plan } = lockPlan(dir);
    const res = inspectPack(dir, ctx.manifest!, plan);
    const issue = res.issues.find((i) => i.code === 'lock-version');
    expect(issue?.severity).toBe('error');
    expect(res.lock).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('签名能验过；信任列表里没有它时给出 warning', () => {
    const dir = pack();
    const { ctx, plan } = lockPlan(dir);
    const keys = generateKeyPair();
    const packName = 'demo/consume@0.0.1';
    writeSignature(dir, signPlan(keys.privatePem, packName, plan.planHash));

    const ok = inspectPack(dir, ctx.manifest!, plan);
    expect(ok.signatures).toHaveLength(1);
    expect(ok.signatures[0]!.ok).toBe(true);

    const untrusted = inspectPack(dir, ctx.manifest!, plan, { trusted: ['somebody-else'] });
    expect(untrusted.issues.map((i) => i.code)).toContain('signature-untrusted');

    const trusted = inspectPack(dir, ctx.manifest!, plan, { trusted: [keys.publicKey] });
    expect(trusted.issues.map((i) => i.code)).not.toContain('signature-untrusted');
    rmSync(dir, { recursive: true, force: true });
  });
});
