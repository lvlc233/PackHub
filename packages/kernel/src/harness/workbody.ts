// workbody（腾讯 WorkBuddy / CodeBuddy CLI）的宿主描述与探针配方。
//
// 项目里：技能 `.codebuddy/skills/<id>/`、MCP `.mcp.json`（`mcpServers`，与 Claude 同形）、
// 指令 `CODEBUDDY.md`；全局目录 `~/.codebuddy`（`CODEBUDDY_CONFIG_DIR` 可改）。
//
// 落点分三种范围：项目、managed（技能 / 知识 / 提示词进实例 home，MCP 是 `<home>/mcp.json`）、
// attached（真实 `~/.codebuddy`，落点相对它：`skills` / `mcp.json`）。

import { destinationsOf } from '../destinations.ts';
import { registerHarness } from './contract.ts';

/** 实例里的 home 段（相对实例根）；`home.dir` 与落点共用这一份。 */
const HOME_DIR = 'home/codebuddy';

/** 探针输出可能带 ANSI 颜色码，取最终回答前先剥掉。 */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

/** 项目：技能在 `.codebuddy/skills`，MCP 是 `.mcp.json`（默认方言：JSON `mcpServers`）。 */
const PROJECT = destinationsOf({
  skill: '.codebuddy/skills',
  mcp: '.mcp.json',
  instruction: 'CODEBUDDY.md',
});

/** managed：技能 / 知识 / 提示词进实例 home；全局 MCP 配置是 home 里的 `mcp.json`（与项目 `.mcp.json` 同形）。 */
const HOME = destinationsOf({
  skill: `${HOME_DIR}/skills`,
  knowledge: `${HOME_DIR}/knowledge`,
  prompt: `${HOME_DIR}/prompts`,
  mcp: `${HOME_DIR}/mcp.json`,
  instruction: 'CODEBUDDY.md',
});

/** attached home = 真实的 `~/.codebuddy`：根就是 home，落点相对它。 */
const ATTACHED = destinationsOf({
  skill: 'skills',
  knowledge: 'knowledge',
  prompt: 'prompts',
  mcp: 'mcp.json',
  instruction: 'CODEBUDDY.md',
});

registerHarness({
  id: 'workbody',
  label: 'WorkBuddy / CodeBuddy',
  destination: (kind, ctx) =>
    ctx.scope === 'attached' ? ATTACHED(kind) : ctx.scope === 'home' ? HOME(kind) : PROJECT(kind),
  home: { dir: HOME_DIR, env: 'CODEBUDDY_CONFIG_DIR' },
  // attached home 的全局落点已验证（`pal install --home` 才允许指过来）
  attached: true,
  executable: 'codebuddy',
  versionArgs: ['--version'],
  modes: [
    {
      id: 'tui',
      label: '终端 TUI',
      kind: 'foreground',
      command: 'codebuddy',
      args: () => [],
    },
  ],
  defaultMode: 'tui',
  // MCP 用默认方言：JSON + mcpServers.<name>
  probe: {
    executable: 'codebuddy',
    args: (ctx) => ['-p', ctx.prompt],
    preview: () => 'codebuddy -p "<prompt>"',
    answer: (stdout) => stripAnsi(stdout).trim(),
  },
});
