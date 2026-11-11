import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LockFile, Manifest, PackContext, Plan } from '@packhub/kernel';
import { validateGraph } from '@packhub/kernel';
import { readSignatures } from './signfile.ts';
import { verifySignatures } from './signature.ts';

export interface InspectionIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface PackInspection {
  lock?: LockFile;
  /** 锁里的 planHash 与「按锁的目标重算的计划」是否一致 */
  lockMatches?: boolean;
  verifyReport?: { ok?: boolean; planHash?: string } | null;
  signatures: { key: string; ok: boolean }[];
  issues: InspectionIssue[];
}

/** 锁文件的格式版本。v0 只认这一代；读到别的主版本必须拒绝，不猜字段。 */
export const LOCK_API = 'packhub.dev/lock/v0';

export interface LockRead {
  lock?: LockFile;
  /** 读不了或版本不认识：调用方当错误处理，不能当成「没有锁」 */
  problem?: InspectionIssue;
}

/** 读锁文件。没有锁返回空；坏锁与不认识的主版本都落到 problem。 */
export function loadLock(dir: string): LockRead {
  const file = join(dir, 'packhub.lock.json');
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {
      problem: {
        code: 'lock-unreadable',
        severity: 'error',
        message: 'packhub.lock.json 读不出来（不是合法 JSON）',
      },
    };
  }
  const api = (parsed as { apiVersion?: unknown } | null)?.apiVersion;
  if (api !== LOCK_API) {
    return {
      problem: {
        code: 'lock-version',
        severity: 'error',
        message: `锁的格式版本不认识：${String(api)}（只认 ${LOCK_API}）；确认它是不是更高版本的 PackHub 写的`,
      },
    };
  }
  return { lock: parsed as LockFile };
}

/**
 * 按锁里的解析结果替换清单里的引用，得到「作者锁住的那一份」。
 * 安装、校验、更新都用它，避免清单写 tag、锁写 commit 时两边各装一套。
 */
export function withLockPins(ctx: PackContext, lock?: LockFile): PackContext {
  if (!lock?.resolved?.length) return ctx;
  const byId = new Map(lock.resolved.map((r) => [r.id, r]));
  const manifest: Manifest = {
    ...ctx.manifest,
    resources: ctx.manifest.resources.map((res) => {
      const hit = byId.get(res.id);
      if (!hit) return res;
      return {
        ...res,
        source: hit.source,
        ...(hit.integrity ? { integrity: hit.integrity } : {}),
      };
    }),
  };
  const { graph, issues } = validateGraph(manifest);
  // 清单本身可能因为「未 pin」被判错；锁已经把引用钉死了，按钉死后的清单重新判断
  return { ...ctx, manifest, graph, issues };
}

/**
 * 消费端核对：锁与计划是否一致、验证报告是否对得上、签名是否有效。
 * 只读，不改任何文件；问题交给调用方决定是否放行。
 */
export function inspectPack(
  dir: string,
  manifest: Manifest,
  planForLockedTarget: Plan | undefined,
  opts: { trusted?: string[] } = {},
): PackInspection {
  const issues: InspectionIssue[] = [];
  const pack = `${manifest.metadata.name}@${manifest.metadata.version}`;
  const read = loadLock(dir);
  const lock = read.lock;
  let lockMatches: boolean | undefined;

  if (lock) {
    if (!lock.plan) {
      issues.push({
        code: 'lock-without-plan',
        severity: 'warning',
        message: '锁里没有计划快照（旧版锁），无法核对清单是否被改过',
      });
    } else if (planForLockedTarget) {
      lockMatches = lock.planHash === planForLockedTarget.planHash;
      if (!lockMatches) {
        issues.push({
          code: 'lock-mismatch',
          severity: 'error',
          message: `锁与清单对不上（lock=${String(lock.planHash).slice(0, 20)}… plan=${planForLockedTarget.planHash.slice(0, 20)}…）；清单在锁定后被改过，确认来源后加 --allow-stale-lock 才装`,
        });
      }
    }
    if (lock.pack !== pack) {
      issues.push({
        code: 'lock-pack-mismatch',
        severity: 'warning',
        message: `锁记录的包是 ${lock.pack}，清单是 ${pack}`,
      });
    }
  } else if (read.problem) {
    issues.push(read.problem);
  } else {
    issues.push({
      code: 'lock-missing',
      severity: 'warning',
      message: '这个包没有锁，无法核对「装到的东西」和作者锁的是不是同一份',
    });
  }

  let verifyReport: PackInspection['verifyReport'] = null;
  const verifyFile = join(dir, 'verify.json');
  if (existsSync(verifyFile)) {
    try {
      verifyReport = JSON.parse(readFileSync(verifyFile, 'utf8')) as { ok?: boolean; planHash?: string };
      if (planForLockedTarget && verifyReport?.planHash !== planForLockedTarget.planHash) {
        issues.push({
          code: 'verify-plan-mismatch',
          severity: 'warning',
          message: '验证报告与当前计划不一致（报告是旧版本跑出来的）',
        });
      }
      if (verifyReport?.ok !== true) {
        issues.push({
          code: 'verify-not-ok',
          severity: 'warning',
          message: '这个版本的验证报告没有通过',
        });
      }
    } catch {
      issues.push({ code: 'verify-unreadable', severity: 'warning', message: 'verify.json 不是合法 JSON' });
    }
  }

  const all = [...readSignatures(dir), ...(manifest.signatures ?? [])];
  const signatures = verifySignatures(all, pack, planForLockedTarget?.planHash ?? '');
  if (signatures.length > 0 && !signatures.some((s) => s.ok)) {
    issues.push({
      code: 'signature-invalid',
      severity: 'warning',
      message: '有签名，但都对不上当前清单（签名可能属于别的版本）',
    });
  }
  if (opts.trusted && opts.trusted.length > 0) {
    const trustedOk = signatures.some((s) => s.ok && opts.trusted!.includes(s.key));
    if (!trustedOk) {
      issues.push({
        code: 'signature-untrusted',
        severity: 'warning',
        message: '签名不在信任列表里',
      });
    }
  }

  return { ...(lock ? { lock } : {}), ...(lockMatches !== undefined ? { lockMatches } : {}), verifyReport, signatures, issues };
}
