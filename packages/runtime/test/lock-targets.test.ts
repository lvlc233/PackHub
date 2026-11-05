import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor } from '@packhub/kernel';
import { lockPack } from '../src/index.ts';

const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/multi, version: 0.0.1, targets: [dir, dsh] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`;

describe('多 target 锁', () => {
  it('每个声明的 target 各锁一份计划，主计划仍是 dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-multilock-'));
    writeFileSync(join(dir, 'packhub.yaml'), MANIFEST, 'utf8');
    writeFileSync(join(dir, 'rules.md'), '# r\n', 'utf8');

    const ctx = loadPack(dir);
    const res = await lockPack(ctx, { offline: true });
    expect(res.plan.target).toBe('dir');
    expect(res.lock.planHash).toBe(res.plan.planHash);
    expect(res.lock.plan?.planHash).toBe(res.plan.planHash);
    expect(Object.keys(res.lock.plans ?? {}).sort()).toEqual(['dir', 'dsh']);
    for (const target of ['dir', 'dsh'] as const) {
      expect(res.lock.plans?.[target]?.planHash).toBe(
        planFor(ctx, { target }).plan!.planHash,
      );
    }
    // dsh 会多写 AGENTS.md 托管块，因此哈希与 dir 不同
    expect(res.lock.plans?.dsh?.planHash).not.toBe(res.lock.plans?.dir?.planHash);
    rmSync(dir, { recursive: true, force: true });
  });

  it('清单在 lock 后改动时，对应 target 的计划哈希就变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-multilock-'));
    writeFileSync(join(dir, 'packhub.yaml'), MANIFEST, 'utf8');
    writeFileSync(join(dir, 'rules.md'), '# r\n', 'utf8');
    const locked = await lockPack(loadPack(dir), { offline: true });

    writeFileSync(join(dir, 'extra.md'), '# e\n', 'utf8');
    writeFileSync(
      join(dir, 'packhub.yaml'),
      MANIFEST.replace(
        '  - id: rules',
        '  - id: extra\n    type: knowledge\n    source: ./extra.md\n  - id: rules',
      ),
      'utf8',
    );
    const changed = planFor(loadPack(dir), { target: 'dsh' }).plan!;
    expect(changed.planHash).not.toBe(locked.lock.plans?.dsh?.planHash);
    expect(changed.planHash).not.toBe(locked.lock.plans?.dir?.planHash);
    rmSync(dir, { recursive: true, force: true });
  });
});
