import { resolve } from 'node:path';
import type { Plan } from '@packhub/kernel';
import { applyPlan, type ApplyOptions, type ApplyResult } from './install.ts';
import { runChecks, serverSpecs, type CheckResult } from './verify.ts';
import type { PackContext } from '@packhub/kernel';

/** 内核的契约与判定在这里再导出一遍：调用方只依赖 runtime 也不会缺东西。 */
export * from '@packhub/kernel';

export {
  applyPlan,
  loadState,
  removePack,
  rollbackPack,
  listVersions,
  activatePack,
  readVersionRecord,
  atomicWrite,
  type ApplyOptions,
  type ApplyResult,
  type RemoveResult,
  type RollbackResult,
  type ActivateResult,
  type VersionInfo,
  type VersionRecord,
  type ActionOutcome,
  type ActionStatus,
} from './install.ts';
export {
  download,
  resolveDownloadUrl,
  resolvePypiSdist,
  pickSdist,
  FetchError,
  type FetchResult,
  type PypiSdist,
} from './download.ts';
export {
  addResource,
  addSignature,
  setBinding,
  inferId,
  type AddResourceInput,
  type AddResourceResult,
} from './authoring.ts';
export { updatePack, type UpdateOptions, type UpdateResult } from './update.ts';
export {
  inspectCache,
  cleanCache,
  type CacheEntry,
  type CacheReport,
  type CacheCleanResult,
} from './cache.ts';
export { resolveAddSource, gitArchiveUrl, type ResolvedSource } from './source.ts';
export { inspectLicenses, type LicenseFinding } from './license.ts';
export { doctorPack, type DoctorReport, type DriftFinding } from './doctor.ts';
export {
  probeHarness,
  extractMarker,
  type ProbeOptions,
  type ProbeResult,
  type HarnessTarget,
  type Runner,
  type RunnerResult,
} from './harness-probe.ts';
export {
  readSignatures,
  writeSignature,
  SIGNATURE_FILE,
  type SignatureEntry,
  type SignatureFile,
} from './signfile.ts';
export {
  trustPath,
  readTrust,
  addTrustedKey,
  removeTrustedKey,
  trustedKeyIds,
  signaturePolicy,
  type TrustFile,
  type TrustedKey,
} from './trust.ts';
export { auditPath, appendAudit, readAudit, type AuditEntry } from './audit.ts';
export {
  generateKeyPair,
  signPlan,
  verifySignatures,
  keyIdFromPem,
  signablePayload,
  type KeyPair,
  type SignatureCheck,
} from './signature.ts';
export {
  packArchive,
  unpackArchive,
  type PackArchiveOptions,
  type PackArchiveResult,
} from './pack.ts';
export {
  readIndex,
  fetchPack,
  archivePath,
  RegistryError,
  type RegistryIndex,
  type IndexEntry,
} from './registry.ts';
export {
  loadCatalog,
  catalogPathNear,
  searchNpm,
  type CatalogLoadResult,
} from './catalog.ts';
export {
  credentialsPath,
  readCredentials,
  setToken,
  removeToken,
  listTokens,
  resolveToken,
  mask,
  type CredentialEntry,
  type CredentialFile,
  type TokenInfo,
} from './credentials.ts';
export { runChecks, type CheckResult, type CheckStatus, type VerifyOptions } from './verify.ts';
export {
  verifyInstalled,
  hasInstalledPacks,
  type InstalledVerifyReport,
  type InstalledVerifyOptions,
} from './installed.ts';
export {
  inspectPack,
  loadLock,
  withLockPins,
  type PackInspection,
  type InspectionIssue,
} from './consume.ts';
export {
  resolveReferences,
  pinManifest,
  lockPack,
  type ResolvedReference,
  type ResolveOptions,
  type ResolveReport,
  type LockPackOptions,
  type LockPackResult,
} from './resolve.ts';
export {
  configPath,
  readConfig,
  defaultRegistryIndex,
  type PackhubConfig,
  type RegistryEntry,
} from './config.ts';
export {
  syncPack,
  removeSynced,
  doctorGlobal,
  harnessRoot,
  globalTargetVars,
  readSkillFrontmatter,
  type SyncTarget,
  type SyncOptions,
  type SyncTargetResult,
  type SyncRemoveResult,
  type GlobalDoctorResult,
  type SkillFrontmatter,
} from './sync.ts';

/** 把计划落到目标目录（执行面：写盘、下载、可选执行命令）。 */
export function installPack(
  ctx: PackContext,
  plan: Plan,
  opts: Omit<ApplyOptions, 'root' | 'packRoot'> & { root?: string; packRoot?: string } = {},
): Promise<ApplyResult> {
  return applyPlan(plan, {
    ...opts,
    root: opts.root ?? ctx.dir,
    packRoot: opts.packRoot ?? ctx.dir,
  });
}

export function verifyPack(dir: string, plan: Plan): Promise<CheckResult[]> {
  return runChecks(plan.verify, { root: resolve(dir), servers: serverSpecs(plan) });
}
