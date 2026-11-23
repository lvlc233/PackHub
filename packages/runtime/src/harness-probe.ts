// 真机探针：调宿主的 headless 入口问一句话。
//
// 本文件只留通用部分（找指令文件、问题文案、跑一次、判回答）；每个宿主「怎么跑」是
// kernel 注册表里的 ProbeRecipe（命令、参数、命令行预览、stdout 解析、凭证提示），
// 这里查表执行，不再按宿主分叉。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PACKHUB_ENV,
  harness,
  harnessIds,
  instructionFileFor,
  isHarnessId,
  quoteArg,
  type HarnessId,
} from '@packhub/kernel';

/** 探针对一个不认识的名字的统一回绝：列出注册表里可选的宿主，不静默当别的东西跑。 */
function unknownHarnessReason(target: unknown): string {
  return `未知宿主：${String(target)}（可选 ${harnessIds().join(' / ')}；探针只认可安装的宿主）`;
}

export interface RunnerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (
  command: string,
  args: string[],
  cwd: string,
  opts?: { timeoutMs?: number },
) => RunnerResult;

export interface ProbeOptions {
  target: HarnessId;
  projectDir: string;
  timeoutMs?: number;
  /** dsh 用的额外 patch 层（配置 provider 等），可省 */
  patchFile?: string;
  /** 调用方指定的模型；只有配方里带 -m 的宿主会用到 */
  model?: string;
  /** 测试注入用；默认 spawnSync */
  runner?: Runner;
}

export interface AskOptions {
  target: HarnessId;
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
  harness: HarnessId;
  /** 实际执行的命令（给用户看） */
  command: string;
  /** agent 的最终回答 */
  answer: string;
  /** 期望在回答里出现的标记 */
  marker: string | null;
  reason?: string;
}

const DEFAULT_RUNNER: Runner = (command, args, cwd, opts = {}) => {
  const isWin = process.platform === 'win32';
  const [file, argv] = isWin
    ? [command + ' ' + args.map(quoteArg).join(' '), []]
    : [command, args];
  const res = spawnSync(file, argv, {
    cwd,
    encoding: 'utf8',
    // 显式注入优先；没给才看环境变量与默认值
    timeout: opts.timeoutMs ?? Number(process.env[PACKHUB_ENV.probeTimeout] ?? 180_000),
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
  target: HarnessId;
  projectDir: string;
  /** 期望出现在选择器里的 skill 名 */
  skill: string;
  /** 跑一次 harness 的超时（毫秒）；不写就用默认值 */
  timeoutMs?: number;
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
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
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
  const spec = harness(opts.target);
  // 类型上是字符串（注册表运行期决定），清单里来的值也要能回绝
  if (!spec) {
    return {
      ok: false,
      answer: '',
      command: '',
      status: null,
      stdout: '',
      stderr: '',
      reason: unknownHarnessReason(opts.target),
    };
  }
  const recipe = spec.probe;
  const runner = opts.runner ?? DEFAULT_RUNNER;
  // 模型默认值优先用配方自己的（如 opencode 的免费档），再退回运行器的全局默认（codex 用它）
  const model = opts.model ?? recipe.defaultModel ?? 'gpt-5.6-sol';
  const invocation = {
    prompt: opts.prompt,
    model,
    ...(opts.patchFile ? { patchFile: opts.patchFile } : {}),
  };
  const command = recipe.preview(invocation);
  const argv = recipe.args(invocation);
  // timeoutMs 真的生效：显式注入的毫秒数交给 runner（默认 runner 用它设 spawnSync.timeout）
  const runOpts = opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined;
  const res = runner(recipe.executable, argv, opts.projectDir, runOpts);

  const answer = recipe.answer(res.stdout);
  const combined = `${res.stdout}\n${res.stderr}`;
  const base = {
    answer,
    command,
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
  // 凭证/未登录提示由宿主的配方给：命中就换成人话，不再往下判
  const hint = recipe.hints?.find((h) => h.test.test(combined));
  if (hint) return { ...base, ok: false, reason: hint.reason };
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

/**
 * 真机探针：调用目标 harness 的 headless 入口问一句，看它的回答里有没有包写进去的标记。
 * 声明式检查做不到这件事——只有真跑一次才知道 harness 有没有读。
 */
export function probeHarness(opts: ProbeOptions): ProbeResult {
  const base: ProbeResult = {
    ok: false,
    harness: opts.target,
    command: '',
    answer: '',
    marker: null,
  };
  // 探针只认可注册表里的宿主；不认识的名字直接回绝，不去猜指令文件
  if (!isHarnessId(opts.target)) {
    return { ...base, reason: unknownHarnessReason(opts.target) };
  }
  // 指令文件名是宿主静态知识，从注册表取
  const instructionFile = instructionFileFor(opts.target);
  const file = join(opts.projectDir, instructionFile);

  if (!existsSync(file)) {
    return {
      ...base,
      reason: `${instructionFile} 不存在——先用 pal install --harness ${opts.target} 装进目录`,
    };
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
