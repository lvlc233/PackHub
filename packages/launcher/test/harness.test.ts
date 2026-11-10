import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverAll, discoverHarness, requireHarness, resetHarnessCache, whichSync } from '../src/harness.ts';
import { isPalError } from '../src/errors.ts';

beforeEach(() => {
  process.env.PAL_DSH_BIN = process.execPath;
  resetHarnessCache();
});

afterEach(() => {
  delete process.env.PAL_DSH_BIN;
  resetHarnessCache();
});

describe('宿主发现', () => {
  it('探测到的版本在跳过探测的调用里也保留', () => {
    const probed = discoverHarness('dsh');
    expect(probed.available).toBe(true);
    expect(probed.version).toMatch(/^\d+\.\d+/);
    const skipped = discoverHarness('dsh', { probeVersion: false });
    expect(skipped.version).toBe(probed.version);
  });

  it('入口决定能不能起：终端宿主有 tui，项目目录只装配', () => {
    const claude = discoverHarness('claude-code', { probeVersion: false });
    expect(claude.startable).toBe(true);
    const dir = discoverHarness('dir', { probeVersion: false });
    expect(dir.kind).toBe('project');
    expect(dir.startable).toBe(false);
    expect(dir.reason).toContain('项目目录');
  });

  it('四个宿主的顺序稳定，未知宿主给可选值', () => {
    expect(discoverAll({ probeVersion: false }).map((info) => info.id)).toEqual([
      'dir',
      'dsh',
      'claude-code',
      'codex',
    ]);
    let caught: unknown;
    try {
      requireHarness('nope');
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('unknown-harness');
    expect((caught as { details?: { choices?: string[] } }).details?.choices).toContain('dsh');
  });

  it('PATH 里找不到就是找不到，不猜', () => {
    expect(whichSync('definitely-not-a-real-command-xyz')).toBeUndefined();
    expect(whichSync(process.execPath)).toBe(process.execPath);
  });
});
