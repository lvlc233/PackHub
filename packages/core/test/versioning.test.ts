import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPack, planFor, rollbackPack } from '../src/index.ts';

const MANIFEST = (source: string): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/ver, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ${source}
`;

function pack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-ver-'));
  writeFileSync(join(dir, 'packhub.yaml'), MANIFEST('./a.md'), 'utf8');
  writeFileSync(join(dir, 'a.md'), 'A\n', 'utf8');
  return dir;
}

describe('generation 与回退', () => {
  it('第二次安装覆盖同一文件，回退能把原内容放回去', async () => {
    const dir = pack();
    const first = planFor(loadPack(dir)).plan!;
    await installPack(loadPack(dir), first);
    const firstHash = JSON.parse(readFileSync(join(dir, '.packhub/state.json'), 'utf8')).packs[
      'demo/ver@0.0.1'
    ].planHash;
    expect(readFileSync(join(dir, '.packhub/knowledge/a.md'), 'utf8')).toBe('A\n');

    writeFileSync(join(dir, 'a.md'), 'B\n', 'utf8');
    const ctx2 = loadPack(dir);
    const second = planFor(ctx2).plan!;
    await installPack(ctx2, second);
    expect(readFileSync(join(dir, '.packhub/knowledge/a.md'), 'utf8')).toBe('B\n');

    expect(existsSync(join(dir, '.packhub/snapshots'))).toBe(true);
    const res = rollbackPack(dir);
    expect(res.restored).toContain('.packhub/knowledge/a.md');
    expect(readFileSync(join(dir, '.packhub/knowledge/a.md'), 'utf8')).toBe('A\n');

    const after = JSON.parse(readFileSync(join(dir, '.packhub/state.json'), 'utf8'));
    expect(after.packs['demo/ver@0.0.1'].planHash).toBe(firstHash);
    rmSync(dir, { recursive: true, force: true });
  });

  it('回退会删掉本次新建的文件', async () => {
    const dir = pack();
    await installPack(loadPack(dir), planFor(loadPack(dir)).plan!);

    // 加一个资源再装：这次它是新建的
    writeFileSync(
      join(dir, 'packhub.yaml'),
      MANIFEST('./a.md').replace(
        '  - id: rules',
        '  - id: extra\n    type: knowledge\n    source: ./b.md\n  - id: rules',
      ),
      'utf8',
    );
    writeFileSync(join(dir, 'b.md'), 'B\n', 'utf8');
    const ctx = loadPack(dir);
    await installPack(ctx, planFor(ctx).plan!);
    expect(existsSync(join(dir, '.packhub/knowledge/b.md'))).toBe(true);

    const res = rollbackPack(dir);
    expect(res.removed).toContain('.packhub/knowledge/b.md');
    expect(existsSync(join(dir, '.packhub/knowledge/b.md'))).toBe(false);
    expect(existsSync(join(dir, '.packhub/knowledge/a.md'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('只保留最近 5 个快照', async () => {
    const dir = pack();
    for (let i = 0; i < 7; i++) {
      writeFileSync(join(dir, 'a.md'), `A${i}\n`, 'utf8');
      const ctx = loadPack(dir);
      await installPack(ctx, planFor(ctx).plan!);
    }
    const snaps = readFileSync(join(dir, '.packhub/state.json'), 'utf8');
    const state = JSON.parse(snaps);
    expect(state.generations.length).toBeLessThanOrEqual(5);
    expect(statSync(join(dir, '.packhub/snapshots')).isDirectory()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
