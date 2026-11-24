// claude-code 的宿主描述与探针配方。
//
// 落点：项目里技能在 `.claude/skills`、MCP 在 `.mcp.json`、指令在 `CLAUDE.md`；managed 范围把
// 技能 / 知识 / 提示词落进实例 home，MCP 与指令仍在安装根上。
//
// attached（真实的 `~/.claude`）：技能 / 知识 / 提示词 / 指令都相对 home；MCP 的全局配置是
// home 旁边的 `~/.claude.json`，不在 home 里——用绝对路径声明（base: absolute），
// 由 state 记录所有权、卸载按 key 摘除、安装前快照、rollback 恢复。

import { dirname, join } from 'node:path';
import { destinationsOf } from '../destinations.ts';
import type { Destination } from './contract.ts';
import { registerHarness } from './contract.ts';

/** 实例里的 home 段（相对实例根）；`home.dir` 与落点共用这一份。 */
const HOME_DIR = 'home/claude';

/** 项目：技能、MCP 与指令都在 claude 认的位置。 */
const PROJECT = destinationsOf({ skill: '.claude/skills', mcp: '.mcp.json', instruction: 'CLAUDE.md' });

/** managed：技能 / 知识 / 提示词进实例 home；MCP 与指令仍在安装根上。 */
const HOME = destinationsOf({
  skill: `${HOME_DIR}/skills`,
  knowledge: `${HOME_DIR}/knowledge`,
  prompt: `${HOME_DIR}/prompts`,
  mcp: '.mcp.json',
  instruction: 'CLAUDE.md',
});

/** attached：root 与 home 同值；只有 MCP 配置在 home 旁边（`~/.claude.json`）。 */
const ATTACHED = destinationsOf({
  skill: { path: 'skills', base: 'home' },
  knowledge: { path: 'knowledge', base: 'home' },
  prompt: { path: 'prompts', base: 'home' },
  instruction: { path: 'CLAUDE.md', base: 'home' },
});

/** 绝对路径统一成 /：计划与 state 里看到的写法不随平台分隔符漂移。 */
function posixPath(value: string): string {
  return value.replaceAll('\\', '/');
}

/**
 * claude 的全局 MCP 配置是 `~/.claude.json`：attached home 是 `~/.claude`，配置文件在它的
 * 上一级。用 ctx.home 推导，不猜用户目录；没有 home 段（项目 / 平铺）不会走到这里。
 */
function attachedMcp(ctx: { home?: string }): Destination {
  // 没有 home 段说明调用方用错了范围（项目 / 平铺不会走这里）：给一个相对路径让计划期
  // 的 base 校验报 `bad-destination-base`，不在适配器里抛一个用户读不懂的错。
  if (!ctx.home) return { path: '.claude.json', base: 'absolute' };
  return { path: posixPath(join(dirname(ctx.home), '.claude.json')), base: 'absolute' };
}

/** 探针输出可能带 ANSI 颜色码，取最终回答前先剥掉。 */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

registerHarness({
  id: 'claude-code',
  label: 'Claude Code',
  destination: (kind, ctx) => {
    if (ctx.scope === 'attached') {
      return kind === 'mcp' ? attachedMcp(ctx) : ATTACHED(kind);
    }
    return ctx.scope === 'project' ? PROJECT(kind) : HOME(kind);
  },
  home: { dir: HOME_DIR, env: 'CLAUDE_CONFIG_DIR' },
  // attached home 的全局落点已验证（`pal install --home` 才允许指过来）
  attached: true,
  executable: 'claude',
  versionArgs: ['--version'],
  credentialFiles: ['auth.json', '.credentials.json'],
  modes: [
    {
      id: 'tui',
      label: '终端 TUI',
      kind: 'foreground',
      command: 'claude',
      args: () => [],
    },
  ],
  defaultMode: 'tui',
  probe: {
    executable: 'claude',
    args: (ctx) => ['-p', ctx.prompt, '--max-budget-usd', '0.05', '--no-session-persistence'],
    preview: () => 'claude -p "<prompt>" --max-budget-usd 0.05 --no-session-persistence',
    answer: (stdout) => stripAnsi(stdout).trim(),
    hints: [{ test: /Not logged in/i, reason: 'Claude Code 未登录：先跑 claude 并 /login' }],
  },
});
