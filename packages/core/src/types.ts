/** PackHub v0.0.1 数据模型。
 *
 * 权威定义在 `schema/packhub.v0.schema.json`；这里的类型是它的人工镜像，
 * 由 `tests/schema.test.ts` 用 examples/ 做一致性兜底。改 Schema 时必须同步改这里。
 */

export type ResourceType = 'mcp' | 'skill' | 'prompt' | 'knowledge' | 'config' | 'tool';
export type TargetId = 'dir' | 'dsh' | 'claude-code';

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
  optional?: boolean;
}

export interface CompositionNeed {
  capability: string;
  requires: string[];
  bind?: string;
}

export interface Composition {
  env?: Record<string, string | number | boolean>;
  order?: string[];
  needs?: CompositionNeed[];
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
  undo?: { command: string; args?: string[] };
}

export type VerifyCheck =
  | { type: 'file-exists'; path: string }
  | { type: 'command'; run: string[]; expectExit?: number; timeout?: number }
  | { type: 'config-key'; path: string; key: string; equals?: string | number | boolean }
  | { type: 'mcp-ready'; resource: string; timeout?: number }
  | { type: 'knowledge-integrity'; resource: string };

export interface SlotSpec {
  /** 占位实现必须提供的能力 */
  contract?: string[];
  note?: string;
}

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
  /** 包统一管理的路径表，资源里用 ${paths.x} 引用 */
  paths?: Record<string, string>;
  overrides?: { resource: string; source?: string; config?: Record<string, unknown> }[];
  /** 装完之后按路径覆盖目标文件：mod 的 mod */
  overlays?: Overlay[];
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
  | { op: 'exec'; command: string; args: string[]; cwd?: string; approval: 'required' }
  | { op: 'instruction'; file: string; blockId: string; content: string };

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

export interface LockFile {
  apiVersion: 'packhub.dev/lock/v0';
  pack: string;
  resolved: ResolvedRef[];
  planHash: string;
  generatedBy: string;
  /** 计划快照：diff / update 靠它算「改了什么」 */
  plan?: {
    target: TargetId;
    actions: PlanAction[];
    verify: VerifyCheck[];
    excluded: Plan['excluded'];
  };
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
