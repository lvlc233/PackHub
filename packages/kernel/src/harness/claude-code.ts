// claude-code 的宿主描述与探针配方。
//
// 落点：项目里技能在 `.claude/skills`、MCP 在 `.mcp.json`、指令在 `CLAUDE.md`；managed 范围把
// 技能 / 知识 / 提示词落进实例 home，MCP 与指令仍在安装根上（与改造前一致：claude 没有全局落点覆盖）。

import { destinationsOf } from '../destinations.ts';
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

/** 探针输出可能带 ANSI 颜色码，取最终回答前先剥掉。 */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

registerHarness({
  id: 'claude-code',
  label: 'Claude Code',
  destination: (kind, ctx) => {
    if (ctx.scope === 'attached') {
      throw new Error('宿主 claude-code 没有 attached 落点：launcher 应在写盘前拒绝');
    }
    return ctx.scope === 'project' ? PROJECT(kind) : HOME(kind);
  },
  home: { dir: HOME_DIR, env: 'CLAUDE_CONFIG_DIR' },
  executable: 'claude',
  versionArgs: ['--version'],
  credentialFiles: ['auth.json', '.credentials.json'],
  start: {
    mode: 'foreground',
    command: 'claude',
    args: () => [],
    url: /^$/,
  },
  probe: {
    executable: 'claude',
    args: (ctx) => ['-p', ctx.prompt, '--max-budget-usd', '0.05', '--no-session-persistence'],
    preview: () => 'claude -p "<prompt>" --max-budget-usd 0.05 --no-session-persistence',
    answer: (stdout) => stripAnsi(stdout).trim(),
    hints: [{ test: /Not logged in/i, reason: 'Claude Code 未登录：先跑 claude 并 /login' }],
  },
});
