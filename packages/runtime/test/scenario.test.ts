import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks } from '../src/index.ts';

describe('scenario 验收', () => {
  it('跑一条最小任务，同时检查退出码、输出与产出文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'packhub-scn-'));
    writeFileSync(
      join(root, 'smoke.js'),
      'require("node:fs").writeFileSync("out.txt", "made"); console.log("SMOKE OK");\n',
      'utf8',
    );
    const results = runChecks(
      [
        {
          type: 'scenario',
          run: [process.execPath, 'smoke.js'],
          expectOutput: 'SMOKE OK',
          expectFiles: ['out.txt'],
        },
      ],
      { root },
    );
    expect(results[0]?.status).toBe('pass');
    rmSync(root, { recursive: true, force: true });
  });

  it('退出码或期望输出不对时失败，不把“跑过”当“通过”', () => {
    const root = mkdtempSync(join(tmpdir(), 'packhub-scn-bad-'));
    writeFileSync(join(root, 'fail.js'), 'console.log("nope"); process.exit(3);\n', 'utf8');
    const results = runChecks(
      [
        { type: 'scenario', run: [process.execPath, 'fail.js'], expectExit: 3, expectOutput: 'missing' },
        { type: 'scenario', run: [process.execPath, 'fail.js'], expectExit: 0 },
      ],
      { root },
    );
    expect(results.map((r) => r.status)).toEqual(['fail', 'fail']);
    expect(results[0]?.detail).toContain('输出里缺');
    expect(results[1]?.detail).toContain('退出码 3');
    rmSync(root, { recursive: true, force: true });
  });

  it('缺 run/harness 时明确跳过，不算通过', () => {
    const root = mkdtempSync(join(tmpdir(), 'packhub-scn-skip-'));
    const results = runChecks([{ type: 'scenario' }], { root });
    expect(results[0]?.status).toBe('skipped');
    rmSync(root, { recursive: true, force: true });
  });
});
