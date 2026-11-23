// 落点的公共答案：包自己的产物落在 `.packhub`，宿主认的位置由各宿主模块回答。
//
// 内核不再持有「布局表」：`Destination` 由宿主的 `destination()` 给出，计划与 `${layout.*}`
// 插值都从这里派生。这个文件只提供两样东西：
// - 一张落点表的拼装工具（宿主模块用它写自己的回答，没覆盖的键自动落到 `.packhub`）；
// - 平铺目录（不指定宿主）的那一份回答。
//
// 计划里的动作路径都相对安装根，所以这里的值也是相对安装根的路径。

import { STATE_DIR } from './files.ts';
import type {
  Destination,
  DestinationContext,
  DestinationKind,
  McpDialect,
} from './harness/contract.ts';

/** 包自己的状态根：所有范围（项目 / managed / attached）都一样，宿主不读这里。 */
export const PACK_ROOT = STATE_DIR;

/** 一份落点表：宿主只写它认的那几项，没写的落到 `.packhub` 段。 */
export interface DestinationTable {
  skill?: string;
  knowledge?: string;
  prompt?: string;
  bin?: string;
  config?: string;
  cache?: string;
  /** MCP 配置文件（相对安装根） */
  mcp?: string;
  /** 宿主的项目 / 全局指令文件；不写 = 这个范围没有指令面 */
  instruction?: string;
}

/**
 * 没被宿主覆盖的落点：包自己收着，不碰宿主的任何位置。
 * `instruction` 缺省是空字符串——平铺目录没有指令面，写了 `${layout.instructionFile}` 就报未定义。
 */
const PACK_PATHS: Record<DestinationKind, string> = {
  skill: `${PACK_ROOT}/skills`,
  knowledge: `${PACK_ROOT}/knowledge`,
  prompt: `${PACK_ROOT}/prompts`,
  bin: `${PACK_ROOT}/bin`,
  config: `${PACK_ROOT}/config`,
  cache: `${PACK_ROOT}/cache`,
  mcp: `${PACK_ROOT}/config.json`,
  instruction: '',
};

/** 把一张落点表变成宿主的 destination：`mcp` 的方言随 mcp 的落点一起给。 */
export function destinationsOf(
  table: DestinationTable,
  mcp?: McpDialect,
): (kind: DestinationKind) => Destination {
  return (kind) => {
    const path = table[kind] ?? PACK_PATHS[kind];
    return kind === 'mcp' && mcp ? { path, mcp } : { path };
  };
}

/**
 * 平铺目录（不指定宿主）：全部落进 `.packhub`，不碰宿主的任何位置，也没有指令面。
 * `ctx` 用不到——平铺不是宿主，没有 home 段、也没有范围差异。
 */
export function flatDestination(kind: DestinationKind): Destination {
  return destinationsOf({})(kind);
}

/** `${layout.*}` 插值的键：由 destination 派生，`root` 是包状态根（不是安装根）。 */
export function layoutNamespace(
  dest: (kind: DestinationKind) => Destination,
): Record<string, string> {
  const namespace: Record<string, string> = {
    root: PACK_ROOT,
    cacheDir: dest('cache').path,
    skillsDir: dest('skill').path,
    knowledgeDir: dest('knowledge').path,
    promptsDir: dest('prompt').path,
    binDir: dest('bin').path,
    configDir: dest('config').path,
    configFile: dest('mcp').path,
  };
  // 没有指令面的范围（平铺目录）不给这个键：清单里写了就按未定义变量报错
  const instructionFile = dest('instruction').path;
  if (instructionFile) namespace.instructionFile = instructionFile;
  return namespace;
}

/**
 * 一次安装的落点回答：宿主自己答，平铺目录用内置的那份。
 * 未知宿主不在这里猜——调用方先用 `isHarnessId()` 校验过。
 */
export function destinationFor(
  spec: { destination(kind: DestinationKind, ctx: DestinationContext): Destination } | undefined,
  ctx: DestinationContext,
): (kind: DestinationKind) => Destination {
  return spec ? (kind) => spec.destination(kind, ctx) : flatDestination;
}
