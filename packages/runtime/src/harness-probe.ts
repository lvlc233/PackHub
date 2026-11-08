import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * dsh 探针固定用到的命令与开关。
 * `--profile headless` 是 dsh 的无头探针 profile（一次性问答，不进 web 壳）；
 * 命令预览和真实 argv 都从这些常量取，免得同一个值在两处各写一份。
 */
const DSH_PROBE_COMMAND = 'dsh';
const DSH_PROBE_PROFILE = 'headless';
const DSH_PROFILE_FLAG = '--profile';
const DSH_PATCH_FLAG = '--patch';
const DSH_JSON_FLAG = '--json';

export type HarnessTarget = 'dsh' | 'claude-code' | 'opencode' | 'codex';

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
  /** opencode / codex 用的模型；默认 opencode-go 免费档 / codex 原生 gpt-5.6-sol */
  model?: string;
  /** 测试注入用；默认 spawnSync */
  runner?: Runner;
}

export interface AskOptions {
  target: HarnessTarget;
  projectDir: string;
  /** 要发给 harness 的一句话 */
  prompt: string;
  timeoutMs?: number;
  patchFile?: string;
  model?: string;
  runner?: Runner;
}

export interface AskResult {
  ok: boolean;
  answer: string;
  command: string;
  status: number | null;
  stdout: string;
  stderr: string;
  reason?: string;
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

/** Windows 上 harness 都是 .cmd 垫片，必须过 shell；过 shell 就得自己加引号，否则带空格的问题会被拆成多个 argv。 */
function quoteArg(arg: string): string {
  if (!/[\s"]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '\\"') + '"';
}

const DEFAULT_RUNNER: Runner = (command, args, cwd) => {
  const isWin = process.platform === 'win32';
  const [file, argv] = isWin
    ? [command + ' ' + args.map(quoteArg).join(' '), []]
    : [command, args];
  const res = spawnSync(file, argv, {
    cwd,
    encoding: 'utf8',
    timeout: Number(process.env.PACKHUB_PROBE_TIMEOUT ?? 180_000),
    shell: isWin,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
};

const SKILL_QUESTION =
  '只做一件事：列出你当前可用的 skill 名称，一行一个；不要解释，没有就只回答「没有」。';

export interface SkillProbeOptions {
  target: HarnessTarget;
  projectDir: string;
  /** 期望出现在选择器里的 skill 名 */
  skill: string;
  model?: string;
  runner?: Runner;
}

/**
 * 技能选择器探活：问一次 headless 宿主「你能用哪些 skill」。
 * AGENTS 探针证明宿主读了指令；这个探针证明 skill 目录真的被加载进了选择器。
 */
export function probeSkill(opts: SkillProbeOptions): ProbeResult {
  const asked = askHarness({
    target: opts.target,
    projectDir: opts.projectDir,
    prompt: SKILL_QUESTION,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.runner ? { runner: opts.runner } : {}),
  });
  const base: ProbeResult = {
    ok: false,
    harness: opts.target,
    command: asked.command,
    answer: asked.answer,
    marker: opts.skill,
  };
  if (!asked.ok) return { ...base, ...(asked.reason ? { reason: asked.reason } : {}) };
  const ok = asked.answer.includes(opts.skill);
  return {
    ...base,
    ok,
    ...(ok
      ? {}
      : { reason: `回答里没有 skill「${opts.skill}」——宿主没把技能目录加载进选择器` }),
  };
}

/** 跑一次 harness headless 并把最终回答取出来；probe 与 scenario 共用。 */
export function askHarness(opts: AskOptions): AskResult {
  const runner = opts.runner ?? DEFAULT_RUNNER;
  const model =
    opts.model ??
    (opts.target === 'codex' ? 'gpt-5.6-sol' : 'opencode-go/deepseek-v4.1-flash');
  const prompt = opts.prompt;
  const command =
    opts.target === 'dsh'
      ? `${DSH_PROBE_COMMAND} ${DSH_PROFILE_FLAG} ${DSH_PROBE_PROFILE}${opts.patchFile ? ` ${DSH_PATCH_FLAG} ${opts.patchFile}` : ''} ${DSH_JSON_FLAG} "<prompt>"`
      : opts.target === 'opencode'
        ? `opencode run --model ${model} "<prompt>"`
        : opts.target === 'codex'
          ? `codex exec --skip-git-repo-check --sandbox read-only -m ${model} "<prompt>"`
          : 'claude -p "<prompt>" --max-budget-usd 0.05 --no-session-persistence';

  const res =
    opts.target === 'dsh'
      ? runner(
          DSH_PROBE_COMMAND,
          [
            DSH_PROFILE_FLAG,
            DSH_PROBE_PROFILE,
            ...(opts.patchFile ? [DSH_PATCH_FLAG, opts.patchFile] : []),
            DSH_JSON_FLAG,
            prompt,
          ],
          opts.projectDir,
        )
      : opts.target === 'opencode'
        ? runner('opencode', ['run', '--model', model, prompt], opts.projectDir)
        : opts.target === 'codex'
          ? runner(
              'codex',
              ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', model, prompt],
              opts.projectDir,
            )
          : runner(
              'claude',
              ['-p', prompt, '--max-budget-usd', '0.05', '--no-session-persistence'],
              opts.projectDir,
            );

  const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
  const answer =
    opts.target === 'dsh'
      ? parseDshFinal(res.stdout)
      : stripAnsi(res.stdout).trim();
  const combined = `${res.stdout}\n${res.stderr}`;
  const base = {
    answer,
    command,
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
  if (/MISSING_CREDENTIAL|no API key/i.test(combined)) {
    return {
      ...base,
      ok: false,
      reason: '缺少凭证：headless 需要环境变量 DEEPSEEK_API_KEY（桌面应用里存的那份读不到）',
    };
  }
  if (/Not logged in/i.test(combined)) {
    return { ...base, ok: false, reason: 'Claude Code 未登录：先跑 claude 并 /login' };
  }
  if (res.status !== 0) {
    return {
      ...base,
      ok: false,
      reason: `命令退出码 ${res.status}：${res.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? ''}`,
    };
  }
  return { ...base, ok: true };
}

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

  const asked = askHarness({
    target: opts.target,
    projectDir: opts.projectDir,
    prompt: QUESTION,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.patchFile ? { patchFile: opts.patchFile } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.runner ? { runner: opts.runner } : {}),
  });
  if (!asked.ok) {
    return {
      ...base,
      marker,
      command: asked.command,
      answer: asked.answer,
      ...(asked.reason ? { reason: asked.reason } : {}),
    };
  }
  const ok = asked.answer.includes(marker);
  return {
    ok,
    harness: opts.target,
    command: asked.command,
    answer: asked.answer,
    marker,
    ...(ok ? {} : { reason: '回答里没有出现托管块的标记——harness 没把这份指令读进上下文' }),
  };
}
