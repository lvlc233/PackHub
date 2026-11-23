import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractMarker, probeHarness, probeSkill, type Runner } from '../src/index.ts';
// askHarness 不是公共导出面（scenario 内部用），测试直接读模块
import { askHarness } from '../src/harness-probe.ts';

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

describe('probeSkill（技能选择器）', () => {
  it('回答里出现 skill 名 → ok；不出现 → 失败并说明原因', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-probe-skill-'));
    const yes: Runner = () => ({ status: 0, stdout: 'hello\nreview-rules\n', stderr: '' });
    const no: Runner = () => ({ status: 0, stdout: 'hello\n', stderr: '' });

    const ok = probeSkill({ target: 'dsh', projectDir: dir, skill: 'review-rules', runner: yes });
    expect(ok.ok).toBe(true);
    expect(ok.marker).toBe('review-rules');

    const bad = probeSkill({ target: 'dsh', projectDir: dir, skill: 'review-rules', runner: no });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/选择器/);
    rmSync(dir, { recursive: true, force: true });
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

  it('没有指令文件时直接说明先用 pal install 装', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-probe3-'));
    const res = probeHarness({ target: 'dsh', projectDir: dir });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/先用 pal install --harness dsh/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('dsh 探针参数', () => {
  it('固定走无头探针 profile，并带上 --json 与可选 patch', () => {
    const dir = project();
    const seen: { command?: string; args?: string[] } = {};
    const runner: Runner = (command, args) => {
      seen.command = command;
      seen.args = args;
      return { status: 0, stdout: '{"type":"final","text":"测试包标题"}', stderr: '' };
    };

    const res = probeHarness({ target: 'dsh', projectDir: dir, patchFile: 'patch.yml', runner });
    expect(seen.command).toBe('dsh');
    expect(seen.args).toEqual(['--profile', 'headless', '--patch', 'patch.yml', '--json', expect.any(String)]);
    expect(res.command).toBe('dsh --profile headless --patch patch.yml --json "<prompt>"');

    rmSync(dir, { recursive: true, force: true });
  });

  it('没有 patch 时不留空参数', () => {
    const dir = project();
    const seen: { args?: string[] } = {};
    const runner: Runner = (_command, args) => {
      seen.args = args;
      return { status: 0, stdout: '{"type":"final","text":"测试包标题"}', stderr: '' };
    };

    const res = probeHarness({ target: 'dsh', projectDir: dir, runner });
    expect(seen.args).toEqual(['--profile', 'headless', '--json', expect.any(String)]);
    expect(res.command).toBe('dsh --profile headless --json "<prompt>"');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('claude-code 目标（走注册表里的配方）', () => {
  it('命令是 claude -p，剥掉 ANSI 后比对标记', () => {
    // claude-code 的指令文件是 CLAUDE.md（注册表里的 instructionFile）
    const dir = mkdtempSync(join(tmpdir(), 'packhub-probe-cc-'));
    writeFileSync(join(dir, 'CLAUDE.md'), AGENTS, 'utf8');
    const seen: { command?: string; args?: string[] } = {};
    const runner: Runner = (command, args) => {
      seen.command = command;
      seen.args = args;
      return {
        status: 0,
        stdout: '\u001b[0m这个项目装了一个整合包：**测试包标题**（0.0.1）。\n',
        stderr: '',
      };
    };
    const res = probeHarness({ target: 'claude-code', projectDir: dir, runner });
    expect(res.ok).toBe(true);
    expect(res.answer).not.toContain('\u001b[');
    expect(seen.command).toBe('claude');
    expect(seen.args?.slice(0, 2)).toEqual(['-p', expect.any(String)]);
    expect(res.command).toBe(
      'claude -p "<prompt>" --max-budget-usd 0.05 --no-session-persistence',
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('opencode 目标（走注册表里的配方）', () => {
  it('命令是 opencode run --model，默认用配方的免费档模型，剥 ANSI 后比对标记', () => {
    const dir = project();
    const seen: { command?: string; args?: string[] } = {};
    const runner: Runner = (command, args) => {
      seen.command = command;
      seen.args = args;
      return {
        status: 0,
        stdout: '\u001b[0m> build · deepseek-v4.1-flash\n\u001b[0m这个项目装了一个整合包：**测试包标题**（0.0.1）。\n',
        stderr: '',
      };
    };
    const res = probeHarness({ target: 'opencode', projectDir: dir, runner });
    expect(res.ok).toBe(true);
    expect(res.answer).not.toContain('\u001b[');
    expect(seen.command).toBe('opencode');
    expect(seen.args?.slice(0, 2)).toEqual(['run', '--model']);
    // 配方自带默认模型（免费档），没显式给 model 时用它
    expect(seen.args?.[2]).toBe('opencode-go/deepseek-v4.1-flash');
    expect(res.command).toBe('opencode run --model opencode-go/deepseek-v4.1-flash "<prompt>"');
    rmSync(dir, { recursive: true, force: true });
  });

  it('显式给 model 时覆盖配方默认值', () => {
    const dir = project();
    const seen: { args?: string[] } = {};
    const runner: Runner = (_command, args) => {
      seen.args = args;
      return { status: 0, stdout: '这个项目装了一个整合包：**测试包标题**（0.0.1）。\n', stderr: '' };
    };
    probeHarness({ target: 'opencode', projectDir: dir, model: 'other/model', runner });
    expect(seen.args?.[2]).toBe('other/model');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('未知宿主被回绝', () => {
  it('nope 不是宿主：probeHarness 回绝、不执行命令、原因点明未知宿主', () => {
    const dir = project();
    let called = false;
    const runner: Runner = () => {
      called = true;
      return { status: 0, stdout: '这个项目装了一个整合包：**测试包标题**（0.0.1）。\n', stderr: '' };
    };
    const res = probeHarness({ target: 'nope', projectDir: dir, runner });
    expect(res.ok).toBe(false);
    expect(called, '不认识的宿主不该被执行').toBe(false);
    expect(res.command).toBe('');
    expect(res.reason).toContain('未知宿主');
    expect(res.reason).toContain('nope');
    rmSync(dir, { recursive: true, force: true });
  });

  it('probeSkill 同样回绝未知宿主，不跑命令', () => {
    const dir = project();
    let called = false;
    const runner: Runner = () => {
      called = true;
      return { status: 0, stdout: 'hello\n', stderr: '' };
    };
    const res = probeSkill({ target: 'nope', projectDir: dir, skill: 'hello', runner });
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
    expect(res.reason).toContain('未知宿主');
    rmSync(dir, { recursive: true, force: true });
  });

  it('askHarness 也回绝未知宿主（scenario 的 harness 来自清单数据）', () => {
    const dir = project();
    let called = false;
    const runner: Runner = () => {
      called = true;
      return { status: 0, stdout: '', stderr: '' };
    };
    const res = askHarness({ target: 'nope', projectDir: dir, prompt: 'hi', runner });
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
    expect(res.command).toBe('');
    expect(res.reason).toContain('未知宿主');
    rmSync(dir, { recursive: true, force: true });
  });
});
describe('codex 目标', () => {
  it('默认用原生 gpt-5.6-sol，命令里带 sandbox read-only', () => {
    const dir = project();
    const runner: Runner = () => ({
      status: 0,
      stdout: 'codex\n这个项目装了一个整合包：**测试包标题**（0.0.1）。\ntokens used\n6,973\n',
      stderr: '',
    });
    const res = probeHarness({ target: 'codex', projectDir: dir, runner });
    expect(res.ok).toBe(true);
    expect(res.command).toContain('codex exec');
    expect(res.command).toContain('gpt-5.6-sol');
    expect(res.command).toContain('--sandbox read-only');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('timeoutMs 真的交给 runner', () => {
  it('probeHarness 的 timeoutMs 作为第四个参数传给 runner', () => {
    const dir = project();
    let seen: { timeoutMs?: number } | undefined;
    const runner: Runner = (_command, _args, _cwd, opts) => {
      seen = opts;
      return {
        status: 0,
        stdout: '这个项目装了一个整合包：**测试包标题**（0.0.1）。\n',
        stderr: '',
      };
    };
    probeHarness({ target: 'dsh', projectDir: dir, runner, timeoutMs: 4321 });
    expect(seen?.timeoutMs).toBe(4321);
    rmSync(dir, { recursive: true, force: true });
  });

  it('probeSkill 也透传 timeoutMs', () => {
    const dir = project();
    let seen: { timeoutMs?: number } | undefined;
    const runner: Runner = (_command, _args, _cwd, opts) => {
      seen = opts;
      return { status: 0, stdout: 'hello', stderr: '' };
    };
    const res = probeSkill({ target: 'dsh', projectDir: dir, skill: 'hello', runner, timeoutMs: 999 });
    expect(seen?.timeoutMs).toBe(999);
    expect(res.ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('没给 timeoutMs 时第四参数是 undefined（走默认值）', () => {
    const dir = project();
    let argCount = -1;
    const runner: Runner = (...args) => {
      argCount = args.length;
      return {
        status: 0,
        stdout: '这个项目装了一个整合包：**测试包标题**（0.0.1）。\n',
        stderr: '',
      };
    };
    probeHarness({ target: 'dsh', projectDir: dir, runner });
    expect(argCount).toBe(4);
    // 第四项是 undefined：没有显式超时就走环境变量/默认值
    rmSync(dir, { recursive: true, force: true });
  });
});