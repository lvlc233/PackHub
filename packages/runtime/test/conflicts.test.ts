import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPack, planFor } from '../src/index.ts';

function makePack(root: string, name: string, content: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'rules.md'), content, 'utf8');
  writeFileSync(
    join(root, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: ${name}, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`,
    'utf8',
  );
  return root;
}

describe('项目级所有权', () => {
  it('两个包写同一个文件时拒绝，加 overwrite 才放行', async () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-own-'));
    const a = makePack(join(base, 'a'), 'demo/a', '# A\n');
    const b = makePack(join(base, 'b'), 'demo/b', '# B\n');
    const project = join(base, 'proj');
    mkdirSync(project, { recursive: true });

    const ctxA = loadPack(a);
    await installPack(ctxA, planFor(ctxA).plan!, { root: project, packRoot: a });

    const ctxB = loadPack(b);
    const planB = planFor(ctxB).plan!;
    await expect(installPack(ctxB, planB, { root: project, packRoot: b })).rejects.toThrow(
      /已被别的包占用/,
    );

    const ok = await installPack(ctxB, planB, { root: project, packRoot: b, overwrite: true });
    expect(ok.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });

  it('配置文件是指路共享物，不算冲突', async () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-own2-'));
    const mk = (name: string, file: string): string => {
      const dir = join(base, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), 'review:\n  strict: true\n', 'utf8');
      writeFileSync(
        join(dir, 'packhub.yaml'),
        `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/${name}, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: cfg
    type: config
    source: ./${file}
`,
        'utf8',
      );
      return dir;
    };
    const a = mk('p1', 'f1.yaml');
    const b = mk('p2', 'f2.yaml');
    const project = join(base, 'proj');
    mkdirSync(project, { recursive: true });

    for (const dir of [a, b]) {
      const ctx = loadPack(dir);
      const res = await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: dir });
      expect(res.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    }
    rmSync(base, { recursive: true, force: true });
  });
});
