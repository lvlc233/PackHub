// claude-code 的宿主描述与探针配方。

import { registerHarness } from './contract.ts';

/** 探针输出可能带 ANSI 颜色码，取最终回答前先剥掉。 */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

registerHarness({
  id: 'claude-code',
  label: 'Claude Code',
  layout: {
    skillsDir: '.claude/skills',
    configFile: '.mcp.json',
    instructionFile: 'CLAUDE.md',
  },
  home: { dir: 'home/claude', env: 'CLAUDE_CONFIG_DIR' },
  executable: 'claude',
  versionArgs: ['--version'],
  credentialFiles: ['auth.json', '.credentials.json'],
  instructionFile: 'CLAUDE.md',
  noStartReason:
    'Claude Code 是终端交互程序，没有可托管的常驻服务；PAL 只负责给它装配 home（技能、MCP、指令）。',
  probe: {
    executable: 'claude',
    args: (ctx) => ['-p', ctx.prompt, '--max-budget-usd', '0.05', '--no-session-persistence'],
    preview: () => 'claude -p "<prompt>" --max-budget-usd 0.05 --no-session-persistence',
    answer: (stdout) => stripAnsi(stdout).trim(),
    hints: [{ test: /Not logged in/i, reason: 'Claude Code 未登录：先跑 claude 并 /login' }],
  },
});
