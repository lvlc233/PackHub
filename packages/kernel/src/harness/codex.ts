// codex 的宿主描述与探针配方。

import { registerHarness } from './contract.ts';

/** 探针输出可能带 ANSI 颜色码，取最终回答前先剥掉。 */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

registerHarness({
  id: 'codex',
  label: 'Codex',
  layout: {
    skillsDir: '.codex/skills',
    instructionFile: 'AGENTS.md',
  },
  home: { dir: 'home/codex', env: 'CODEX_HOME' },
  executable: 'codex',
  versionArgs: ['--version'],
  credentialFiles: ['auth.json'],
  instructionFile: 'AGENTS.md',
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
