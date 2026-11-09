import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TargetId } from '@packhub/kernel';
import { DEFAULT_ISOLATION, parseIsolation, type Isolation } from './isolation.ts';
import { nowIso } from './time.ts';

/**
 * 实例记录：文件名、记录类型、解析与读取。
 * 只做纯文件读写，依赖 fs/path、time.ts、isolation.ts 和 kernel 的类型；不 import index.ts（避免循环）。
 * 带副作用的写记录在 recordWrite.ts；列表、隔离区与归档仍在 index.ts。
 */

export const RECORD = 'instance.json';
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
  /** 隔离策略：每层是每实例一份还是全局共享；旧记录没有这个字段，读出来是默认策略 */
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
 * 只随启停与看护变化。`ports` 在类型上是可选的（旧记录/手写记录可能没有），
 * 读取时 `parseRecord` 会归一到 `[]`；写回时按存在性带，避免给旧记录凭空补字段。
 */
export interface RuntimeState {
  status: InstanceStatus;
  /** 运行中的进程与端口；停掉后清空。url 已摘掉凭据，凭据在 secrets.json */
  pid?: number;
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
 * 一条实例记录 = 配置 + 运行态。持久化仍是同一个 instance.json（兼容旧记录），
 * 类型上先分开，将来要落单独文件时只需换读写层。
 */
export interface InstanceRecord extends InstanceConfig, RuntimeState {}

/**
 * 把一条记录拆成配置与运行态。用剩余展开而不是逐字段重建：
 * 记录里将来多出来的字段（未知/旧字段）会原样留在 config 侧，不会在往返中丢掉。
 */
export function partitionRecord(record: InstanceRecord): { config: InstanceConfig; runtime: RuntimeState } {
  const { status, pid, port, ports, url, startedAt, lastExit, lastError, ...config } = record;
  return {
    config,
    runtime: {
      status,
      ...(pid === undefined ? {} : { pid }),
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
  const { status, pid, port, ports, url, startedAt, lastExit, lastError } = runtime;
  return {
    ...config,
    status,
    ...(pid === undefined ? {} : { pid }),
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

function parseRecord(root: string, text: string): InstanceRecord {
  // 旧记录可能带 planHash：事实只在 baseline.json，读的时候直接丢掉，写回时也不会再带上
  const data = JSON.parse(text) as InstanceRecord & { planHash?: unknown };
  if (!data || typeof data !== 'object' || typeof data.id !== 'string' || typeof data.name !== 'string') {
    throw new Error('记录缺字段');
  }
  delete data.planHash;
  const harness = (data.harness ?? 'dir') as TargetId;
  const normalized: InstanceRecord = {
    ...data,
    apiVersion: API_VERSION,
    harness,
    root: data.root ?? root,
    updatedAt: data.updatedAt ?? data.createdAt ?? nowIso(),
    managed: data.managed ?? true,
    ports: Array.isArray(data.ports) ? data.ports : [],
    pack: data.pack ?? { name: 'unknown', version: '0.0.0' },
    // 隔离策略坏了不至于让整份记录变坏记录：解析不了就按默认策略读
    isolation: parseIsolation(data.isolation) ?? DEFAULT_ISOLATION,
  };
  return normalized;
}

export interface RecordRead {
  record?: InstanceRecord;
  error?: string;
}

/** 读一份记录；坏记录给出原因，由调用方决定隔离还是跳过。 */
export function readRecordResult(root: string): RecordRead {
  const file = recordFile(root);
  if (!existsSync(file)) return { error: '没有 instance.json' };
  try {
    return { record: parseRecord(root, readFileSync(file, 'utf8')) };
  } catch (err) {
    return { error: `instance.json 读不了：${(err as Error).message}` };
  }
}

export function readRecord(root: string): InstanceRecord | undefined {
  return readRecordResult(root).record;
}
