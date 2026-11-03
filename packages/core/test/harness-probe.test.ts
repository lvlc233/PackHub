import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractMarker, probeHarness, type Runner } from '../src/index.ts';

const AGENTS = `用户自己的说明。

<!-- packhub:begin demo/x -->
这个项目装了一个整合包：**测试包标题**（0.0.1）。

可用的能力：
- \`rules\`（knowledge）
<!-- packhub:end demo/x -->
`;

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-probe-'));
  writeFileSync(join(dir, 'AGENTS.md'), AGENTS, 'utf8');
  return dir;
}

describe('extractMarker', () => {
  it('取块内第一行的标题', () => {
    expect(extractMarker(AGENTS)).toBe('测试包标题');
  });

  it('没有块时返回 null', () => {
    expect(extractMarker('普通说明')).toBeNull();
  });
});

describe('probeHarness', () => {
  it('回答里出现标记 → ok', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-probe2-'));
    writeFileSync(join(dir, 'AGENTS.md'), AGENTS, 'utf8');
    const runner: Runner = () => ({
      status: 0,
      stdout: JSON.stringify({ type: 'final', text: '这个项目装了一个整合包：**测试包标题**（0.0.1）。' }),
      stderr: '',
    });
    const res = probeHarness({ target: 'dsh', projectDir: dir, runner });
    expect(res.ok).toBe(true);
    expect(res.answer).toContain('测试包标题');
    rmSync(dir, { recursive: true, force: true });
  });

  it('回答里没有标记 → 失败并说明原因', () => {
    const dir = project();
    const runner: Runner = () => ({ status: 0, stdout: '{"type":"final","text":"没有"}', stderr: '' });
    const res = probeHarness({ target: 'dsh', projectDir: dir, runner });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/没把这份指令读进上下文/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('缺凭证时给出可执行的原因', () => {
    const dir = project();
    const runner: Runner = () => ({
      status: 1,
      stdout: '',
      stderr: 'MISSING_CREDENTIAL: llm-deepseek: no API key',
    });
    const res = probeHarness({ target: 'dsh', projectDir: dir, runner });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/DEEPSEEK_API_KEY/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('没有指令文件时直接说明先装', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-probe3-'));
    const res = probeHarness({ target: 'dsh', projectDir: dir });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/先 install/);
    rmSync(dir, { recursive: true, force: true });
  });
});
