import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertHarnessRoot, harnessRoot, isSyncTarget, resolveSyncTargets, syncTargets } from '../src/index.ts';

describe('harness 注册表', () => {
  it('目标名单来自一张表，未知值不进名单', () => {
    expect(syncTargets()).toEqual(['dsh', 'codex', 'claude-code']);
    expect(isSyncTarget('dsh')).toBe(true);
    expect(isSyncTarget('opencode')).toBe(false);
  });

  it('`.` 按包声明的 targets 展开，去重保序', () => {
    expect(resolveSyncTargets('.', ['dir', 'dsh', 'codex'])).toEqual(['dsh', 'codex']);
    expect(resolveSyncTargets('.', [])).toEqual(syncTargets());
    expect(resolveSyncTargets('dsh,dsh,codex')).toEqual(['dsh', 'codex']);
    expect(resolveSyncTargets('all', ['claude-code'])).toEqual(['claude-code']);
  });

  it('包没有声明可同步的 target 时报错，不悄悄跳过', () => {
    expect(() => resolveSyncTargets('.', ['dir'])).toThrow(/没有声明可同步的 target/);
  });

  it('未知目标报错并列出可选项', () => {
    expect(() => resolveSyncTargets('opencode')).toThrow(/未知 target：opencode/);
    expect(resolveSyncTargets('dsh,codex')).toEqual(['dsh', 'codex']);
  });

  it('home 优先取注册表里的环境变量', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-harness-'));
    const previous = process.env.PACKHUB_DSH_HOME;
    process.env.PACKHUB_DSH_HOME = dir;
    try {
      expect(harnessRoot('dsh')).toBe(resolve(dir));
      expect(() => assertHarnessRoot('dsh', join(dir, 'missing'))).toThrow(/home 不存在/);
      expect(() => assertHarnessRoot('dsh', dir)).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.PACKHUB_DSH_HOME;
      else process.env.PACKHUB_DSH_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
