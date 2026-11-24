// hermes（NousResearch Hermes Agent）的宿主描述与探针配方。
//
// hermes 只有全局目录（`~/.hermes`，Windows `%LOCALAPPDATA%\hermes`，`HERMES_HOME` 可改）：
// 技能在 `<home>/skills`，MCP 在 `<home>/config.yaml` 的 `mcp_servers:`（YAML）。
// 它没有项目级安装落点，所以 `project: false`——装进项目会被拒绝，要装就装进 home。
//
// 落点分两种范围：managed（全部进实例 home 段）与 attached（真实 `~/.hermes`，落点相对它）。
// 项目范围只留一句「配置与指令在哪」的回答：launcher 在写盘前就拒绝项目安装。

import { destinationsOf } from '../destinations.ts';
import { registerHarness, type McpDialect } from './contract.ts';

/** 实例里的 home 段（相对实例根）；`home.dir` 与落点共用这一份。 */
const HOME_DIR = 'home/hermes';

/** hermes 的 MCP 方言：YAML 的 `mcp_servers`，条目是 {command,args} / {url}。 */
const MCP: McpDialect = {
  path: ['mcp_servers'],
  format: 'yaml',
  entry: (spec) => {
    if (typeof spec.url === 'string') return { url: spec.url };
    return {
      ...(spec.command !== undefined ? { command: spec.command } : {}),
      ...(Array.isArray(spec.args) ? { args: spec.args } : {}),
      ...(spec.env && typeof spec.env === 'object' ? { env: spec.env } : {}),
    };
  },
};

/** 项目范围（不可用，launcher 拒绝）：配置与指令仍按名字回答，其余落在 `.packhub`。 */
const PROJECT = destinationsOf({ mcp: 'config.yaml', instruction: 'AGENTS.md' }, MCP);

/** managed：全部落进实例 home 段。 */
const HOME = destinationsOf(
  {
    skill: `${HOME_DIR}/skills`,
    knowledge: `${HOME_DIR}/knowledge`,
    prompt: `${HOME_DIR}/prompts`,
    mcp: `${HOME_DIR}/config.yaml`,
    instruction: `${HOME_DIR}/AGENTS.md`,
  },
  MCP,
);

/** attached home = 真实的 `~/.hermes`：根就是 home，落点相对它。 */
const ATTACHED = destinationsOf(
  { skill: 'skills', knowledge: 'knowledge', prompt: 'prompts', mcp: 'config.yaml', instruction: 'AGENTS.md' },
  MCP,
);

registerHarness({
  id: 'hermes',
  label: 'Hermes Agent',
  destination: (kind, ctx) =>
    ctx.scope === 'attached' ? ATTACHED(kind) : ctx.scope === 'home' ? HOME(kind) : PROJECT(kind),
  home: { dir: HOME_DIR, env: 'HERMES_HOME' },
  // attached home 的全局落点已验证（`pal install --home` 才允许指过来）
  attached: true,
  executable: 'hermes',
  versionArgs: ['--version'],
  modes: [
    {
      id: 'tui',
      label: '终端 TUI',
      kind: 'foreground',
      command: 'hermes',
      args: () => [],
    },
  ],
  defaultMode: 'tui',
  // 没有项目级落点：pal install --project 会拒绝，改用默认命名 home 或 --home
  project: false,
  probe: {
    executable: 'hermes',
    args: (ctx) => ['chat', '-q', ctx.prompt],
    preview: () => 'hermes chat -q "<prompt>"',
    answer: (stdout) => stdout.trim(),
  },
});
