// hermes（NousResearch Hermes Agent）的宿主描述与探针配方。
//
// hermes 只有全局目录（`~/.hermes`，Windows `%LOCALAPPDATA%\hermes`，`HERMES_HOME` 可改）：
// 技能在 `<home>/skills`，MCP 在 `<home>/config.yaml` 的 `mcp_servers:`（YAML）。
// 它没有项目级安装落点，所以 `project: false`——装进项目会被拒绝，要装就用实例。

import { registerHarness } from './contract.ts';

registerHarness({
  id: 'hermes',
  label: 'Hermes Agent',
  layout: {
    // 项目级落点在 hermes 上不成立（project: false）；这里只给平铺/实例用的默认值
    configFile: 'config.yaml',
    instructionFile: 'AGENTS.md',
  },
  home: { dir: 'home/hermes', env: 'HERMES_HOME' },
  instanceLayout: (home) => ({
    skillsDir: `${home}/skills`,
    knowledgeDir: `${home}/knowledge`,
    promptsDir: `${home}/prompts`,
    configFile: `${home}/config.yaml`,
  }),
  executable: 'hermes',
  versionArgs: ['--version'],
  instructionFile: 'AGENTS.md',
  start: {
    mode: 'foreground',
    command: 'hermes',
    args: () => [],
    url: /^$/,
  },
  // 没有项目级落点：pal install --project 会拒绝，改用 pal install --new --kind hermes 建环境
  project: false,
  mcp: {
    path: ['mcp_servers'],
    format: 'yaml',
    // hermes 的条目是 { command, args } / { url }，没有 transport 这种字段
    entry: (spec) => {
      if (typeof spec.url === 'string') return { url: spec.url };
      return {
        ...(spec.command !== undefined ? { command: spec.command } : {}),
        ...(Array.isArray(spec.args) ? { args: spec.args } : {}),
        ...(spec.env && typeof spec.env === 'object' ? { env: spec.env } : {}),
      };
    },
  },
  probe: {
    executable: 'hermes',
    args: (ctx) => ['chat', '-q', ctx.prompt],
    preview: () => 'hermes chat -q "<prompt>"',
    answer: (stdout) => stdout.trim(),
  },
});
