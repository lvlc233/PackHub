import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor } from '@packhub/kernel';
import { contentHashFor, lockPack } from '../src/index.ts';

const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/multi, version: 0.0.1, targets: [dir, dsh] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`;

describe('锁与 target 无关', () => {
  it('锁只描述内容：不存计划快照，contentHash 不随安装 target 变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-multilock-'));
    writeFileSync(join(dir, 'packhub.yaml'), MANIFEST, 'utf8');
    writeFileSync(join(dir, 'rules.md'), '# r\n', 'utf8');

    const ctx = loadPack(dir);
    const res = await lockPack(ctx, { offline: true });
    expect(res.lock.contentHash).toMatch(/^sha256-/);
    expect('plan' in res.lock).toBe(false);
    expect('plans' in res.lock).toBe(false);

    // 同一份内容重算一次：resolvedAt 不进哈希，contentHash 必须稳定
    const again = await lockPack(loadPack(dir), { offline: true });
    expect(again.lock.contentHash).toBe(res.lock.contentHash);

    // 装到不同 target 现算的计划不同，但这些计划不进锁
    expect(planFor(ctx, { target: 'dir' }).plan!.planHash).not.toBe(
      planFor(ctx, { target: 'dsh' }).plan!.planHash,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('清单在 lock 后改动：按锁的 resolved 重算的 contentHash 与锁里记的不同', async () => {
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
    // 判据与 registry 门禁 / checkLockConsistency 同一口径
    expect(contentHashFor(loadPack(dir).manifest!, locked.lock)).not.toBe(locked.lock.contentHash);
    rmSync(dir, { recursive: true, force: true });
  });
});
