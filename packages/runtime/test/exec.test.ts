import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPack, planFor } from '../src/index.ts';

function pack(exec: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-exec-'));
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/exec, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
install:
  exec:
${exec}
`,
    'utf8',
  );
  writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
  return dir;
}

describe('exec 动作', () => {
  it('默认只给审批状态，不执行', async () => {
    const dir = pack(`    - command: node
      args: ["-e", "require('fs').writeFileSync('exec.txt','x')"]`);
    const ctx = loadPack(dir);
    const res = await installPack(ctx, planFor(ctx).plan!);
    const exec = res.outcomes.find((o) => o.op === 'exec')!;
    expect(exec.status).toBe('needs-approval');
    expect(existsSync(join(dir, 'exec.txt'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('--allow-exec 后真的执行，退出码非零时回滚', async () => {
    const ok = pack(`    - command: node
      args: ["-e", "require('fs').writeFileSync('exec.txt','x')"]`);
    const ctx = loadPack(ok);
    const done = await installPack(ctx, planFor(ctx).plan!, { allowExec: true });
    expect(done.outcomes.find((o) => o.op === 'exec')!.status).toBe('done');
    expect(existsSync(join(ok, 'exec.txt'))).toBe(true);
    rmSync(ok, { recursive: true, force: true });

    const bad = pack(`    - command: node
      args: ["-e", "process.exit(3)"]`);
    const badCtx = loadPack(bad);
    const failed = await installPack(badCtx, planFor(badCtx).plan!, { allowExec: true });
    expect(failed.outcomes.find((o) => o.op === 'exec')!.status).toBe('failed');
    expect(failed.rolledBack).toBe(true);
    expect(existsSync(join(bad, '.packhub/knowledge/rules.md'))).toBe(false);
    expect(existsSync(join(bad, '.packhub/state.json'))).toBe(false);
    rmSync(bad, { recursive: true, force: true });
  });
});
