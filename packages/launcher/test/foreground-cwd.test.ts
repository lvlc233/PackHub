import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foregroundPlan, LAUNCH_FILE } from '../src/foreground.ts';
import { requireAdapter } from '../src/layout.ts';
import type { InstanceRecord } from '../src/records.ts';

const DIRS: string[] = [];
afterAll(() => {
  for (const dir of DIRS) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pal-foreground-'));
  DIRS.push(dir);
  return dir;
}

function recordOf(root: string, attached = false): InstanceRecord {
  return {
    id: 'x',
    name: 'x',
    harness: 'opencode',
    root,
    home: join(root, 'home', 'opencode'),
    attached,
  } as unknown as InstanceRecord;
}

function tui() {
  const adapter = requireAdapter('opencode');
  const mode = adapter.modes.find((item) => item.kind === 'foreground');
  if (!mode) throw new Error('opencode 没有前台模式');
  return { adapter, mode };
}

describe('前台模式的工作目录', () => {
  it('默认是当前目录（不是 home 根）', () => {
    const root = home();
    const { adapter, mode } = tui();
    const plan = foregroundPlan(recordOf(root), adapter, mode);
    expect(plan.cwd).toBe(process.cwd());
  });

  it('--home-root 落在安装位置（home 根）', () => {
    const root = home();
    const { adapter, mode } = tui();
    const plan = foregroundPlan(recordOf(root), adapter, mode, { homeRoot: true });
    expect(plan.cwd).toBe(root);
  });

  it('--dir 指定位置，优先级高于 launch.json 与 home 根', () => {
    const root = home();
    writeFileSync(join(root, LAUNCH_FILE), JSON.stringify({ dir: 'from-launch' }), 'utf8');
    const { adapter, mode } = tui();
    const target = home();
    expect(foregroundPlan(recordOf(root), adapter, mode, { dir: target }).cwd).toBe(target);
    expect(foregroundPlan(recordOf(root), adapter, mode, { homeRoot: true }).cwd).toBe(root);
  });

  it('没有 --dir/--home-root 时用 launch.json 的 dir', () => {
    const root = home();
    writeFileSync(join(root, LAUNCH_FILE), JSON.stringify({ dir: 'sub' }), 'utf8');
    const { adapter, mode } = tui();
    expect(foregroundPlan(recordOf(root), adapter, mode).cwd).toBe(join(root, 'sub'));
  });
});
