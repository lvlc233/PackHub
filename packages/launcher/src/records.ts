import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TargetId } from '@packhub/kernel';
import { DEFAULT_ISOLATION, parseIsolation, type Isolation } from './isolation.ts';
import { nowIso } from './time.ts';

/**
 * 实例记录：文件名、记录类型、解析与读取。
 * 只做纯文件读写，依赖 fs/path、time.ts、isolation.ts 和 kernel 的类型；不 import index.ts（避免循环）。
 * 带副作用的写记录在 recordWrite.ts；列表、隔离区与归档仍在 index.ts。
 *
 * 持久化分两份：instance.json 只存 InstanceConfig，runtime.json 只存 RuntimeState。
 * 没有旧格式兼容：缺 runtime.json 的记录一律当坏记录，不做「运行态还在 instance.json」的合并。
 */

export const RECORD = 'instance.json';
/** 运行态单独一份：进程/端口/地址不该跟着备份恢复，也不该混在配置里。 */
export const RUNTIME = 'runtime.json';
export const API_VERSION = 'packhub.dev/instance/v1';

export type InstanceStatus =
  | 'installing'
  | 'installed'
  | 'running'
  | 'stopped'
  | 'broken'
  | 'failed';

/**
 * 身份与配置：不随进程启停变化的那部分。
 * `updatedAt` 是写盘时间戳（写入侧维护），不属于运行态；放在这里是为了 partition/merge 往返不丢字段。
 */
export interface InstanceConfig {
  apiVersion: typeof API_VERSION;
  /** 与名字无关的身份 */
  id: string;
  name: string;
  harness: TargetId;
  /** 宿主自己的版本；探测不到就不写 */
  harnessVersion?: string;
  /** 实例根：配置、数据、缓存、会话都在它下面 */
  root: string;
  /** 实例自己的 home 段（dsh: DSH_HOME）；dir 没有 */
  home?: string;
  /** 隔离策略：每层是每实例一份还是全局共享；配置里缺这个字段时读出来是默认策略 */
  isolation?: Isolation;
  pack: { name: string; version: string; ref?: string };
  createdAt: string;
  updatedAt: string;
  /** 这个根是 PAL 建的（false = 接管已有目录）：只有 true 才允许整根删除 */
  managed: boolean;
  /** 从哪来：pack 引用、接管目录或复制；导出模板只认 kind='pack' 且有 ref */
  origin?: { kind: 'pack' | 'adopted' | 'copy'; ref?: string; dir?: string; from?: string; seededFrom?: string };
  /** on-failure 时由 PAL 的守护重起；默认 never */
  restart?: 'never' | 'on-failure';
  maxRestarts?: number;
}

/**
 * 运行态：进程、端口、地址与最近一次退出/报错。
 * 只随启停与看护变化。`ports` 在类型上是可选的（手写记录可能没有），
 * 读取时 `parseRuntime` 会归一到 `[]`；写回时按存在性带，避免凭空补字段。
 */
export interface RuntimeState {
  status: InstanceStatus;
  /**
   * 运行中的进程与端口；停掉后清空。url 已摘掉凭据，凭据在 secrets.json。
   * 语义 = `spawnPid ?? listenPid`。只有 `spawnPid` 是可杀目标；`listenPid` 是证据，
   * 详见 start.ts 的 killTargetFor。
   */
  pid?: number;
  /** PAL 自己 spawn 出来的进程（Windows 上可能是 .cmd 垫片）；唯一允许 kill 的目标 */
  spawnPid?: number;
  /** 启动后按端口反查到的监听者：只作证据，永远不直接杀它 */
  listenPid?: number;
  port?: number;
  /** 启动时分配过的端口（旧到新），排障用 */
  ports?: number[];
  url?: string;
  startedAt?: string;
  /** 最近一次运行结束的原因；崩溃诊断看这里 */
  lastExit?: { code: number | null; signal: NodeJS.Signals | null; at: string; restarts: number };
  lastError?: { code: string; message: string; at: string };
}

/**
 * 一条实例记录 = 配置 + 运行态。读的时候合并成这一条；写的时候拆开落两个文件：
 * instance.json 只写 InstanceConfig，runtime.json 只写 RuntimeState。
 */
export interface InstanceRecord extends InstanceConfig, RuntimeState {}

/** 运行态字段清单：拆分配置时按它剔除，也是「哪些字段只在 runtime.json」的唯一口径。 */
const RUNTIME_KEYS = [
  'status',
  'pid',
  'spawnPid',
  'listenPid',
  'port',
  'ports',
  'url',
  'startedAt',
  'lastExit',
  'lastError',
] as const;

/**
 * 把一条记录拆成配置与运行态。用剩余展开而不是逐字段重建：
 * 记录里将来多出来的字段（未知/旧字段）会原样留在 config 侧，不会在往返中丢掉。
 */
export function partitionRecord(record: InstanceRecord): { config: InstanceConfig; runtime: RuntimeState } {
  const { status, pid, spawnPid, listenPid, port, ports, url, startedAt, lastExit, lastError, ...config } = record;
  return {
    config,
    runtime: {
      status,
      ...(pid === undefined ? {} : { pid }),
      ...(spawnPid === undefined ? {} : { spawnPid }),
      ...(listenPid === undefined ? {} : { listenPid }),
      ...(port === undefined ? {} : { port }),
      ...(ports === undefined ? {} : { ports }),
      ...(url === undefined ? {} : { url }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(lastExit === undefined ? {} : { lastExit }),
      ...(lastError === undefined ? {} : { lastError }),
    },
  };
}

/**
 * 把配置与运行态合回一条记录。同样用展开：config 里带的其他字段（含未知字段）全部保留；
 * 可选字段按存在性带，缺省的不补成 undefined。
 */
export function mergeRecord(config: InstanceConfig, runtime: RuntimeState): InstanceRecord {
  const { status, pid, spawnPid, listenPid, port, ports, url, startedAt, lastExit, lastError } = runtime;
  return {
    ...config,
    status,
    ...(pid === undefined ? {} : { pid }),
    ...(spawnPid === undefined ? {} : { spawnPid }),
    ...(listenPid === undefined ? {} : { listenPid }),
    ...(port === undefined ? {} : { port }),
    ...(ports === undefined ? {} : { ports }),
    ...(url === undefined ? {} : { url }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(lastExit === undefined ? {} : { lastExit }),
    ...(lastError === undefined ? {} : { lastError }),
  };
}

export function recordFile(root: string): string {
  return join(root, RECORD);
}

export function runtimeFile(root: string): string {
  return join(root, RUNTIME);
}

/** 读一个 JSON 对象；数组/标量都不算记录。 */
function jsonObject(text: string): Record<string, unknown> {
  const data = JSON.parse(text) as unknown;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('内容不是对象');
  return data as Record<string, unknown>;
}

/** instance.json 必须有身份字段；缺了就是坏记录，不能拿默认值蒙混。 */
function instanceData(text: string): Record<string, unknown> {
  const data = jsonObject(text);
  if (typeof data.id !== 'string' || typeof data.name !== 'string') throw new Error('记录缺字段');
  return data;
}

/**
 * 运行态归一：status 缺省 installed，ports 缺省 []；
 * pid 证据只认有限数字，手写记录里的坏值直接丢掉，宁可当没有，也不当证据。
 */
function runtimeFrom(data: Record<string, unknown>): RuntimeState {
  const runtime: RuntimeState = {
    status: (typeof data.status === 'string' && data.status !== '' ? data.status : 'installed') as InstanceStatus,
    ports: Array.isArray(data.ports) ? (data.ports as number[]) : [],
  };
  if (data.pid !== undefined) runtime.pid = data.pid as number;
  if (data.port !== undefined) runtime.port = data.port as number;
  if (data.url !== undefined) runtime.url = data.url as string;
  if (data.startedAt !== undefined) runtime.startedAt = data.startedAt as string;
  if (data.lastExit !== undefined) runtime.lastExit = data.lastExit as RuntimeState['lastExit'];
  if (data.lastError !== undefined) runtime.lastError = data.lastError as RuntimeState['lastError'];
  for (const key of ['spawnPid', 'listenPid'] as const) {
    const pid = data[key];
    if (typeof pid === 'number' && Number.isFinite(pid)) runtime[key] = pid;
  }
  return runtime;
}

/**
 * 把 instance.json 的原始对象归一成一条记录：缺省字段补默认，运行态字段剔除。
 */
function normalizeRecord(root: string, data: Record<string, unknown>): InstanceRecord {
  const config: Record<string, unknown> = { ...data };
  for (const key of RUNTIME_KEYS) delete config[key];
  return {
    ...(config as unknown as InstanceConfig),
    apiVersion: API_VERSION,
    harness: (data.harness as TargetId | undefined) ?? 'dir',
    root: typeof data.root === 'string' ? data.root : root,
    updatedAt:
      typeof data.updatedAt === 'string'
        ? data.updatedAt
        : typeof data.createdAt === 'string'
          ? data.createdAt
          : nowIso(),
    managed: typeof data.managed === 'boolean' ? data.managed : true,
    pack: (data.pack as InstanceConfig['pack'] | undefined) ?? { name: 'unknown', version: '0.0.0' },
    // 隔离策略坏了不至于让整份记录变坏记录：解析不了就按默认策略读
    isolation: parseIsolation(data.isolation) ?? DEFAULT_ISOLATION,
    ...runtimeFrom(data),
  };
}

/**
 * 解析 instance.json（配置半份）。只取配置字段，运行态即使混进来也会被剔除；
 * 运行态只从 runtime.json 读，缺这份文件就是坏记录。
 */
export function parseConfig(root: string, text: string): InstanceConfig {
  return partitionRecord(normalizeRecord(root, instanceData(text))).config;
}

/** 解析 runtime.json（运行态半份）。坏 JSON 由调用方当坏记录处理，不静默丢。 */
export function parseRuntime(text: string): RuntimeState {
  return runtimeFrom(jsonObject(text));
}

export interface RecordRead {
  record?: InstanceRecord;
  error?: string;
}

/** 读一份记录；坏记录给出原因，由调用方决定隔离还是跳过。 */
export function readRecordResult(root: string): RecordRead {
  const file = recordFile(root);
  if (!existsSync(file)) return { error: '没有 instance.json' };

  let config: InstanceConfig;
  try {
    config = parseConfig(root, readFileSync(file, 'utf8'));
  } catch (err) {
    return { error: `instance.json 读不了：${(err as Error).message}` };
  }

  const runtimePath = runtimeFile(root);
  if (!existsSync(runtimePath)) return { error: '没有 runtime.json（记录不完整）' };
  try {
    return { record: mergeRecord(config, parseRuntime(readFileSync(runtimePath, 'utf8'))) };
  } catch (err) {
    return { error: `runtime.json 读不了：${(err as Error).message}` };
  }
}

export function readRecord(root: string): InstanceRecord | undefined {
  return readRecordResult(root).record;
}
