// codex 的宿主描述与探针配方。
//
// 落点：项目里技能在 `.codex/skills`、指令在 `AGENTS.md`；MCP 方言没改，仍登记在 `.packhub`。
// managed 范围把技能 / 知识 / 提示词落进实例 home，指令仍在安装根上。

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

/** 探针输出可能带 ANSI 颜色码，取最终回答前先剥掉。 */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

registerHarness({
  id: 'codex',
  label: 'Codex',
  destination: (kind, ctx) => (ctx.scope === 'project' ? PROJECT(kind) : HOME(kind)),
  home: { dir: HOME_DIR, env: 'CODEX_HOME' },
  executable: 'codex',
  versionArgs: ['--version'],
  credentialFiles: ['auth.json'],
  start: {
    mode: 'foreground',
    command: 'codex',
    args: () => [],
    url: /^$/,
  },
  probe: {
    executable: 'codex',
    args: (ctx) => ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', ctx.model, ctx.prompt],
    preview: (ctx) => `codex exec --skip-git-repo-check --sandbox read-only -m ${ctx.model} "<prompt>"`,
    answer: (stdout) => stripAnsi(stdout).trim(),
  },
});
