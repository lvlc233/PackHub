import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPack } from '../src/index.ts';

function pack(opts: { verifyPass?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-runner-'));
  writeFileSync(join(dir, 'rules.md'), '# r\n', 'utf8');
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/runner, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
verify:
  - type: file-exists
    path: '\${target.skillsDir}/../knowledge/rules.md'
`,
    'utf8',
  );
  return dir;
}

describe('runner', () => {
  it('干净目录装一遍并出报告', async () => {
    const dir = pack();
    const { report, installed } = await runPack(dir, { out: join(dir, 'verify.json') });
    expect(installed).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.planHash).toMatch(/^sha256-/);
    expect(report.checks.length).toBeGreaterThan(0);

    const written = JSON.parse(readFileSync(join(dir, 'verify.json'), 'utf8'));
    expect(written.planHash).toBe(report.planHash);
    // 干净目录：包目录里不该被装上 .packhub
    expect(() => readFileSync(join(dir, '.packhub/state.json'))).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('校验不过时 ok=false', async () => {
    const dir = pack();
    writeFileSync(
      join(dir, 'packhub.yaml'),
      readFileSync(join(dir, 'packhub.yaml'), 'utf8').replace('knowledge/rules.md', 'knowledge/nope.md'),
      'utf8',
    );
    const { report } = await runPack(dir);
    expect(report.ok).toBe(false);
    expect(report.checks.some((c) => c.status === 'fail')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('清单有问题直接抛错，不装', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-runner-bad-'));
    writeFileSync(join(dir, 'packhub.yaml'), 'apiVersion: nope', 'utf8');
    await expect(runPack(dir)).rejects.toThrow(/清单未通过校验/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('带 exec 的包默认不算 verified；allowExec 后才通过', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-runner-exec-'));
    writeFileSync(join(dir, 'rules.md'), '# r\n', 'utf8');
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/runner-exec, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
install:
  exec:
    - command: node
      args: ["-e", "process.exit(0)"]
`,
      'utf8',
    );

    const blocked = await runPack(dir);
    expect(blocked.report.outcomes.some((o) => o.status === 'needs-approval')).toBe(true);
    expect(blocked.report.ok).toBe(false);

    const allowed = await runPack(dir, { allowExec: true });
    expect(allowed.report.outcomes.every((o) => o.status === 'done' || o.status === 'noop')).toBe(true);
    expect(allowed.report.ok).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});
