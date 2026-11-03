import type { LockFile, Manifest, Plan, ResolvedRef } from './types.ts';

export function buildLock(
  manifest: Manifest,
  plan: Plan,
  resolvedAt = new Date().toISOString(),
): LockFile {
  const resolved: ResolvedRef[] = manifest.resources.map((res) => ({
    id: res.id,
    type: res.type,
    source: res.source,
    // v0.0.1 不联网：integrity 只能来自 manifest 自身，其余显式标注 unresolved
    integrity: res.integrity ?? null,
    resolvedAt,
  }));

  return {
    apiVersion: 'packhub.dev/lock/v0.0.1',
    pack: `${manifest.metadata.name}@${manifest.metadata.version}`,
    resolved,
    planHash: plan.planHash,
    generatedBy: 'packhub/0.0.1',
  };
}
