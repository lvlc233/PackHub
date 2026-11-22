import type { Plan, PlanAction } from './types.ts';
import { STATE_DIR } from './files.ts';

/** 计划动作名的唯一来源：`PlanOp` 联合里每加一个 op，这张表必须补齐（否则 typecheck 报错）。 */
export type PlanOpName = PlanAction['op'];

/** `from` 的基准；`none` 表示这个 op 不读来源文件。 */
export type PlanOpFromBase = 'pack' | 'root' | 'none';

/** 撤销方式：删文件 / 还原共享配置 / 摘托管块 / 不撤销。 */
export type PlanOpUndo = 'delete' | 'restore-shared' | 'strip-block' | 'none';

/**
 * 撤销共享改动要动的那一处（配置里的键 / 指令文件里的块）。
 * 载荷和执行器要做的动作同源：`undo` 与 `PlanOpUndo` 一致，执行器不用再按 op 拼路径。
 * - `restore-shared`：`path` 是共享配置文件，`key` 是 `mcpServers` 下要摘掉的键；
 * - `strip-block`：`file` 是指令文件，`blockId` 是要摘掉的托管块。
 */
export type PlanOpUndoPayload =
  | { undo: 'restore-shared'; path: string; key: string }
  | { undo: 'strip-block'; file: string; blockId: string };

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
  /** 撤销共享改动要动的路径与键；不共享的 op 返回 null。 */
  undoPayload(action: PlanAction): PlanOpUndoPayload | null;
  /** 这个动作写到安装根的路径（含派生输出）；快照、版本镜像、planPaths、冲突都用它。 */
  paths(action: PlanAction, plan: PlanShape): string[];
  /** 动作成功时计入 state.written 的路径（平台差异在这里收口）。 */
  written(action: PlanAction, plan: Plan, platform: string): string[];
  /**
   * 这个动作的产物是否共享（多包可合并）。只由动作语义决定：`register.mcp` 按 key 合并、
   * `instruction` 按托管块追加；其余 op 的产物都是本包私有，路径长什么样都不改变这一点。
   */
  shared(action: PlanAction): boolean;
  /** 只读来源路径（缓存回收用：解包前的归档、技能/工具的执行体）。 */
  inputs(action: PlanAction): string[];
  /** 升级清理时保留并给出的原因；没有就按 `undo` 处理。 */
  retainWarning?: string;
}

const from =
  (base: PlanOpFromBase) =>
  (action: PlanAction): PlanOpFromBase =>
    (action as { fromBase?: 'pack' | 'root' }).fromBase ?? base;
const noFrom = (): PlanOpFromBase => 'none';

const none = (): string[] => [];
const noUndo = (): PlanOpUndoPayload | null => null;
const only =
  (pick: (action: PlanAction) => string | undefined) =>
  (action: PlanAction): string[] => {
    const hit = pick(action);
    return hit ? [hit] : [];
  };

/** `link.exec` 在 Windows 上多一个 `.cmd` 垫片；计划产物口径固定带上它。 */
export function execWrapperPath(to: string): string {
  return `${to}.cmd`;
}

export const PLAN_OPS: Record<PlanOpName, PlanOpSpec> = {
  fetch: {
    fromBase: noFrom,
    undo: 'delete',
    undoPayload: noUndo,
    paths: (a) => (a.op === 'fetch' ? [a.dest] : []),
    written: (a) => (a.op === 'fetch' ? [a.dest] : []),
    shared: () => false,
    inputs: none,
  },
  unpack: {
    // 解包读的是 fetch 实际写盘的位置（安装根内），不是 Pack 目录
    fromBase: from('root'),
    undo: 'delete',
    undoPayload: noUndo,
    paths: (a) => (a.op === 'unpack' ? [a.to] : []),
    written: (a) => (a.op === 'unpack' ? [a.to] : []),
    shared: () => false,
    inputs: only((a) => (a.op === 'unpack' ? a.from : undefined)),
  },
  write: {
    fromBase: from('pack'),
    undo: 'delete',
    undoPayload: noUndo,
    paths: (a) => (a.op === 'write' ? [a.to] : []),
    written: (a) => (a.op === 'write' ? [a.to] : []),
    shared: () => false,
    inputs: only((a) => (a.op === 'write' ? a.from : undefined)),
  },
  copy: {
    fromBase: from('pack'),
    undo: 'delete',
    undoPayload: noUndo,
    paths: (a) => (a.op === 'copy' ? [a.to] : []),
    written: (a) => (a.op === 'copy' ? [a.to] : []),
    shared: () => false,
    inputs: only((a) => (a.op === 'copy' ? a.from : undefined)),
  },
  'link.exec': {
    fromBase: noFrom,
    undo: 'delete',
    undoPayload: noUndo,
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
    undoPayload: noUndo,
    paths: (a) => (a.op === 'delete' ? [a.to] : []),
    written: none,
    shared: () => false,
    inputs: none,
  },
  'link.skill': {
    fromBase: from('pack'),
    undo: 'delete',
    undoPayload: noUndo,
    paths: (a, plan) =>
      a.op === 'link.skill'
        ? [a.to, ...(plan.harness === 'codex' ? [`${a.to}/${CODEX_SKILL_YAML}`] : [])]
        : [],
    written: (a) => (a.op === 'link.skill' ? [a.to] : []),
    shared: () => false,
    inputs: only((a) => (a.op === 'link.skill' ? a.from : undefined)),
  },
  'register.mcp': {
    fromBase: noFrom,
    undo: 'restore-shared',
    // 键与 runtime 卸载时登记的 server 名同源：resource 缺省时是 mcp
    undoPayload: (a) =>
      a.op === 'register.mcp'
        ? {
            undo: 'restore-shared',
            path: a.path ?? `${STATE_DIR}/config.json`,
            key: a.resource ?? 'mcp',
          }
        : null,
    paths: (a) => (a.op === 'register.mcp' ? [a.path ?? `${STATE_DIR}/config.json`] : []),
    written: (a) => (a.op === 'register.mcp' ? [a.path ?? `${STATE_DIR}/config.json`] : []),
    shared: () => true,
    inputs: none,
  },
  exec: {
    fromBase: noFrom,
    undo: 'none',
    undoPayload: noUndo,
    paths: none,
    written: none,
    shared: () => false,
    inputs: none,
  },
  instruction: {
    fromBase: noFrom,
    undo: 'strip-block',
    undoPayload: (a) =>
      a.op === 'instruction' ? { undo: 'strip-block', file: a.file, blockId: a.blockId } : null,
    paths: (a) => (a.op === 'instruction' ? [a.file] : []),
    written: (a) => (a.op === 'instruction' ? [a.file] : []),
    shared: () => true,
    inputs: none,
  },
  'state.dir': {
    fromBase: noFrom,
    undo: 'none',
    undoPayload: noUndo,
    paths: none,
    written: none,
    shared: () => false,
    inputs: none,
    retainWarning: '状态目录保留（数据不随升级删除）',
  },
};

/* ---------- 派生查询：runtime 侧只调这些函数，不再自己按 op 数路径 ---------- */

/**
 * 算路径只需要计划的两个字段：harness（派生输出随宿主变化；平铺目录时为空）与 actions。
 * 用它而不是整个 `Plan`，state 里存过的计划快照（`PlanSnapshot`）能直接传进来。
 */
export type PlanShape = Pick<Plan, 'harness' | 'actions'>;

/** 一份计划写到安装根的全部路径（去重；快照、版本镜像、缓存、所有权、升级清理共用）。 */
export function planPathsOf(plan: PlanShape): string[] {
  const out: string[] = [];
  for (const action of plan.actions) {
    for (const rel of actionPaths(action, plan)) out.push(rel);
  }
  return [...new Set(out)];
}

/** 单个动作写到安装根的路径（含派生输出）。 */
export function actionPaths(action: PlanAction, plan: PlanShape): string[] {
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

/** 撤销共享改动要动的路径与键（卸载 / 升级清理共用）；不共享的 op 返回 null。 */
export function actionUndoPayload(action: PlanAction): PlanOpUndoPayload | null {
  return PLAN_OPS[action.op].undoPayload(action);
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
