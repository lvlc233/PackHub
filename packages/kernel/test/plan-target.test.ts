import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor } from '../src/index.ts';

const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/target-gate, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`;

function pack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-target-gate-'));
  writeFileSync(join(dir, 'packhub.yaml'), MANIFEST, 'utf8');
  writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
  return dir;
}

describe('target 声明门在 planFor（单一入口）', () => {
  it('未声明的 target 不出计划，报 undeclared-target 并列出声明值', () => {
    const dir = pack();
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const { plan, issues } = planFor(ctx, { target: 'dsh' });
    expect(plan).toBeUndefined();
    const issue = issues.find((i) => i.code === 'undeclared-target');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('dsh');
    expect(issue?.message).toContain('dir');

    // 默认 target=dir 同样受声明门约束：只声明 dsh 的包不能出 dir 计划
    const dshOnly = mkdtempSync(join(tmpdir(), 'packhub-target-gate-dsh-'));
    writeFileSync(join(dshOnly, 'packhub.yaml'), MANIFEST.replace('[dir]', '[dsh]'), 'utf8');
    writeFileSync(join(dshOnly, 'rules.md'), '# rules\n', 'utf8');
    const defaulted = planFor(loadPack(dshOnly));
    expect(defaulted.plan).toBeUndefined();
    expect(defaulted.issues.map((i) => i.code)).toContain('undeclared-target');

    rmSync(dir, { recursive: true, force: true });
    rmSync(dshOnly, { recursive: true, force: true });
  });

  it('声明了的 target 照常出计划', () => {
    const dir = pack();
    const { plan, issues } = planFor(loadPack(dir), { target: 'dir' });
    expect(issues).toEqual([]);
    expect(plan?.target).toBe('dir');

    rmSync(dir, { recursive: true, force: true });
  });
});
