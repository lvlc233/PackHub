import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TargetId } from '@packhub/kernel';

/**
 * 一个 harness 的全局同步落点与能力。加一个宿主 = 在这里加一条
 * （外加 kernel 里对应的安装 target）；CLI / HTTP / 面板都从这张表读，不再各自维护名单。
 */
export interface HarnessSpec {
  /** 同步 target 名，也是 `--to` 的取值 */
  id: string;
  label: string;
  /** 生成安装计划用的 target */
  planTarget: TargetId;
  /** home 的环境变量名 */
  homeEnv: string;
  /** 默认 home（相对用户目录） */
  homeDir: string;
  /** skills 落点（相对 home） */
  skillsDir: string;
  /** 指令文件名 */
  instructionFile: string;
  /**
   * MCP 的全局落点能力：
   * - `none`：还没有可依赖的全局 MCP 契约，只同步 skills；
   * - `toml`：写 `<home>/config.toml` 的托管块；
   * - `claude-cli`：交给宿主 CLI（`claude mcp add/remove --scope user`）。
   * 新增 `toml` 之外的宿主 CLI 形态，要在这里加模式并补 adapter。
   */
  mcp: 'none' | 'toml' | 'claude-cli';
  /** mcp=none 时给用户的说明 */
  mcpReason?: string;
}

export const HARNESSES = [
  {
    id: 'dsh',
    label: 'DSH',
    planTarget: 'dsh',
    homeEnv: 'PACKHUB_DSH_HOME',
    homeDir: '.dsh',
    skillsDir: 'skills',
    instructionFile: 'AGENTS.md',
    mcp: 'none',
    mcpReason: '没有可依赖的全局 MCP 配置契约（profile patch 是 DSH 私有的）',
  },
  {
    id: 'codex',
    label: 'Codex',
    planTarget: 'codex',
    homeEnv: 'PACKHUB_CODEX_HOME',
    homeDir: '.codex',
    skillsDir: 'skills',
    instructionFile: 'AGENTS.md',
    mcp: 'toml',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    planTarget: 'claude-code',
    homeEnv: 'PACKHUB_CLAUDE_HOME',
    homeDir: '.claude',
    skillsDir: 'skills',
    instructionFile: 'CLAUDE.md',
    mcp: 'claude-cli',
  },
] as const satisfies readonly HarnessSpec[];

export type SyncTarget = (typeof HARNESSES)[number]['id'];

/** 已注册的同步目标，按表顺序。 */
export function syncTargets(): SyncTarget[] {
  return HARNESSES.map((harness) => harness.id);
}

export function isSyncTarget(value: string): value is SyncTarget {
  return HARNESSES.some((harness) => harness.id === value);
}

/** 按 id 取表项；未知时给可选项。 */
export function harnessSpec(target: string): HarnessSpec {
  const spec = HARNESSES.find((harness) => harness.id === target) as HarnessSpec | undefined;
  if (!spec) {
    throw new Error(`未知 harness：${target}（已注册：${syncTargets().join(', ')}）`);
  }
  return spec;
}

/**
 * 解析 `--to`：逗号分隔的 id，或 `.` / `all`。
 * `.` 优先按包声明的 targets 展开（只取已注册的），包没声明时用全部已注册目标。
 */
export function resolveSyncTargets(raw: string, declared: readonly string[] = []): SyncTarget[] {
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error(`至少选一个 target：${syncTargets().join(', ')}，或 .（全部）`);
  }
  const out: SyncTarget[] = [];
  const add = (target: SyncTarget): void => {
    if (!out.includes(target)) out.push(target);
  };
  for (const item of items) {
    if (item === '.' || item === 'all') {
      const pool = (declared.length > 0 ? declared : syncTargets()).filter(isSyncTarget);
      if (pool.length === 0) {
        throw new Error(`这个包没有声明可同步的 target（已注册：${syncTargets().join(', ')}）`);
      }
      for (const target of pool) add(target);
      continue;
    }
    if (!isSyncTarget(item)) {
      throw new Error(`未知 target：${item}（可选：${syncTargets().join(', ')}，或 .）`);
    }
    add(item);
  }
  return out;
}

/** 全局 harness 的落点：优先环境变量，测试与多环境都靠它隔离。 */
export function harnessRoot(target: SyncTarget): string {
  const spec = harnessSpec(target);
  const env = process.env[spec.homeEnv];
  if (env) return resolve(env);
  return join(homedir(), spec.homeDir);
}

export function assertHarnessRoot(target: SyncTarget, root: string): void {
  const spec = harnessSpec(target);
  if (!existsSync(root)) {
    throw new Error(`${target} 的 home 不存在：${root}（先安装 ${spec.label}，或设 ${spec.homeEnv}）`);
  }
  if (!statSync(root).isDirectory()) throw new Error(`${target} 的 home 不是目录：${root}`);
}
