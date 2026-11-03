import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type HarnessTarget = 'dsh' | 'claude-code' | 'opencode';

export interface RunnerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string, args: string[], cwd: string) => RunnerResult;

export interface ProbeOptions {
  target: HarnessTarget;
  projectDir: string;
  timeoutMs?: number;
  /** dsh 用的额外 patch 层（配置 provider 等），可省 */
  patchFile?: string;
  /** opencode 用的模型，默认走 opencode-go 的免费档路线 */
  model?: string;
  /** 测试注入用；默认 spawnSync */
  runner?: Runner;
}

export interface ProbeResult {
  ok: boolean;
  harness: HarnessTarget;
  /** 实际执行的命令（给用户看） */
  command: string;
  /** agent 的最终回答 */
  answer: string;
  /** 期望在回答里出现的标记 */
  marker: string | null;
  reason?: string;
}

const DEFAULT_RUNNER: Runner = (command, args, cwd) => {
  const res = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: Number(process.env.PACKHUB_PROBE_TIMEOUT ?? 180_000),
    shell: process.platform === 'win32',
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
};

/** 从托管块里取一个"回答里应该出现"的标记：块内第一行的标题，取不到就用整行。 */
export function extractMarker(text: string): string | null {
  const begin = text.indexOf('<!-- packhub:begin');
  if (begin < 0) return null;
  const end = text.indexOf('-->', begin);
  if (end < 0) return null;
  const after = text.slice(end + 3);
  const stop = after.indexOf('<!-- packhub:end');
  const block = stop >= 0 ? after.slice(0, stop) : after;
  const firstLine = block
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  const bold = /\*\*(.+?)\*\*/.exec(firstLine);
  return (bold?.[1] ?? firstLine).slice(0, 60);
}

const QUESTION =
  '只做一件事：如果项目说明里有一个以 packhub:begin 开头的注释块，把该块内第一行的原文复述出来；找不到就只回答「没有」。不要解释。';

function parseDshFinal(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!) as { type?: string; text?: string };
      if (event.type === 'final' && typeof event.text === 'string') return event.text;
    } catch {
      /* 非 JSON 行，跳过 */
    }
  }
  return stdout.trim();
}

/**
 * 真机探针：调用目标 harness 的 headless 入口问一句，看它的回答里有没有包写进去的标记。
 * 声明式检查做不到这件事——只有真跑一次才知道 harness 有没有读。
 */
export function probeHarness(opts: ProbeOptions): ProbeResult {
  const instructionFile = opts.target === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md';
  const file = join(opts.projectDir, instructionFile);
  const base: ProbeResult = {
    ok: false,
    harness: opts.target,
    command: '',
    answer: '',
    marker: null,
  };

  if (!existsSync(file)) {
    return { ...base, reason: `${instructionFile} 不存在——先 install --target ${opts.target}` };
  }
  const text = readFileSync(file, 'utf8');
  const marker = extractMarker(text);
  if (!marker) {
    return { ...base, reason: `${instructionFile} 里没有 packhub 托管块` };
  }

  const runner = opts.runner ?? DEFAULT_RUNNER;
  const model = opts.model ?? 'opencode-go/deepseek-v4.1-flash';
  const command =
    opts.target === 'dsh'
      ? `dsh --profile headless${opts.patchFile ? ` --patch ${opts.patchFile}` : ''} --json "<question>"`
      : opts.target === 'opencode'
        ? `opencode run --model ${model} "<question>"`
        : 'claude -p "<question>" --max-budget-usd 0.05 --no-session-persistence';

  const dshArgs = [
    '--profile',
    'headless',
    ...(opts.patchFile ? ['--patch', opts.patchFile] : []),
    '--json',
    QUESTION,
  ];
  const res =
    opts.target === 'dsh'
      ? runner('dsh', dshArgs, opts.projectDir)
      : opts.target === 'opencode'
        ? runner('opencode', ['run', '--model', model, QUESTION], opts.projectDir)
        : runner(
            'claude',
            ['-p', QUESTION, '--max-budget-usd', '0.05', '--no-session-persistence'],
            opts.projectDir,
          );

  const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
  const answer =
    opts.target === 'dsh'
      ? parseDshFinal(res.stdout)
      : opts.target === 'opencode'
        ? stripAnsi(res.stdout).trim()
        : res.stdout.trim();
  const combined = `${res.stdout}\n${res.stderr}`;

  if (/MISSING_CREDENTIAL|no API key/i.test(combined)) {
    return {
      ...base,
      marker,
      command,
      answer,
      reason: '缺少凭证：headless 需要环境变量 DEEPSEEK_API_KEY（桌面应用里存的那份读不到）',
    };
  }
  if (/Not logged in|/i.test(combined) && /Not logged in/i.test(combined)) {
    return { ...base, marker, command, answer, reason: 'Claude Code 未登录：先跑 claude 并 /login' };
  }
  if (res.status !== 0) {
    return {
      ...base,
      marker,
      command,
      answer,
      reason: `命令退出码 ${res.status}：${res.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? ''}`,
    };
  }

  const ok = answer.includes(marker);
  return {
    ok,
    harness: opts.target,
    command,
    answer,
    marker,
    ...(ok ? {} : { reason: '回答里没有出现托管块的标记——harness 没把这份指令读进上下文' }),
  };
}
