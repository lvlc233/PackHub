// workbody（腾讯 WorkBuddy / CodeBuddy CLI）的宿主描述与探针配方。
//
// 项目里：技能 `.codebuddy/skills/<id>/`、MCP `.mcp.json`（`mcpServers`，与 Claude 同形）、
// 指令 `CODEBUDDY.md`；全局目录 `~/.codebuddy`（`CODEBUDDY_CONFIG_DIR` 可改）。

import { registerHarness } from './contract.ts';

/** 探针输出可能带 ANSI 颜色码，取最终回答前先剥掉。 */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

registerHarness({
  id: 'workbody',
  label: 'WorkBuddy / CodeBuddy',
  layout: {
    skillsDir: '.codebuddy/skills',
    configFile: '.mcp.json',
    instructionFile: 'CODEBUDDY.md',
  },
  home: { dir: 'home/codebuddy', env: 'CODEBUDDY_CONFIG_DIR' },
  instanceLayout: (home) => ({
    skillsDir: `${home}/skills`,
    knowledgeDir: `${home}/knowledge`,
    promptsDir: `${home}/prompts`,
    // 全局 MCP 配置放在 home 里的 mcp.json（与项目 `.mcp.json` 同形）
    configFile: `${home}/mcp.json`,
  }),
  // attached home = 真实的 `~/.codebuddy`；根就是 home，落点相对它。
  attachedLayout: () => ({
    skillsDir: 'skills',
    knowledgeDir: 'knowledge',
    promptsDir: 'prompts',
    configFile: 'mcp.json',
  }),
  executable: 'codebuddy',
  versionArgs: ['--version'],
  instructionFile: 'CODEBUDDY.md',
  start: {
    mode: 'foreground',
    command: 'codebuddy',
    args: () => [],
    url: /^$/,
  },
  // MCP 用默认方言：JSON + mcpServers.<name>
  probe: {
    executable: 'codebuddy',
    args: (ctx) => ['-p', ctx.prompt],
    preview: () => 'codebuddy -p "<prompt>"',
    answer: (stdout) => stripAnsi(stdout).trim(),
  },
});
