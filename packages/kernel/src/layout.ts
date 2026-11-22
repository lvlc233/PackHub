// 落点（layout）变量的基线：一次安装会把资源放到哪些目录。
//
// 这里只放「平铺目录」那一份约定 + 叠差量的工具；各宿主的差量在 harness/<id>.ts 里注册，
// `layoutFor()` 在注册表那层算（见 harness/contract.ts）。

import { STATE_DIR } from './files.ts';

/**
 * 落点（layout）变量：一次安装会把资源放到哪些目录。
 *
 * 这是目录约定数据，不是计划逻辑；字段只在这里定义一次，新增字段会让所有差量编译报错。
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

/** 在平铺约定上叠宿主的差量（注册表用它算 layoutFor）。 */
export function layoutVarsWith(patch: Partial<LayoutVars>): LayoutVars {
  return { ...BASE_LAYOUT_VARS, ...patch };
}

/** 平铺目录的落点表：不指定宿主时用它。 */
export const DIR_LAYOUT_VARS: LayoutVars = layoutVarsWith({});
