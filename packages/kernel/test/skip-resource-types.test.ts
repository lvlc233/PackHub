import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor } from '../src/index.ts';

const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/skip, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
  - id: gh
    type: mcp
    source: npm:@demo/mcp@1.2.3
    transport: stdio
`;

function pack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-skip-'));
  writeFileSync(join(dir, 'packhub.yaml'), MANIFEST, 'utf8');
  writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
  return dir;
}

describe('planFor 转发 skipResourceTypes', () => {
  it('传 skipResourceTypes: [mcp] 时不生成 register.mcp，资源进 excluded 的 host-managed', () => {
    const dir = pack();
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const skipped = planFor(ctx, { target: 'dir', skipResourceTypes: ['mcp'] }).plan!;
    expect(skipped.actions.some((a) => a.op === 'register.mcp')).toBe(false);
    expect(skipped.excluded).toContainEqual({ resource: 'gh', alternative: '', reason: 'host-managed' });
    // 其他资源照常进计划
    expect(skipped.actions.some((a) => a.op === 'write' && a.to === '.packhub/knowledge/rules.md')).toBe(true);

    // 不传这个选项时行为不变
    const normal = planFor(ctx, { target: 'dir' }).plan!;
    expect(normal.actions.some((a) => a.op === 'register.mcp')).toBe(true);
    expect(normal.excluded).toEqual([]);
    expect(normal.planHash).not.toBe(skipped.planHash);

    rmSync(dir, { recursive: true, force: true });
  });
});
