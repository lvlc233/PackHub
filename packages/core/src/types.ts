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
  transport?: 'stdio' | 'http';
  config?: Record<string, unknown>;
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
  };
  requires: { packhub: string; agent?: string };
  vars?: Record<string, string | number | boolean>;
  resources: ResourceSpec[];
  composition?: Composition;
  overrides?: { resource: string; source?: string; config?: Record<string, unknown> }[];
  install?: { exec?: ExecSpec[] };
  verify?: VerifyCheck[];
}

/* ---------- 计划（Plan） ---------- */

export type PlanOp =
  | { op: 'fetch'; uri: string; dest: string; integrity?: string }
  | { op: 'unpack'; from: string; to: string; strip?: number }
  | { op: 'write'; to: string; from?: string; content?: string }
  | { op: 'link.skill'; from: string; to: string }
  | { op: 'register.mcp'; spec: Record<string, unknown> }
  | {
      op: 'merge.config';
      path: string;
      strategy: 'json-merge' | 'yaml-merge';
      patch?: unknown;
      patchFrom?: string;
    }
  | { op: 'exec'; command: string; args: string[]; cwd?: string; approval: 'required' };

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
  /** 计划内容的规范化哈希：同输入必须同哈希 */
  planHash: string;
}

export interface LockFile {
  apiVersion: 'packhub.dev/lock/v0';
  pack: string;
  resolved: ResolvedRef[];
  planHash: string;
  generatedBy: string;
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
