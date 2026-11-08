import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PalError } from './errors.ts';
import { isPidAlive } from './process.ts';
import { nowIso } from './time.ts';

/**
 * 实例锁：一个实例一次只允许一个写操作（安装、启停、删除、改名、迁移）。
 * 依赖只有 fs/path、PalError、isPidAlive、nowIso；不依赖 index.ts。
 */

/** 锁文件名，放在实例根里。 */
export const LOCK = '.pal-lock.json';

export interface LockInfo {
  pid: number;
  op: string;
  at: string;
}

export class InstanceBusy extends PalError {
  constructor(root: string, holder: LockInfo) {
    super('busy', `实例正在被另一个 PAL 进程操作：${holder.op}（pid ${holder.pid}）`, {
      hint: '等它结束；确认那个进程已经不在了就删掉实例根里的 .pal-lock.json',
      details: { root, holder },
    });
  }
}

export function readLock(root: string): LockInfo | undefined {
  const file = join(root, LOCK);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

/**
 * 抢实例锁：拿到返回 true；本进程已持有返回 false（嵌套直接执行，不再写锁）。
 * 锁里记 pid：持有者已经不在了当陈旧锁清掉，不让崩溃永久锁死实例。
 */
export function acquireInstanceLock(root: string, op: string): boolean {
  const holder = readLock(root);
  if (holder) {
    if (holder.pid === process.pid) return false;
    if (isPidAlive(holder.pid)) throw new InstanceBusy(root, holder);
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, LOCK),
    JSON.stringify({ pid: process.pid, op, at: nowIso() }, null, 2) + '\n',
    'utf8',
  );
  return true;
}

export function releaseInstanceLock(root: string): void {
  try {
    rmSync(join(root, LOCK), { force: true });
  } catch {
    /* 锁文件删不掉不影响结果 */
  }
}

/**
 * 同步版锁：给必须保持同步签名的调用方（migrateInstance，CLI 直接同步调用）用。
 * 锁文件、陈旧锁判定与 withInstanceLock 共用同一套协议，只是不经过 Promise。
 */
export function withInstanceLockSync<T>(root: string, op: string, fn: (owned: boolean) => T): T {
  const owned = acquireInstanceLock(root, op);
  try {
    return fn(owned);
  } finally {
    if (owned) releaseInstanceLock(root);
  }
}

/**
 * 一个实例一次只允许一个写操作（安装、启停、删除）。
 */
export function withInstanceLock<T>(root: string, op: string, fn: () => Promise<T> | T): Promise<T> {
  const run = async (): Promise<T> => {
    if (!acquireInstanceLock(root, op)) return fn();
    try {
      return await fn();
    } finally {
      releaseInstanceLock(root);
    }
  };
  return run();
}

/** 读锁信息（排障用，不改变状态）。 */
export function instanceLock(root: string): LockInfo | undefined {
  return readLock(root);
}
