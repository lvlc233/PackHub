import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LockFile, Manifest, PackContext } from '@packhub/kernel';
import { buildLock, checkLockConsistency, contentHashOf, validateGraph } from '@packhub/kernel';
import { readSignatures } from './signfile.ts';
import { verifySignatures } from './signature.ts';

export interface InspectionIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface PackInspection {
  lock?: LockFile;
  /** 锁的 contentHash 与「按当前清单重算的 contentHash」是否一致 */
  lockMatches?: boolean;
  /** 验证报告；`contentHash` 是它跑的那份内容（旧版 runner 写的报告没有这个字段） */
  verifyReport?: { ok?: boolean; contentHash?: string } | null;
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
 * 「这份内容」的 contentHash：锁在就以锁钉死的 `resolved` 为准算，没有锁就按清单自身的引用算
 * （与 `buildLock` 同口径）。签名覆盖的是它、验证报告绑定的也是它；安装 target 不参与。
 *
 * 所有消费端都从这里取，别再各算一份。
 */
export function contentHashFor(manifest: Manifest, lock?: LockFile): string {
  return lock ? contentHashOf(manifest, lock.resolved) : buildLock(manifest).contentHash;
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
 * 消费端核对：锁与清单是否一致、验证报告是否对得上、签名是否有效。
 *
 * 锁只描述内容（清单 + resolved），所以核对不需要计划、也不需要安装 target：判据是重算
 * contentHash。安装 target 由调用方按需现算计划，不传进来。
 * 只读，不改任何文件；问题交给调用方决定是否放行。
 */
export function inspectPack(
  dir: string,
  manifest: Manifest,
  opts: { trusted?: string[] } = {},
): PackInspection {
  const issues: InspectionIssue[] = [];
  const pack = `${manifest.metadata.name}@${manifest.metadata.version}`;
  const read = loadLock(dir);
  const lock = read.lock;
  const contentHash = contentHashFor(manifest, lock);
  let lockMatches: boolean | undefined;

  if (lock) {
    // 锁 ↔ 清单只有一份判定：kernel 的 checkLockConsistency；这里只把结论映射成 issue
    const check = checkLockConsistency(lock, manifest);
    if (check.status === 'ok') lockMatches = true;
    else {
      lockMatches = false;
      issues.push({ code: 'lock-mismatch', severity: 'error', message: check.message });
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
      message: checkLockConsistency(undefined, manifest).message,
    });
  }

  let verifyReport: PackInspection['verifyReport'] = null;
  const verifyFile = join(dir, 'verify.json');
  if (existsSync(verifyFile)) {
    try {
      verifyReport = JSON.parse(readFileSync(verifyFile, 'utf8')) as { ok?: boolean; contentHash?: string };
      // 报告绑定的是内容：contentHash 对得上，才说明这份报告是这份内容跑出来的。
      // 旧版 runner 写的报告只有 planHash（安装期的派生值），无法核对，提示重跑。
      if (verifyReport?.contentHash !== contentHash) {
        issues.push({
          code: 'verify-content-mismatch',
          severity: 'warning',
          message:
            verifyReport?.contentHash === undefined
              ? '验证报告是旧口径（没有 contentHash），无法核对是不是这份内容跑出来的'
              : '验证报告与当前内容不一致（报告是别的内容跑出来的）',
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
  const signatures = verifySignatures(all, pack, contentHash);
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
