import type { TargetId } from './types.ts';

/**
 * 安装计划用到的落点变量。
 *
 * 这是宿主/物化形态的「目录约定」数据，不是计划逻辑；住在 targets.ts 方便一眼看出
 * 哪个宿主跟默认不一样。新增字段时所有 target 都会编译报错，逼着补全。
 */
export interface TargetVars {
  root: string;
  cacheDir: string;
  skillsDir: string;
  knowledgeDir: string;
  promptsDir: string;
  binDir: string;
  /** config 资源落成的目录：原样放文件，不合并 */
  configDir: string;
  /** MCP 登记的配置文件；只有 MCP 用 */
  configFile: string;
  /** 指令文件名；dir 没有（只物化到 .packhub，不碰宿主指令面） */
  instructionFile?: string;
}

/** 默认约定：物化到 .packhub，不碰宿主的配置文件。 */
const BASE_TARGET_VARS: TargetVars = {
  root: '.packhub',
  cacheDir: '.packhub/cache',
  skillsDir: '.packhub/skills',
  knowledgeDir: '.packhub/knowledge',
  promptsDir: '.packhub/prompts',
  binDir: '.packhub/bin',
  configDir: '.packhub/config',
  configFile: '.packhub/config.json',
};

/** 在默认约定上只写差量：一眼能看出哪个宿主不一样。 */
const withDefaults = (patch: Partial<TargetVars>): TargetVars => ({ ...BASE_TARGET_VARS, ...patch });

export const DIR_TARGET_VARS: TargetVars = withDefaults({});

/** 各宿主的投影落点：从「物化」变成「接进 agent 会读的位置」。 */
export const TARGET_VARS = {
  dir: DIR_TARGET_VARS,
  dsh: withDefaults({
    // DSH 的 skills 与 MCP 目前挂在 profile（全局），项目级只做「指路」
    instructionFile: 'AGENTS.md',
  }),
  'claude-code': withDefaults({
    skillsDir: '.claude/skills',
    configFile: '.mcp.json',
    instructionFile: 'CLAUDE.md',
  }),
  codex: withDefaults({
    skillsDir: '.codex/skills',
    instructionFile: 'AGENTS.md',
  }),
} satisfies Record<TargetId, TargetVars>;
