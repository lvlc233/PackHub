import type { Plan, PlanAction } from './types.ts';

/** 计划动作名的唯一来源：`PlanOp` 联合里每加一个 op，这张表必须补齐（否则 typecheck 报错）。 */
export type PlanOpName = PlanAction['op'];

/** `from` 的基准；`none` 表示这个 op 不读来源文件。 */
export type PlanOpFromBase = 'pack' | 'root' | 'none';

/** 撤销方式：删文件 / 还原共享配置 / 摘托管块 / 不撤销。 */
export type PlanOpUndo = 'delete' | 'restore-shared' | 'strip-block' | 'none';

/** codex 的技能选择器要求 `agents/openai.yaml`：install 期生成，计划里没有对行动作。 */
export const CODEX_SKILL_YAML = 'agents/openai.yaml';

/**
 * 每个动作原语的单点声明。执行器只负责「怎么做」，路径、来源基准、撤销方式、
 * 共享判定、派生输出全部从这里取，避免执行、快照、清理、缓存、所有权各数一遍。
 */
export interface PlanOpSpec {
  /** 来源 `from` 相对谁；动作可以显式带 `fromBase` 覆盖。 */
  fromBase(action: PlanAction): PlanOpFromBase;
  /** 撤销方式（卸载 / 升级清理 / 版本切换共用）。 */
  undo: PlanOpUndo;
  /** 这个动作写到安装根的路径（含派生输出）；快照、版本镜像、planPaths、冲突都用它。 */
  paths(action: PlanAction, plan: Plan): string[];
  /** 动作成功时计入 state.written 的路径（平台差异在这里收口）。 */
  written(action: PlanAction, plan: Plan, platform: string): string[];
  /** 目标是否共享路径（多包合并 / 托管块）。 */
  shared(action: PlanAction): boolean;
  /** 只读来源路径（缓存回收用：解包前的归档、技能/工具的执行体）。 */
  inputs(action: PlanAction): string[];
  /** 升级清理时保留并给出的原因；没有就按 `undo` 处理。 */
  retainWarning?: string;
}

/**
 * 共享路径：配置文件（多包合并）与根目录的指令文件（托管块各写各的）。
 * 住在表里，执行、版本镜像、升级清理、所有权冲突共用同一口径。
 */
export function isSharedInstallPath(rel: string): boolean {
  if (/\.(json|jsonc|toml)$/i.test(rel)) return true;
  return !rel.includes('/') && /\.md$/i.test(rel);
}

const from =
  (base: PlanOpFromBase) =>
  (action: PlanAction): PlanOpFromBase =>
    (action as { fromBase?: 'pack' | 'root' }).fromBase ?? base;
const noFrom = (): PlanOpFromBase => 'none';

const none = (): string[] => [];
const only =
  (pick: (action: PlanAction) => string | undefined) =>
  (action: PlanAction): string[] => {
    const hit = pick(action);
    return hit ? [hit] : [];
  };

/** 共享判定只看动作的目标路径（register.mcp / instruction 单独声明为共享）。 */
const sharedByTarget = (action: PlanAction): boolean =>
  'to' in action ? isSharedInstallPath(action.to) : false;

/** `link.exec` 在 Windows 上多一个 `.cmd` 垫片；计划产物口径固定带上它。 */
export function execWrapperPath(to: string): string {
  return `${to}.cmd`;
}

export const PLAN_OPS: Record<PlanOpName, PlanOpSpec> = {
  fetch: {
    fromBase: noFrom,
    undo: 'delete',
    paths: (a) => (a.op === 'fetch' ? [a.dest] : []),
    written: (a) => (a.op === 'fetch' ? [a.dest] : []),
    shared: sharedByTarget,
    inputs: none,
  },
  unpack: {
    // 解包读的是 fetch 实际写盘的位置（安装根内），不是 Pack 目录
    fromBase: from('root'),
    undo: 'delete',
    paths: (a) => (a.op === 'unpack' ? [a.to] : []),
    written: (a) => (a.op === 'unpack' ? [a.to] : []),
    shared: sharedByTarget,
    inputs: only((a) => (a.op === 'unpack' ? a.from : undefined)),
  },
  write: {
    fromBase: from('pack'),
    undo: 'delete',
    paths: (a) => (a.op === 'write' ? [a.to] : []),
    written: (a) => (a.op === 'write' ? [a.to] : []),
    shared: sharedByTarget,
    inputs: only((a) => (a.op === 'write' ? a.from : undefined)),
  },
  copy: {
    fromBase: from('pack'),
    undo: 'delete',
    paths: (a) => (a.op === 'copy' ? [a.to] : []),
    written: (a) => (a.op === 'copy' ? [a.to] : []),
    shared: sharedByTarget,
    inputs: only((a) => (a.op === 'copy' ? a.from : undefined)),
  },
  'link.exec': {
    fromBase: noFrom,
    undo: 'delete',
    paths: (a) => (a.op === 'link.exec' ? [a.to, execWrapperPath(a.to)] : []),
    written: (a, _plan, platform) => {
      if (a.op !== 'link.exec') return [];
      if (a.platforms && !a.platforms.includes(platform)) return [];
      return platform.startsWith('win32') ? [a.to, execWrapperPath(a.to)] : [a.to];
    },
    shared: () => false,
    inputs: (a) => (a.op === 'link.exec' ? [a.entry, ...(a.module ? [a.module] : [])] : []),
  },
  delete: {
    fromBase: noFrom,
    undo: 'none',
    paths: (a) => (a.op === 'delete' ? [a.to] : []),
    written: none,
    shared: sharedByTarget,
    inputs: none,
  },
  'link.skill': {
    fromBase: from('pack'),
    undo: 'delete',
    paths: (a, plan) =>
      a.op === 'link.skill'
        ? [a.to, ...(plan.target === 'codex' ? [`${a.to}/${CODEX_SKILL_YAML}`] : [])]
        : [],
    written: (a) => (a.op === 'link.skill' ? [a.to] : []),
    shared: sharedByTarget,
    inputs: only((a) => (a.op === 'link.skill' ? a.from : undefined)),
  },
  'register.mcp': {
    fromBase: noFrom,
    undo: 'restore-shared',
    paths: (a) => (a.op === 'register.mcp' ? [a.path ?? '.packhub/config.json'] : []),
    written: (a) => (a.op === 'register.mcp' ? [a.path ?? '.packhub/config.json'] : []),
    shared: () => true,
    inputs: none,
  },
  exec: {
    fromBase: noFrom,
    undo: 'none',
    paths: none,
    written: none,
    shared: () => false,
    inputs: none,
  },
  instruction: {
    fromBase: noFrom,
    undo: 'strip-block',
    paths: (a) => (a.op === 'instruction' ? [a.file] : []),
    written: (a) => (a.op === 'instruction' ? [a.file] : []),
    shared: () => true,
    inputs: none,
  },
  'state.dir': {
    fromBase: noFrom,
    undo: 'none',
    paths: none,
    written: none,
    shared: () => false,
    inputs: none,
    retainWarning: '状态目录保留（数据不随升级删除）',
  },
};

/* ---------- 派生查询：runtime 侧只调这些函数，不再自己按 op 数路径 ---------- */

/** 一份计划写到安装根的全部路径（去重；快照、版本镜像、缓存、所有权、升级清理共用）。 */
export function planPathsOf(plan: Plan): string[] {
  const out: string[] = [];
  for (const action of plan.actions) {
    for (const rel of actionPaths(action, plan)) out.push(rel);
  }
  return [...new Set(out)];
}

/** 单个动作写到安装根的路径（含派生输出）。 */
export function actionPaths(action: PlanAction, plan: Plan): string[] {
  return PLAN_OPS[action.op].paths(action, plan);
}

/** 单个动作成功时计入 state.written 的路径。 */
export function actionWritten(action: PlanAction, plan: Plan, platform: string): string[] {
  return PLAN_OPS[action.op].written(action, plan, platform);
}

export function actionFromBase(action: PlanAction): PlanOpFromBase {
  return PLAN_OPS[action.op].fromBase(action);
}

export function actionUndo(action: PlanAction): PlanOpUndo {
  return PLAN_OPS[action.op].undo;
}

export function actionIsShared(action: PlanAction): boolean {
  return PLAN_OPS[action.op].shared(action);
}

export function actionInputs(action: PlanAction): string[] {
  return PLAN_OPS[action.op].inputs(action);
}

export function actionRetainWarning(action: PlanAction): string | undefined {
  return PLAN_OPS[action.op].retainWarning;
}
