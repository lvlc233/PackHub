/** PackHub v0.0.1 数据模型。
 *
 * 权威定义在 `schema/packhub.v0.schema.json`；这里的类型是它的人工镜像，
 * 由 `test/resource-types.test.ts` 比对 schema 的 enum 兜底。改 Schema 时必须同步改这里。
 */

/** 资源类型的唯一来源：CLI、资源目录、面板都从这里取，不要再各写一份。 */
export const RESOURCE_TYPES = ['mcp', 'skill', 'prompt', 'knowledge', 'config', 'tool'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export function isResourceType(value: unknown): value is ResourceType {
  return typeof value === 'string' && (RESOURCE_TYPES as readonly string[]).includes(value);
}

/** 安装 target 的规范顺序；CLI 帮助、错误信息、面板都从这里取。 */
export const TARGET_IDS = ['dir', 'dsh', 'claude-code', 'codex'] as const;
export type TargetId = (typeof TARGET_IDS)[number];

export interface ResourceSpec {
  id: string;
  type: ResourceType;
  source: string;
  integrity?: string;
  /** 只声明需要哪个凭证（变量名），值永远不进清单 */
  auth?: { env: string; scheme?: 'bearer' | 'token' | 'basic' };
  transport?: 'stdio' | 'http';
  config?: Record<string, unknown>;
  /** 占用哪个可替换位（slot）；未绑定的候选不进计划 */
  slot?: string;
  provides?: string[];
  needs?: string[];
  dependsOn?: string[];
  /** 只在这些 target 上安装；不写就是全部（client / server 裁剪靠它） */
  targets?: TargetId[];
  optional?: boolean;
}

export interface Composition {
  env?: Record<string, string | number | boolean>;
  order?: string[];
}

/** 持久状态目录：装进项目、升级与卸载默认保留（记忆、索引、会话存档）。 */
export interface StateDirSpec {
  id: string;
  /** 相对安装根的路径；默认 `.packhub/state/<id>` */
  path?: string;
  /** 卸载时保留（默认）还是跟随包一起删除；删数据必须显式写 remove */
  retain?: 'keep' | 'remove';
  description?: string;
}

export interface Overlay {
  /** Pack 内的目录，例如 ./overrides */
  from: string;
  /** 目标根，默认 "."（Pack 目录） */
  to?: string;
  /** 只覆盖文件名匹配这些后缀/名字的文件 */
  include?: string[];
  note?: string;
}

export interface ExecSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** 毫秒；默认 120000 */
  timeout?: number;
  undo?: { command: string; args?: string[] };
}

export type VerifyCheck =
  | { type: 'file-exists'; path: string }
  | { type: 'command'; run: string[]; expectExit?: number; timeout?: number }
  | { type: 'config-key'; path: string; key: string; equals?: string | number | boolean }
  | { type: 'mcp-ready'; resource: string; timeout?: number }
  | { type: 'knowledge-integrity'; resource: string; integrity?: string }
  /** 真跑一次最小任务：要么执行命令，要么让 harness headless 回答一句话，再断言结果。 */
  | {
      type: 'scenario';
      run?: string[];
      harness?: 'dsh' | 'claude-code' | 'opencode' | 'codex';
      prompt?: string;
      expectExit?: number;
      /** 回答/输出里必须出现的子串；写数组时全部都要出现 */
      expectOutput?: string | string[];
      /** 跑完必须存在的文件（相对安装根） */
      expectFiles?: string[];
      cwd?: string;
      timeout?: number;
    };

export interface SlotSpec {
  /** 占位实现必须提供的能力 */
  contract?: string[];
  note?: string;
}

// 清单
export interface Manifest {
  apiVersion: 'packhub.dev/v0';
  kind: 'Pack';
  extends?: string;
  metadata: {
    name: string;
    version: string;
    title?: string;
    description?: string;
    license?: string;
    homepage?: string;
    keywords?: string[];
    authors?: { name: string; url?: string }[];
    targets: TargetId[];
    /** 默认 private：要进公共索引必须显式写 public */
    visibility?: 'public' | 'unlisted' | 'internal' | 'private';
  };
  requires: { packhub: string; agent?: string };
  vars?: Record<string, string | number | boolean>;
  resources: ResourceSpec[];
  composition?: Composition;
  /** 可替换位：槽位名 → 契约 */
  slots?: Record<string, SlotSpec>;
  /** 槽位 → 资源 id；只有被绑定的实现会进计划 */
  bindings?: Record<string, string>;
  /** 持久状态目录；资源里用 ${state.<id>} 引用 */
  state?: StateDirSpec[];
  overrides?: { resource: string; source?: string; config?: Record<string, unknown> }[];
  /** 装完之后按路径覆盖目标文件：mod 的 mod */
  overlays?: Overlay[];
  /** 对 {pack, planHash} 的 ed25519 签名 */
  signatures?: { key: string; sig: string; at?: string }[];
  install?: { exec?: ExecSpec[] };
  verify?: VerifyCheck[];
}

/* ---------- 计划（Plan） ---------- */

export type PlanOp =
  | {
      op: 'fetch';
      uri: string;
      dest: string;
      integrity?: string;
      auth?: { env: string; scheme?: 'bearer' | 'token' | 'basic' };
    }
  | { op: 'unpack'; from: string; to: string; strip?: number }
  | { op: 'write'; to: string; from?: string; content?: string }
  | { op: 'link.skill'; from: string; to: string }
  | { op: 'register.mcp'; spec: Record<string, unknown>; path?: string }
  | {
      op: 'merge.config';
      path: string;
      strategy: 'json-merge' | 'yaml-merge';
      patch?: unknown;
      patchFrom?: string;
    }
  | {
      op: 'exec';
      command: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeout?: number;
      approval: 'required';
    }
  | { op: 'instruction'; file: string; blockId: string; content: string }
  /** 持久状态目录：只建目录，不写文件；卸载时按 retain 决定去留 */
  | { op: 'state.dir'; to: string; retain: 'keep' | 'remove' }
  /** tool 的可执行入口：读解包后的 package.json，在 binDir 下生成跨平台 wrapper */
  | { op: 'link.bin'; from: string; to: string; command: string };

/** 把元数据分配到 union 的每个成员上（交叉类型不会自动分配，会导致 Omit 丢掉变体字段）。 */
type WithMeta<T> = T extends unknown
  ? T & { actionId: string; resource?: string; dependsOn?: string[] }
  : never;

export type PlanAction = WithMeta<PlanOp>;
/** 生成阶段允许省略 actionId（由 push 自动编号）。 */
export type PlanActionInput = PlanOp & {
  actionId?: string;
  resource?: string;
  dependsOn?: string[];
};

export interface Plan {
  apiVersion: 'packhub.dev/plan/v0';
  pack: { name: string; version: string };
  target: TargetId;
  actions: PlanAction[];
  verify: VerifyCheck[];
  /** 被槽位绑定排除的候选：说明为什么没装 */
  excluded: { resource: string; slot: string; reason: string }[];
  /** 计划内容的规范化哈希：同输入必须同哈希 */
  planHash: string;
}

/** 一个 target 的计划快照：diff / update / 安装前核对都靠它。 */
export interface PlanSnapshot {
  target: TargetId;
  planHash: string;
  actions: PlanAction[];
  verify: VerifyCheck[];
  excluded: Plan['excluded'];
}

export interface LockFile {
  apiVersion: 'packhub.dev/lock/v0';
  pack: string;
  resolved: ResolvedRef[];
  /** 主计划（`plan.target`）的哈希；老读方仍读这一个 */
  planHash: string;
  generatedBy: string;
  /** 主计划快照：diff / update 靠它算「改了什么」 */
  plan?: PlanSnapshot;
  /** 每个已声明 target 的计划快照；跨 target 安装时按这里的哈希核对 */
  plans?: Partial<Record<TargetId, PlanSnapshot>>;
}

export interface ResolvedRef {
  id: string;
  type: ResourceType;
  source: string;
  integrity: string | null;
  resolvedAt: string;
}

/* ---------- 问题清单 ---------- */

export type Severity = 'error' | 'warning';

export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  /** 例如 `resources[2].source` */
  path?: string;
}
