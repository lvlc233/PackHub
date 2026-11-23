// 宿主注册表的契约与实现。
//
// 宿主不再是「编译期联合 + 一张大表」，而是运行期注册表：每个宿主一个模块（harness/<id>.ts），
// 由 harness/index.ts import 一遍完成注册。代价是 `HarnessId` 变成 `string`，
// 换来的是「加宿主 = 新文件 + index 一行 import」，launcher / runtime / 探针都不用动。
//
// 这里只定义形状与查表；每个宿主的静态知识与探针配方在各模块里。

import { DIR_LAYOUT_VARS, layoutVarsWith, type LayoutVars } from '../layout.ts';

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

/** 探针一次调用的输入：提示词、模型（只有需要的宿主用）、可选的 patch 层。 */
export interface ProbeInvocation {
  prompt: string;
  /** 调用方给的模型名；不需要 -m 的宿主直接忽略 */
  model: string;
  patchFile?: string;
}

/** 宿主的 headless 探针配方：命令、参数、给人看的命令行、stdout 解析、凭证/登录提示。 */
export interface ProbeRecipe {
  /** 探针要执行的命令（走 PATH 发现） */
  executable: string;
  /** 真实 argv（不含可执行文件名） */
  args(ctx: ProbeInvocation): string[];
  /** 命令行预览（给人看/写日志）：`<prompt>` 是占位，不展开真实提示词 */
  preview(ctx: ProbeInvocation): string;
  /** 从 stdout 取最终回答 */
  answer(stdout: string): string;
  /** 调用方没给 model 时用哪个；不写就用运行器的全局默认（目前 gpt-5.6-sol） */
  defaultModel?: string;
  /** 命中就换成人话（缺凭证 / 没登录）；按顺序取第一个命中 */
  hints?: { test: RegExp; reason: string }[];
}

/**
 * MCP 配置的「方言」：每个宿主的 MCP 配置文件放在哪、server 条目挂在哪个键下面、
 * 文件是什么格式、条目要转成什么形状。
 *
 * 不写就是默认方言：写 `layout.configFile`、JSON、`mcpServers.<name>`、条目用计划里的 spec 原样。
 */
export interface McpDialect {
  /** 写哪个文件（相对安装根）；不写就用 layout.configFile */
  file?: string;
  /** 配置里放 server 条目的对象路径，例如 ['mcpServers'] / ['mcp','servers'] / ['mcp_servers'] */
  path: string[];
  /** 配置文件格式；默认 json（.toml 的文件仍走旧的托管块分支） */
  format?: 'json' | 'yaml';
  /** 把计划里的通用 spec 转成这个宿主的条目形状；不写就原样 */
  entry?(spec: Record<string, unknown>): unknown;
}

/** 一个宿主的全部描述：静态知识 + 探针配方。注册后不可变。 */
export interface HarnessSpec {
  id: string;
  label: string;
  /** 相对平铺落点表的差量（skillsDir / configFile / instructionFile 之类） */
  layout: Partial<LayoutVars>;
  /** 实例内的 home 目录（相对实例根）与把它指过去的环境变量；没有 home 段的宿主不写 */
  home?: { dir: string; env: string };
  /**
   * 实例内落点覆盖（相对实例根）：PAL 把资源装进实例时用。
   * 默认 skills/knowledge/prompts 落在 `<home>/…`；有些宿主的全局目录多一层（如 opencode 的 XDG）
   * 或配置文件在 home 里，就用这个函数改。
   */
  instanceLayout?(homeDir: string): Partial<LayoutVars>;
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
  /** MCP 配置方言；不写 = JSON `mcpServers` + layout.configFile */
  mcp?: McpDialect;
  /**
   * 有没有「装进项目目录」这种落点；默认 true。
   * hermes 这类只有全局目录（~/.hermes）的宿主为 false——`pal install --into` 会拒绝，
   * 要装就 `pal create --kind hermes` 建实例。
   */
  project?: boolean;
  /** headless 探针配方 */
  probe: ProbeRecipe;
}

/**
 * 宿主 id：注册表是运行期的，类型上就是字符串。
 * 「是不是一个宿主」由 `isHarnessId()` 在运行期查表回答。
 */
export type HarnessId = string;

/** id 规则：小写字母开头，只含小写字母/数字/连字符（与资源 id、schema 的 pattern 同一套形状）。 */
export const HARNESS_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

const registry = new Map<string, HarnessSpec>();

/**
 * 注册一个宿主。id 必须符合 `HARNESS_ID_PATTERN`，同一个 id 重复注册直接抛错——
 * 这类错误只会在开发期出现（模块被 import 两次或 id 抄错），不留给运行期猜。
 */
export function registerHarness(spec: HarnessSpec): HarnessSpec {
  if (!HARNESS_ID_PATTERN.test(spec.id)) {
    throw new Error(`宿主 id 不合法：${spec.id}（要匹配 ${HARNESS_ID_PATTERN}）`);
  }
  if (registry.has(spec.id)) throw new Error(`宿主重复注册：${spec.id}`);
  registry.set(spec.id, spec);
  return spec;
}

/** 已注册的全部宿主（按注册顺序；index.ts 的 import 顺序就是声明顺序）。 */
export function harnesses(): readonly HarnessSpec[] {
  return [...registry.values()];
}

/** 已注册的宿主 id 名单（CLI 帮助、校验、错误信息都从这里取）。 */
export function harnessIds(): HarnessId[] {
  return [...registry.keys()];
}

/** 查一个宿主；没注册返回 undefined（调用方决定报错方式）。 */
export function harness(id: string): HarnessSpec | undefined {
  return registry.get(id);
}

/** 查一个宿主；没注册直接抛错（带可选名单）。 */
export function requireHarness(id: string): HarnessSpec {
  const spec = registry.get(id);
  if (!spec) throw new Error(`未知宿主：${id}（可选 ${harnessIds().join(' / ')}）`);
  return spec;
}

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && registry.has(value);
}

/** 选落点表：不传宿主 = 平铺目录（DIR_LAYOUT_VARS）。未知宿主抛错。 */
export function layoutFor(harnessId?: HarnessId): LayoutVars {
  if (harnessId === undefined) return DIR_LAYOUT_VARS;
  return layoutVarsWith(requireHarness(harnessId).layout);
}

/** 宿主的项目指令文件名（探针找托管块用）。未知宿主抛错。 */
export function instructionFileFor(id: HarnessId): string {
  return requireHarness(id).instructionFile;
}
