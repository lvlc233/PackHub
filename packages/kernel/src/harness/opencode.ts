// opencode 的宿主描述与探针配方。
//
// 全局目录走 XDG：配置在 `$XDG_CONFIG_HOME/opencode/opencode.json`，技能在
// `$XDG_CONFIG_HOME/opencode/skills`；项目里是 `.opencode/skills` + 根目录 `opencode.json`。
// MCP 的键名与形状都与 Claude 不同：`mcp.servers.<name>`，本地条目是 `{type:"local",command:[...]}`。
//
// 落点分三种范围：项目（`.opencode/...`）、managed（XDG 多一层 `opencode/`）、attached（真实
// `~/.config/opencode`，落点相对那个目录：`skills` / `knowledge` / `prompts` / `opencode.json`）。

import { destinationsOf } from '../destinations.ts';
import { registerHarness, type McpDialect } from './contract.ts';

/** 实例里的 home 段（相对实例根）；`home.dir` 与落点共用这一份。 */
const HOME_DIR = 'home/opencode';

/** 探针输出可能带 ANSI 颜色码，取最终回答前先剥掉。 */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

/** opencode 的 MCP 方言：`mcp.servers`，本地条目 {type:'local',command:[...]}，远程 {type:'remote',url}。 */
const MCP: McpDialect = {
  path: ['mcp', 'servers'],
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
};

/** 项目：技能与 MCP 在项目根，其余落在 `.packhub`。 */
const PROJECT = destinationsOf(
  { skill: '.opencode/skills', mcp: 'opencode.json', instruction: 'AGENTS.md' },
  MCP,
);

/**
 * managed：XDG_CONFIG_HOME 指到实例 home，opencode 自己再拼一层 `opencode/`——
 * 所以实例里要多一层，MCP 也跟着进 home。
 */
const HOME = destinationsOf(
  {
    skill: `${HOME_DIR}/opencode/skills`,
    knowledge: `${HOME_DIR}/opencode/knowledge`,
    prompt: `${HOME_DIR}/opencode/prompts`,
    mcp: `${HOME_DIR}/opencode/opencode.json`,
    instruction: 'AGENTS.md',
  },
  MCP,
);

/** attached home = 真实的 `~/.config/opencode`：根就是 home，落点相对它。 */
const ATTACHED = destinationsOf(
  { skill: 'skills', knowledge: 'knowledge', prompt: 'prompts', mcp: 'opencode.json', instruction: 'AGENTS.md' },
  MCP,
);

registerHarness({
  id: 'opencode',
  label: 'opencode',
  destination: (kind, ctx) =>
    ctx.scope === 'attached' ? ATTACHED(kind) : ctx.scope === 'home' ? HOME(kind) : PROJECT(kind),
  // XDG_CONFIG_HOME 指到实例 home；opencode 自己会再拼一层 `opencode/`
  home: { dir: HOME_DIR, env: 'XDG_CONFIG_HOME' },
  // attached home 的全局落点已验证（`pal install --home` 才允许指过来）
  attached: true,
  executable: 'opencode',
  versionArgs: ['--version'],
  modes: [
    {
      id: 'tui',
      label: '终端 TUI',
      kind: 'foreground',
      command: 'opencode',
      args: () => [],
    },
    {
      id: 'web',
      label: '网页（本地 serve）',
      kind: 'server',
      command: 'opencode',
      args: (ctx) => ['serve', '--port', String(ctx.port), '--hostname', '127.0.0.1'],
      url: /(https?:\/\/\S+)/,
      readyTimeoutMs: 30_000,
    },
  ],
  defaultMode: 'tui',
  probe: {
    executable: 'opencode',
    defaultModel: 'opencode-go/deepseek-v4.1-flash',
    args: (ctx) => ['run', '--model', ctx.model, ctx.prompt],
    preview: (ctx) => `opencode run --model ${ctx.model} "<prompt>"`,
    answer: (stdout) => stripAnsi(stdout).trim(),
  },
});
