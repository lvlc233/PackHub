/** PackHub v0.0.1 数据模型。
 *
 * 权威定义在 `schema/packhub.v0.schema.json`；这里的类型是它的人工镜像，
 * 由 `test/resource-types.test.ts` 比对 schema 的 enum 兜底。改 Schema 时必须同步改这里。
 */

/** 资源类型的唯一来源：CLI、资源目录、面板都从这里取，不要再各写一份。 */
export const RESOURCE_TYPES = ['mcp', 'skill', 'prompt', 'knowledge', 'config', 'tool2'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export function isResourceType(value: unknown): value is ResourceType {
  return typeof value === 'string' && (RESOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * 宿主（harness）名的唯一来源。不写宿主 = 平铺到项目里，那不是某个宿主，所以不在这个名单里。
 * 加宿主：这里加一个名字；落点表（layout.ts）与 launcher 适配器都按 HarnessId 建 Record，缺一条编译不过。
 */
export const HARNESS_IDS = ['dsh', 'claude-code', 'codex'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value);
}

/** 执行一条工具用的解释器；binary 表示直接执行，不加前缀。 */
export const TOOL_RUNTIMES = ['node', 'python', 'shell', 'binary'] as const;
export type ToolRuntime = (typeof TOOL_RUNTIMES)[number];

/**
 * 工具的一条可调度命令（暴露单位）。
 * 只有列进 commands 的才建入口、写进说明；目录里其余文件照样打包，只是不暴露。
 */
export interface ToolCommand {
  name: string;
  /** source 目录内的执行体；source 是单个文件时可省略 */
  exec?: string;
  runtime?: ToolRuntime;
  /** shim: route 时必填——模块里要调的函数名 */
  call?: string;
  /** 固定前置参数，用来把一个执行体拆成多条命令 */
  args?: string[];
  /** true = 希望 harness 异步调度；不支持就按同步等待 */
  async?: boolean;
  /** 调度指令、参数、何时用、失败看什么；写进宿主说明 */
  usage: string;
  /** 覆盖资源级 shim */
  shim?: 'auto' | 'wrap' | 'route';
  /** 这条命令只在这些平台建入口；不写就用资源级 */
  platforms?: string[];
  /** 命令级环境变量；与资源级合并，同名以命令级为准 */
  env?: Record<string, string>;
}

export interface ResourceSpec {
  id: string;
  type: ResourceType;
  source: string;
  integrity?: string;
  /** 只声明需要哪个凭证（变量名），值永远不进清单 */
  auth?: { env: string; scheme?: 'bearer' | 'token' | 'basic' };
  transport?: 'stdio' | 'http';
  config?: Record<string, unknown>;
  /** 工具：默认入口方式与默认异步偏好；命令级可覆盖 */
  shim?: 'auto' | 'wrap' | 'route';
  async?: boolean;
  /** 工具：默认平台白名单（`process.platform-process.arch`）；命令级可覆盖 */
  platforms?: string[];
  /** 工具：暴露出来的命令 */
  commands?: ToolCommand[];
  /** 工具：资源级环境变量；命令级同名覆盖 */
  env?: Record<string, string>;
  /** 这个资源提供的能力令牌（`<form>/<name>@<major>`） */
  provides?: string[];
  /** 这个资源需要的能力令牌；安装顺序由它派生 */
  needs?: string[];
  optional?: boolean;
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

/**
 * 对某个资源做二次修改（整合包里的「mod 的 mod」）。
 *
 * `with` 决定动作：
 * - 以 `./`、`../` 或 scheme 开头的字符串 = 包内路径：文件则整份替换，目录则逐文件叠上去
 * - 其他字符串 = 内联文本，直接当内容用
 * - null = 删掉目标（文件，或 `at` 指的那一段）
 * - 对象 = 并进资源参数（mcp / tool2 那类），不能带 `file` / `at`
 *
 * 寻址：`resource` → `file` → `at`。给了 `file` 或 `at` 就是定位编辑，目标必须存在；
 * 只有 `with` 是目录、且没给 `file` 时，才允许目标不存在（那是新增）。
 */
export interface ModifySpec {
  resource: string;
  /** 资源内的相对路径；单文件资源（knowledge / prompt）可省略 */
  file?: string;
  /** 锚点：`#` 开头是整节（到下一个同级或更高级标题），否则按整行匹配；必须唯一命中 */
  at?: string;
  /** 命中多处时指定第几个（按文档顺序，从 1 起）；不写就要求唯一 */
  nth?: number;
  /** 换掉整段（默认）、插在它前面、插在它后面 */
  where?: 'replace' | 'before' | 'after';
  with: string | null | Record<string, unknown>;
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

// 清单
export interface Manifest {
  apiVersion: 'packhub.dev/v0';
  kind: 'Pack';
  metadata: {
    name: string;
    version: string;
    title?: string;
    description?: string;
    license?: string;
    homepage?: string;
    keywords?: string[];
    authors?: { name: string; url?: string }[];
    /** 默认 private：要进公共索引必须显式写 public */
    visibility?: 'public' | 'unlisted' | 'internal' | 'private';
  };
  /** schema 的顶层 required 里没有它；读端（graph.ts、registry 索引）也都按可选取。 */
  requires?: { packhub: string };
  /**
   * 整合包自己的那段上下文：这个环境是什么、默认怎么做事、什么不做、从哪开始。
   * 写成 `./` 开头的路径时，plan 期读那份文件；否则按内联文本用。
   * 安装时排在宿主说明块的最前面，模型第一眼读到它，而不是资源清单。
   */
  context?: string;
  vars?: Record<string, string | number | boolean>;
  resources: ResourceSpec[];
  /** 持久状态目录；资源里用 ${state.<id>} 引用 */
  state?: StateDirSpec[];
  /** 按资源做二次修改（整文件 / 一段 / 删掉 / 改参数） */
  modify?: ModifySpec[];
  /** 对 {pack, contentHash} 的 ed25519 签名 */
  signatures?: { key: string; sig: string; at?: string }[];
  install?: { exec?: ExecSpec[] };
  verify?: VerifyCheck[];
}

/* ---------- 计划（Plan） ---------- */

/**
 * 动作来源的基准：`from` 到底相对谁。
 * - `pack`：Pack 目录内的相对路径（作者带来的字节）
 * - `root`：安装根内的相对路径（fetch / unpack 的中间产物）
 *
 * 只出现在带 `from` 的动作上；不写就按 plan-ops 表里的 op 默认值。
 */
export type PlanActionFromBase = 'pack' | 'root';

export type PlanOp =
  | {
      op: 'fetch';
      uri: string;
      dest: string;
      integrity?: string;
      auth?: { env: string; scheme?: 'bearer' | 'token' | 'basic' };
    }
  | { op: 'unpack'; from: string; to: string; strip?: number; fromBase?: PlanActionFromBase }
  | {
      op: 'write';
      to: string;
      from?: string;
      content?: string;
      /** 资源在清单里声明了 integrity 时带上：verify 段据此派生哈希校验 */
      integrity?: string;
      fromBase?: PlanActionFromBase;
    }
  | { op: 'copy'; from: string; to: string; fromBase?: PlanActionFromBase }
  | {
      op: 'link.exec';
      to: string;
      runtime: ToolRuntime;
      entry: string;
      module?: string;
      args?: string[];
      env?: Record<string, string>;
      /** 只在这些平台（`platform-arch`）建入口；不匹配由执行器记 skipped */
      platforms?: string[];
    }
  | { op: 'delete'; to: string }
  | { op: 'link.skill'; from: string; to: string; fromBase?: PlanActionFromBase }
  | { op: 'register.mcp'; spec: Record<string, unknown>; path?: string }
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

/** 把元数据分配到 union 的每个成员上（交叉类型不会自动分配，会导致 Omit 丢掉变体字段）。 */
type WithMeta<T> = T extends unknown ? T & { actionId: string; resource?: string } : never;

export type PlanAction = WithMeta<PlanOp>;
/** 生成阶段允许省略 actionId（由 push 自动编号）。 */
export type PlanActionInput = PlanOp & {
  actionId?: string;
  resource?: string;
};

export interface Plan {
  apiVersion: 'packhub.dev/plan/v0';
  pack: { name: string; version: string };
  /** 装到哪个宿主；平铺到项目里（不指定宿主）时这个字段不出现 */
  harness?: HarnessId;
  actions: PlanAction[];
  verify: VerifyCheck[];
  /** 没进计划的资源：说明为什么没装 */
  excluded: { resource: string; reason: string }[];
  /** 计划内容的规范化哈希：同输入必须同哈希 */
  planHash: string;
}

/** 一个安装形态（平铺目录或某个宿主）的计划快照：安装时写进 state，重算路径、算差异都靠它。 */
export interface PlanSnapshot {
  /** 与 Plan.harness 同义：平铺目录时字段不出现 */
  harness?: HarnessId;
  planHash: string;
  actions: PlanAction[];
  verify: VerifyCheck[];
  excluded: Plan['excluded'];
}

/**
 * 锁只描述「引用了什么、内容是否完整」。
 *
 * 装到哪个宿主是安装参数，计划由 `planFor(ctx, { harness })` 在用到时现算，
 * 不进锁、不进内容层：同一份内容平铺装或装到任一宿主，锁是同一份。
 */
export interface LockFile {
  apiVersion: 'packhub.dev/lock/v0';
  pack: string;
  resolved: ResolvedRef[];
  /** 清单 + resolved 的规范化哈希；口径写在 `lock.ts` 的 `contentHashOf` 上 */
  contentHash: string;
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

/* ---------- 带版本 JSON 的版本号：写方与读方的唯一来源 ---------- */

/**
 * registry 索引的格式版本。`registry/src/build.ts` 写它，`runtime/src/registry.ts`
 * 的 readIndex 读它——两端比同一个常量，不各写一份字面量。
 */
export const INDEX_API_VERSION = 'packhub.dev/index/v0';
