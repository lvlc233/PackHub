import { HARNESSES, type HarnessId } from './harness.ts';
import { STATE_DIR } from './files.ts';

/**
 * 落点（layout）变量：一次安装会把资源放到哪些目录。
 *
 * 这是目录约定数据，不是计划逻辑；住在 layout.ts 方便一眼看出哪个宿主跟平铺不一样。
 * 新增字段时所有落点表都会编译报错，逼着补全。
 */
export interface LayoutVars {
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
  /** 指令文件名；平铺目录没有（只物化到 .packhub，不碰宿主指令面） */
  instructionFile?: string;
}

/** 平铺约定：全部物化到 .packhub，不碰宿主的配置文件。 */
const BASE_LAYOUT_VARS: LayoutVars = {
  root: STATE_DIR,
  cacheDir: `${STATE_DIR}/cache`,
  skillsDir: `${STATE_DIR}/skills`,
  knowledgeDir: `${STATE_DIR}/knowledge`,
  promptsDir: `${STATE_DIR}/prompts`,
  binDir: `${STATE_DIR}/bin`,
  configDir: `${STATE_DIR}/config`,
  configFile: `${STATE_DIR}/config.json`,
};

/** 在平铺约定上只写差量：一眼能看出哪个宿主不一样。 */
const withDefaults = (patch: Partial<LayoutVars>): LayoutVars => ({ ...BASE_LAYOUT_VARS, ...patch });

/** 平铺目录的落点表：不指定宿主时用它。 */
export const DIR_LAYOUT_VARS: LayoutVars = withDefaults({});

/**
 * 各宿主的落点：从 `HARNESSES` 表里的 `layout` 差量派生。
 * 加宿主只改表，这里跟着长出来，不再手写第二份落点表。
 */
export const LAYOUT_VARS = Object.fromEntries(
  (Object.keys(HARNESSES) as HarnessId[]).map((id) => [id, withDefaults(HARNESSES[id].layout)]),
) as Record<HarnessId, LayoutVars>;

/** 选落点表：不传宿主 = 平铺目录（DIR_LAYOUT_VARS）。 */
export function layoutFor(harness?: HarnessId): LayoutVars {
  return harness ? LAYOUT_VARS[harness] : DIR_LAYOUT_VARS;
}
