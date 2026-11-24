// codex 的宿主描述与探针配方。
//
// 落点：项目里技能在 `.codex/skills`、指令在 `AGENTS.md`；MCP 方言没改，仍登记在 `.packhub`。
// managed 范围把技能 / 知识 / 提示词落进实例 home，指令仍在安装根上。
//
// attached（真实的 `~/.codex`）：技能 / 知识 / 提示词 / 指令都在 home 里；MCP 是
// `<home>/config.toml`（TOML 托管块），卸载按 key 摘块。

import { destinationsOf } from '../destinations.ts';
import { registerHarness } from './contract.ts';

/** 实例里的 home 段（相对实例根）；`home.dir` 与落点共用这一份。 */
const HOME_DIR = 'home/codex';

/** 项目：技能在 `.codex/skills`，其余（含 MCP 登记）落在 `.packhub`。 */
const PROJECT = destinationsOf({ skill: '.codex/skills', instruction: 'AGENTS.md' });

/** managed：技能 / 知识 / 提示词进实例 home；MCP 仍登记在 `.packhub`。 */
const HOME = destinationsOf({
  skill: `${HOME_DIR}/skills`,
  knowledge: `${HOME_DIR}/knowledge`,
  prompt: `${HOME_DIR}/prompts`,
  instruction: 'AGENTS.md',
});

/** attached：root 与 home 同值，MCP 是 home 里的 config.toml（TOML 方言由执行器按后缀识别）。 */
const ATTACHED = destinationsOf({
  skill: { path: 'skills', base: 'home' },
  knowledge: { path: 'knowledge', base: 'home' },
  prompt: { path: 'prompts', base: 'home' },
  mcp: { path: 'config.toml', base: 'home' },
  instruction: { path: 'AGENTS.md', base: 'home' },
});

/** 探针输出可能带 ANSI 颜色码，取最终回答前先剥掉。 */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

registerHarness({
  id: 'codex',
  label: 'Codex',
  destination: (kind, ctx) => {
    if (ctx.scope === 'attached') return ATTACHED(kind);
    return ctx.scope === 'project' ? PROJECT(kind) : HOME(kind);
  },
  home: { dir: HOME_DIR, env: 'CODEX_HOME' },
  // attached home 的全局落点已验证（`pal install --home` 才允许指过来）
  attached: true,
  executable: 'codex',
  versionArgs: ['--version'],
  credentialFiles: ['auth.json'],
  modes: [
    {
      id: 'tui',
      label: '终端 TUI',
      kind: 'foreground',
      command: 'codex',
      args: () => [],
    },
    {
      id: 'app',
      label: '桌面 app',
      kind: 'app',
      // 没有可靠的默认安装位置：只能由 PAL_CODEX_APP_BIN 指过去
      app: { env: 'PAL_CODEX_APP_BIN', candidates: () => [] },
    },
  ],
  defaultMode: 'tui',
  probe: {
    executable: 'codex',
    args: (ctx) => ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', ctx.model, ctx.prompt],
    preview: (ctx) => `codex exec --skip-git-repo-check --sandbox read-only -m ${ctx.model} "<prompt>"`,
    answer: (stdout) => stripAnsi(stdout).trim(),
  },
});
