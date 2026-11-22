// 宿主（harness）的单一描述表。
//
// 一个宿主要回答的问题全在一行里：资源落到哪（layout 差量）、实例 home 与环境变量、
// 可执行名与版本参数、要剥离的凭据文件、项目指令文件名、能不能由 PAL 起（启动模板或原因）。
// `HARNESS_IDS` / `HarnessId` / `LAYOUT_VARS` 都从这张表派生；加宿主 = 表里加一行，
// 落点表、launcher 适配器、探针都会跟着出现，缺字段在编译期报错。
//
// 这里只有静态知识，没有行为：探针怎么拼命令、PAL 怎么起进程都留在各自的包里。

import type { LayoutVars } from './layout.ts';

/** 启动时能拿到的上下文，交给启动模板拼参数。PAL 起实例时构造它。 */
export interface StartContext {
  /** 本次分配的端口；宿主必须监听它 */
  port: number;
  /** 实例根 */
  root: string;
  /** 实例自己的 home 段（没有 home 的宿主为 undefined） */
  home?: string;
  /** 额外补丁文件（dsh 这类宿主的 MCP 接线） */
  patchFile?: string;
}

/** 启动模板：命令 + 参数拼法 + 从输出里认地址的正则。 */
export interface StartTemplate {
  /** 可执行文件名（走 PATH 发现，或 PAL_<HARNESS>_BIN 覆盖） */
  command: string;
  /** 由上下文拼参数；不经过 shell */
  args(ctx: StartContext): string[];
  /** 从启动输出里认地址 */
  url: RegExp;
  /** 等地址的默认超时 */
  readyTimeoutMs?: number;
}

/**
 * 一个宿主的全部静态知识。
 *
 * 表键就是宿主 id（`HARNESSES` 的 `id` 字段与键由 `satisfies` 卡住一致）；
 * `layout` 只写与平铺目录不同的差量，其余字段没有就表示这个宿主没有那一项。
 */
export interface HarnessDescriptor {
  label: string;
  /** 相对平铺落点表的差量（skillsDir / configFile / instructionFile 之类） */
  layout: Partial<LayoutVars>;
  /** 实例内的 home 目录（相对实例根）与把它指过去的环境变量；没有 home 段的宿主不写 */
  home?: { dir: string; env: string };
  /** 宿主可执行文件名 */
  executable?: string;
  /** 探测版本用的参数 */
  versionArgs?: string[];
  /**
   * 宿主自己的凭据文件（相对 home 的文件名，可含子路径）。
   * 只用于备份/归档时剥离，不是安装落点：PAL 不往这些位置写东西。
   */
  credentialFiles?: string[];
  /** 宿主的项目指令文件名（判「包写进去的块在哪」，探针读它） */
  instructionFile: string;
  /** 启动时带的 profile 名（宿主能力的一部分）；没有就不带 --profile */
  startProfile?: string;
  /** 启动模板；没有就说明这个宿主没有可托管的常驻服务 */
  start?: StartTemplate;
  /** 不能启动时给用户看的原因（能力说明，不是错误码） */
  noStartReason?: string;
}

/** dsh 的 web profile 名：启动模板与 profile 字段共用一份，不写两个字符串。 */
const DSH_WEB_PROFILE = 'web';

/** 建一行表项并卡住「id 必须等于表键」。 */
function entry<K extends string>(
  id: K,
  descriptor: HarnessDescriptor,
): HarnessDescriptor & { readonly id: K } {
  return { id, ...descriptor };
}

const TABLE = {
  dsh: entry('dsh', {
    label: 'DeepSeek Harness',
    // DSH 的 skills 与 MCP 目前挂在 profile（全局），项目级只做「指路」
    layout: { instructionFile: 'AGENTS.md' },
    home: { dir: 'home/dsh', env: 'DSH_HOME' },
    executable: 'dsh',
    versionArgs: ['--version'],
    credentialFiles: ['.credentials.yaml', 'auth.json'],
    instructionFile: 'AGENTS.md',
    startProfile: DSH_WEB_PROFILE,
    start: {
      command: 'dsh',
      // --profile 与 --patch 必须在子命令之前：之后会被当成 web app 自己的参数
      args: (ctx) => [
        '--profile',
        DSH_WEB_PROFILE,
        ...(ctx.patchFile ? ['--patch', ctx.patchFile] : []),
        '--no-open',
        '--port',
        String(ctx.port),
      ],
      url: /(https?:\/\/\S+)/,
      readyTimeoutMs: 30_000,
    },
  }),
  'claude-code': entry('claude-code', {
    label: 'Claude Code',
    layout: {
      skillsDir: '.claude/skills',
      configFile: '.mcp.json',
      instructionFile: 'CLAUDE.md',
    },
    home: { dir: 'home/claude', env: 'CLAUDE_CONFIG_DIR' },
    executable: 'claude',
    versionArgs: ['--version'],
    credentialFiles: ['auth.json', '.credentials.json'],
    instructionFile: 'CLAUDE.md',
    noStartReason:
      'Claude Code 是终端交互程序，没有可托管的常驻服务；PAL 只负责给它装配 home（技能、MCP、指令）。',
  }),
  codex: entry('codex', {
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
    noStartReason: 'Codex 是终端交互程序，没有可托管的常驻服务；PAL 只负责给它装配 home。',
  }),
} satisfies Record<string, HarnessDescriptor & { readonly id: string }>;

/** 宿主名单的唯一来源：表键。不写宿主 = 平铺目录，它不是宿主。 */
export type HarnessId = keyof typeof TABLE;

/** 宿主描述表：键就是 id；落点表、launcher 适配器、探针都从这里取。 */
export const HARNESSES: { readonly [K in HarnessId]: HarnessDescriptor & { readonly id: K } } = TABLE;

/** 宿主名单（按表里的声明顺序）；CLI 帮助、错误信息、面板都从它取。 */
export const HARNESS_IDS = Object.keys(HARNESSES) as HarnessId[];

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value);
}
