import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanCache, inspectCache } from '../src/index.ts';

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'packhub-cache-'));
  mkdirSync(join(root, '.packhub/cache/skills/orphan'), { recursive: true });
  writeFileSync(join(root, '.packhub/cache/skills/orphan/SKILL.md'), '# orphan\n', 'utf8');
  writeFileSync(join(root, '.packhub/cache/keep.tar.gz'), 'keep', 'utf8');
  writeFileSync(join(root, '.packhub/cache/orphan.bin'), 'orphan', 'utf8');
  writeFileSync(
    join(root, '.packhub/state.json'),
    JSON.stringify({
      apiVersion: 'packhub.dev/state/v0',
      packs: {
        'demo/cache@0.0.1': {
          planHash: 'sha256-x',
          installedAt: new Date().toISOString(),
          actions: [],
          written: ['.packhub/cache/keep.tar.gz'],
          plan: {
            apiVersion: 'packhub.dev/plan/v0',
            pack: { name: 'demo/cache', version: '0.0.1' },
            target: 'dir',
            actions: [
              {
                op: 'fetch',
                actionId: 'fetch#1',
                uri: 'https://example.test/keep.tar.gz',
                dest: '.packhub/cache/keep.tar.gz',
              },
            ],
            verify: [],
            excluded: [],
            planHash: 'sha256-x',
          },
        },
      },
    }),
    'utf8',
  );
  return root;
}

describe('缓存回收', () => {
  it('只删没有被计划引用的项，dry-run 不动盘', () => {
    const root = project();
    const report = inspectCache(root);
    const byPath = new Map(report.entries.map((e) => [e.path, e]));
    expect(byPath.get('.packhub/cache/keep.tar.gz')?.referenced).toBe(true);
    expect(byPath.get('.packhub/cache/orphan.bin')?.referenced).toBe(false);
    expect(byPath.get('.packhub/cache/skills/orphan')?.referenced).toBe(false);

    const dry = cleanCache(root, { dryRun: true });
    expect(dry.removed.sort()).toEqual(['.packhub/cache/orphan.bin', '.packhub/cache/skills/orphan']);
    expect(existsSync(join(root, '.packhub/cache/orphan.bin'))).toBe(true);

    const real = cleanCache(root);
    expect(real.removed.length).toBe(2);
    expect(existsSync(join(root, '.packhub/cache/keep.tar.gz'))).toBe(true);
    expect(existsSync(join(root, '.packhub/cache/orphan.bin'))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
