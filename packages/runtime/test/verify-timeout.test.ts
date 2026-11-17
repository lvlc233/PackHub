import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const probe = vi.hoisted(() => ({ ask: vi.fn() }));

vi.mock('../src/harness-probe.ts', () => ({
  askHarness: probe.ask,
}));

import { runChecks } from '../src/verify.ts';

describe('verify 的 scenario timeout 真的传给 harness 探针', () => {
  it('check.timeout（秒）换算成毫秒传给 askHarness', async () => {
    probe.ask.mockReturnValue({
      ok: true,
      answer: 'ok',
      command: '',
      status: 0,
      stdout: 'ok',
      stderr: '',
    });
    const root = mkdtempSync(join(tmpdir(), 'packhub-verify-timeout-'));
    const results = await runChecks(
      [{ type: 'scenario', harness: 'dsh', prompt: 'hi', expectOutput: 'ok', timeout: 7 }],
      { root },
    );
    expect(probe.ask).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'dsh', prompt: 'hi', timeoutMs: 7000 }),
    );
    expect(results[0]!.status).toBe('pass');
    rmSync(root, { recursive: true, force: true });
  });
});
