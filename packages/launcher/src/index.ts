import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { planFor, type PackContext, type TargetId } from '@packhub/kernel';
import { ADAPTERS, targetVarsFor } from './layout.ts';
import {
  installPack,
  loadLock,
  loadPackResolved,
  loadState,
  removePack,
  withLockPins,
} from '@packhub/runtime';

const RECORD = 'instance.json';
const API_VERSION = 'packhub.dev/instance/v0';

export interface InstanceRecord {
  apiVersion: typeof API_VERSION;
  /** 与名字无关的身份 */
  id: string;
  name: string;
  harness: TargetId;
  /** 实例根：配置、数据、缓存、会话都在它下面 */
  root: string;
  /** 实例自己的 home 段（dsh: DSH_HOME）；dir 没有 */
  home?: string;
  pack: { name: string; version: string };
  planHash: string;
  createdAt: string;
  status: 'installed' | 'running' | 'stopped' | 'broken';
  /** 运行中的进程与端口；停掉后清空 */
  pid?: number;
  port?: number;
  url?: string;
}

export interface CreateInstanceOptions {
  name: string;
  harness: TargetId;
  /** 已经落到本地的 Pack 目录 */
  packDir: string;
  /** 实例根；不写就建在 instances 根下的新目录里 */
  root?: string;
}

/** 实例存放的根；测试与多环境都用它隔离。 */
export function instancesRoot(): string {
  return resolve(process.env.PACKHUB_INSTANCES ?? join(homedir(), '.packhub', 'instances'));
}

function newId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${suffix}`;
}

function readRecord(root: string): InstanceRecord | undefined {
  const file = join(root, RECORD);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as InstanceRecord;
  } catch {
    return undefined;
  }
}

export function writeInstance(record: InstanceRecord): void {
  const file = join(record.root, RECORD);
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
}

/** 列出实例根下的全部实例配置；坏记录跳过。 */
export function listInstances(): InstanceRecord[] {
  const base = instancesRoot();
  if (!existsSync(base)) return [];
  const out: InstanceRecord[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const record = readRecord(join(base, entry.name));
    if (record) out.push(record);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 按名字或 id 找一份实例配置。 */
export function readInstance(nameOrId: string): InstanceRecord | undefined {
  return listInstances().find((i) => i.id === nameOrId || i.name === nameOrId);
}

/**
 * 从一个 Pack 目录创建实例配置：出计划、装进实例根、写实例记录。
 * 失败时把实例根删掉，不留半套。
 */
export async function createInstance(opts: CreateInstanceOptions): Promise<InstanceRecord> {
  const base = instancesRoot();
  const existing = listInstances();
  if (existing.some((i) => i.name === opts.name)) {
    throw new Error(`实例名已存在：${opts.name}`);
  }

  const id = newId();
  const root = resolve(opts.root ?? join(base, id));
  if (existsSync(join(root, RECORD))) {
    throw new Error(`这个目录已经是一份实例配置：${root}`);
  }

  const packDir = resolve(opts.packDir);
  const loaded = await loadPackResolved(packDir);
  if (!loaded.manifest) {
    const detail = loaded.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ');
    throw new Error(`清单有问题：${detail || packDir}`);
  }
  const lock = loadLock(packDir);
  const ctx: PackContext = withLockPins(loaded, lock);
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) throw new Error(`清单有问题：${errors.map((i) => i.message).join('; ')}`);
  if (!ctx.manifest.metadata.targets.includes(opts.harness)) {
    throw new Error(
      `这个包没有声明 target ${opts.harness}；声明了：${ctx.manifest.metadata.targets.join(', ')}`,
    );
  }

  const adapter = ADAPTERS[opts.harness];
  const targetVars = targetVarsFor(opts.harness);
  const { plan, issues } = planFor(ctx, {
    target: opts.harness,
    ...(targetVars ? { targetVars } : {}),
  });
  if (!plan) throw new Error(`生成不了计划：${issues.map((i) => i.message).join('; ')}`);

  const home = adapter.homeDir ? join(root, adapter.homeDir) : undefined;
  mkdirSync(root, { recursive: true });
  if (home) mkdirSync(home, { recursive: true });
  try {
    const result = await installPack(ctx, plan, { root, packRoot: packDir });
    const failed = result.outcomes.filter((o) => o.status === 'failed');
    if (failed.length > 0) {
      throw new Error(`安装未完成：${failed.map((o) => `${o.actionId}=${o.status}`).join(', ')}`);
    }
    const record: InstanceRecord = {
      apiVersion: API_VERSION,
      id,
      name: opts.name,
      harness: opts.harness,
      root,
      ...(home ? { home } : {}),
      pack: {
        name: ctx.manifest.metadata.name,
        version: ctx.manifest.metadata.version,
      },
      planHash: plan.planHash,
      createdAt: new Date().toISOString(),
      status: 'installed',
    };
    writeInstance(record);
    return record;
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

/** 删一份实例配置：先按 state 卸掉装进去的包，再删实例根。 */
export function removeInstance(nameOrId: string): InstanceRecord {
  const record = readInstance(nameOrId);
  if (!record) throw new Error(`没有这个实例：${nameOrId}`);

  const state = loadState(record.root);
  for (const key of Object.keys(state.packs)) {
    removePack(record.root, key);
  }
  rmSync(record.root, { recursive: true, force: true });
  return record;
}
