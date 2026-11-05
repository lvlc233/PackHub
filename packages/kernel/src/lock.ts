import type { LockFile, Manifest, Plan, ResolvedRef } from './types.ts';

export interface LockOptions {
  resolvedAt?: string;
  /** 解析后的引用（pin 到 commit / 版本 / sha256）；缺省时按清单原样记录 */
  resolved?: { id: string; source: string; integrity: string | null }[];
}

export function buildLock(manifest: Manifest, plan: Plan, opts: LockOptions = {}): LockFile {
  const resolvedAt = opts.resolvedAt ?? new Date().toISOString();
  const byId = new Map((opts.resolved ?? []).map((r) => [r.id, r]));

  const resolved: ResolvedRef[] = manifest.resources.map((res) => {
    const hit = byId.get(res.id);
    return {
      id: res.id,
      type: res.type,
      // 有解析结果就用解析后的（github tag → commit、npm range → 具体版本）
      source: hit?.source ?? res.source,
      // 没有 integrity 就显式写 null，不假装锁住了字节
      integrity: hit ? hit.integrity : res.integrity ?? null,
      resolvedAt,
    };
  });

  return {
    apiVersion: 'packhub.dev/lock/v0',
    pack: `${manifest.metadata.name}@${manifest.metadata.version}`,
    resolved,
    planHash: plan.planHash,
    generatedBy: 'packhub/0.0.1',
    // 计划快照：没有它就算不出「改了什么」，diff / update 都靠这一份
    plan: {
      target: plan.target,
      actions: plan.actions,
      verify: plan.verify,
      excluded: plan.excluded,
    },
  };
}
