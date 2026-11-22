import type { PackContext, Plan } from '@packhub/kernel';
import { applyPlan, type ApplyOptions, type ApplyResult } from './install.ts';

/**
 * 调用方从 @packhub/runtime 拿的 kernel 符号：显式再导出，不再 `export *`。
 *
 * 新代码请直接从 `@packhub/kernel` 导入；这两项保留是因为 launcher 的调用点从 runtime 取。
 */
export { loadManifest, loadPack } from '@packhub/kernel';

export {
  STATE_API_VERSION,
  applyPlan,
  planPaths,
  loadState,
  saveState,
  removePack,
  rollbackPack,
  readVersionRecord,
  atomicWrite,
  type ApplyOptions,
  type ApplyResult,
  type RemoveResult,
  type RollbackResult,
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
export {
  inspectLicenses,
  evaluateLicense,
  npmLicense,
  type LicenseFinding,
  type LicensePolicy,
  type LicenseVerdict,
} from './license.ts';
export { doctorPack, type DoctorReport, type DriftFinding } from './doctor.ts';
export {
  probeHarness,
  probeSkill,
  extractMarker,
  type ProbeOptions,
  type ProbeResult,
  type SkillProbeOptions,
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
  setRequireSignature,
  trustedKeyIds,
  signaturePolicy,
  type TrustFile,
  type TrustedKey,
} from './trust.ts';
export { auditPath, appendAudit, readAudit, type AuditEntry } from './audit.ts';
export {
  generateKeyPair,
  signContentHash,
  verifySignatures,
  keyIdFromPem,
  signablePayload,
  type KeyPair,
  type SignatureCheck,
} from './signature.ts';
export {
  packArchive,
  unpackArchive,
  readArchiveFilesSync,
  isSafeArchiveEntry,
  vendoredEntries,
  localSources,
  LocalSourceNotVendoredError,
  type PackArchiveOptions,
  type PackArchiveResult,
} from './pack.ts';
export {
  addClaudeMcp,
  removeClaudeMcp,
  claudeAvailable,
  claudeHasMcp,
  type HostMcpSpec,
  type HostMcpResult,
} from './host-mcp.ts';
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
export { runChecks, verifyPack, type CheckResult, type CheckStatus, type VerifyOptions } from './verify.ts';
export { derivedChecks, mcpProbeChecks } from './derived-checks.ts';
export {
  verifyAt,
  type VerifyAtOptions,
  type VerifyAtResult,
  type VerifyMode,
} from './verify-at.ts';
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
  contentHashFor,
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
  resolveRegistry,
  registryIndexes,
  type PackhubConfig,
  type RegistryEntry,
} from './config.ts';

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
