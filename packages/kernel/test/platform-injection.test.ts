import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor } from '../src/index.ts';

function pack(manifest: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-platform-'));
  writeFileSync(join(dir, 'packhub.yaml'), manifest, 'utf8');
  writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content, 'utf8');
  }
  return dir;
}

const BODY = (resources: string): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/platform, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
${resources}`;

describe('平台注入：计划产物与平台无关', () => {
  it('两个注入平台算出的 planHash 相等，动作里保留 platforms', () => {
    const dir = pack(
      BODY(`  - id: rules
    type: knowledge
    source: ./rules.md
  - id: kit
    type: tool2
    source: ./tools/kit
    commands:
      - name: kit-run
        exec: index.mjs
        runtime: node
        platforms: [linux-x64, win32-x64]
        usage: kit-run <dir>
`),
      { 'tools/kit/index.mjs': 'export const x = 1;\n' },
    );
    const ctx = loadPack(dir);
    const linux = planFor(ctx, { target: 'dir', platform: 'linux-x64' });
    const win = planFor(ctx, { target: 'dir', platform: 'win32-x64' });
    expect(linux.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(win.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(linux.plan!.planHash).toBe(win.plan!.planHash);
    expect(linux.plan!.actions).toEqual(win.plan!.actions);

    const link = linux.plan!.actions.find((a) => a.op === 'link.exec');
    expect(link && link.op === 'link.exec' ? link.platforms : undefined).toEqual([
      'linux-x64',
      'win32-x64',
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('shell 在 win32 只给警告，不删动作；两个平台 planHash 仍相等', () => {
    const dir = pack(
      BODY(`  - id: kit
    type: tool2
    source: ./tools/kit
    commands:
      - name: kit-run
        exec: run.sh
        runtime: shell
        usage: kit-run <dir>
`),
      { 'tools/kit/run.sh': 'echo hi\n' },
    );
    const ctx = loadPack(dir);
    const linux = planFor(ctx, { target: 'dir', platform: 'linux-x64' });
    const win = planFor(ctx, { target: 'dir', platform: 'win32-x64' });
    expect(linux.plan).toBeDefined();
    expect(win.plan).toBeDefined();
    expect(win.plan!.planHash).toBe(linux.plan!.planHash);
    expect(win.plan!.actions.some((a) => a.op === 'link.exec')).toBe(true);
    // 警告只在注入 win32 时出现，且不是 error（否则计划不会生成）
    expect(win.issues.find((i) => i.code === 'tool-shell-unsupported')?.severity).toBe('warning');
    expect(linux.issues.find((i) => i.code === 'tool-shell-unsupported')).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
