// opencode 的宿主描述与探针配方。
//
// 全局目录走 XDG：配置在 `$XDG_CONFIG_HOME/opencode/opencode.json`，技能在
// `$XDG_CONFIG_HOME/opencode/skills`；项目里是 `.opencode/skills` + 根目录 `opencode.json`。
// MCP 的键名与形状都与 Claude 不同：`mcp.servers.<name>`，本地条目是 `{type:"local",command:[...]}`。

import { registerHarness } from './contract.ts';

/** 探针输出可能带 ANSI 颜色码，取最终回答前先剥掉。 */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

registerHarness({
  id: 'opencode',
  label: 'opencode',
  layout: {
    skillsDir: '.opencode/skills',
    configFile: 'opencode.json',
    instructionFile: 'AGENTS.md',
  },
  // XDG_CONFIG_HOME 指到实例 home；opencode 自己会再拼一层 `opencode/`
  home: { dir: 'home/opencode', env: 'XDG_CONFIG_HOME' },
  instanceLayout: (home) => ({
    skillsDir: `${home}/opencode/skills`,
    knowledgeDir: `${home}/opencode/knowledge`,
    promptsDir: `${home}/opencode/prompts`,
    configFile: `${home}/opencode/opencode.json`,
  }),
  // attached home = 真实的 `~/.config/opencode`（`--home ~/.config/opencode`）。
  // 根就是 home 本身，所以落点相对 home：skills → `<home>/skills`，MCP → `<home>/opencode.json`。
  attachedLayout: () => ({
    skillsDir: 'skills',
    knowledgeDir: 'knowledge',
    promptsDir: 'prompts',
    configFile: 'opencode.json',
  }),
  executable: 'opencode',
  versionArgs: ['--version'],
  instructionFile: 'AGENTS.md',
  start: {
    mode: 'foreground',
    command: 'opencode',
    args: () => [],
    url: /^$/,
  },
  mcp: {
    path: ['mcp', 'servers'],
    // opencode 的条目形状：本地 { type:"local", command:[exe,...args] }，远程 { type:"remote", url }
    entry: (spec) => {
      if (typeof spec.url === 'string') return { type: 'remote', url: spec.url };
      const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
      const command = [String(spec.command ?? ''), ...args].filter((part, i) => i > 0 || part.length > 0);
      return {
        type: 'local',
        command,
        ...(spec.env && typeof spec.env === 'object' ? { environment: spec.env } : {}),
      };
    },
  },
  probe: {
    executable: 'opencode',
    defaultModel: 'opencode-go/deepseek-v4.1-flash',
    args: (ctx) => ['run', '--model', ctx.model, ctx.prompt],
    preview: (ctx) => `opencode run --model ${ctx.model} "<prompt>"`,
    answer: (stdout) => stripAnsi(stdout).trim(),
  },
});
