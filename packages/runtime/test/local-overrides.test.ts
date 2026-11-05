import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPack, planFor } from '../src/index.ts';

function pack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-local-'));
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/local, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./base.md
`,
    'utf8',
  );
  writeFileSync(join(dir, 'base.md'), 'base\n', 'utf8');
  writeFileSync(join(dir, 'alt.md'), 'local\n', 'utf8');
  mkdirSync(join(dir, '.packhub'), { recursive: true });
  return dir;
}

describe('.packhub/local.yaml', () => {
  it('覆盖资源 source 与环境变量，不改清单本身', async () => {
    const dir = pack();
    writeFileSync(
      join(dir, '.packhub/local.yaml'),
      `overrides:
  - resource: rules
    source: ./alt.md
composition:
  env: { FLAVOR: local }
`,
      'utf8',
    );
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);
    // 清单文件本身没被改
    expect(readFileSync(join(dir, 'packhub.yaml'), 'utf8')).toContain('source: ./base.md');

    const { plan } = planFor(ctx);
    expect(plan).toBeTruthy();
    const write = plan!.actions.find((a) => a.op === 'write');
    expect(write && 'from' in write ? write.from : '').toBe('./alt.md');
    const result = await installPack(ctx, plan!, { root: join(dir, 'out') });
    expect(result.outcomes.every((o) => o.status === 'done')).toBe(true);
    expect(readFileSync(join(dir, 'out/.packhub/knowledge/alt.md'), 'utf8')).toBe('local\n');
    rmSync(dir, { recursive: true, force: true });
  });

  it('坏 YAML 明确报错，不静默忽略', () => {
    const dir = pack();
    writeFileSync(join(dir, '.packhub/local.yaml'), 'overrides: [\n', 'utf8');
    const ctx = loadPack(dir);
    expect(ctx.issues.some((i) => i.code === 'local-overrides')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
