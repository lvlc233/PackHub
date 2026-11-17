import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  INDEX_API_VERSION,
  canonicalize,
  loadPack,
  parseCatalog,
  planFor,
  sha256,
  type LockFile,
  type ResourceCatalog,
} from '@packhub/kernel';
import { SIGNATURE_FILE, readArchiveFilesSync, withLockPins } from '@packhub/runtime';

export interface IndexEntry {
  version: string;
  manifest: unknown;
  planHash: string;
  trust: 'verified' | 'community';
  verifiedAt: string | null;
  signers: string[];
  manifestHash: string;
}

export interface IndexPack {
  name: string;
  title: string;
  description: string;
  latest: string;
  versions: string[];
  targets: string[];
  trust: 'verified' | 'community';
  verifiedAt: string | null;
  signers: string[];
  keywords: string[];
  resourceCount: number;
  install: string;
  /** 清单里的展示元数据；没有就是 null / 空数组，读方不用猜 */
  license: string | null;
  homepage: string | null;
  authors: { name: string; url?: string }[];
  requiresAgent: string | null;
}

export interface RegistryIndex {
  /** 写方与读方共用 kernel 的常量，不各写一份字面量 */
  apiVersion: typeof INDEX_API_VERSION;
  generatedAt: string;
  packs: IndexPack[];
}

export interface BuildResult {
  index: RegistryIndex;
  errors: string[];
  warnings: string[];
}

const semverGreater = (a: string, b: string): boolean => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
};

function dirs(p: string): string[] {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 资源目录的版本：与 kernel 的 `ResourceCatalog.apiVersion` 同源，不各写一份字面量。 */
export const RESOURCES_API_VERSION: ResourceCatalog['apiVersion'] = 'packhub.dev/resources/v0';

export interface ResourcesCatalogGate {
  errors: string[];
  warnings: string[];
}

/**
 * `registry/resources.json` 的门禁：文件存在就必须是合法资源目录，且 `apiVersion` 精确等于
 * `packhub.dev/resources/v0`；文件不存在只给 warning，不阻断（没有资源目录的 registry 仍然合法）。
 *
 * 纯函数：输入是文件内容，不碰文件系统，正常 / 坏版本 / 缺文件三种情形都能直接测。
 * 结构校验复用 kernel 的 `parseCatalog`，与读端同一套规则，这里不另写一份。
 */
export function checkResourcesCatalog(text: string | undefined): ResourcesCatalogGate {
  if (text === undefined) {
    return { errors: [], warnings: ['resources.json 不存在：没有资源目录，跳过资源目录校验'] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (e) {
    return { errors: [`resources.json 不是合法 JSON：${(e as Error).message}`], warnings: [] };
  }
  const errors: string[] = [];
  const apiVersion =
    typeof raw === 'object' && raw !== null ? (raw as { apiVersion?: unknown }).apiVersion : undefined;
  if (apiVersion !== RESOURCES_API_VERSION) {
    errors.push(
      `resources.json: apiVersion 必须是 ${RESOURCES_API_VERSION}，实际是 ${String(apiVersion)}`,
    );
  }
  for (const issue of parseCatalog(raw).issues) {
    // 版本问题上面已经报过，别报两遍
    if (issue.code === 'catalog-version') continue;
    errors.push(`resources.json: [${issue.code}] ${issue.message}`);
  }
  return { errors, warnings: [] };
}

/**
 * 归档 ↔ 版本目录的语义一致：锁的 planHash、报告的 ok 与 planHash 相等。
 *
 * 只比语义，不比字节：归档与版本目录可能是不同工具写的（行尾、缩进不同），
 * 现有三个已发布归档的锁就与版本目录差在 CRLF 上——字节比会把它们全误报成「被改过」。
 */
function checkArchiveConsistency(
  packName: string,
  version: string,
  versionDir: string,
  archivePath: string,
  errors: string[],
): void {
  // 读归档走 runtime/pack.ts 的同步读法（node-tar 的 sync 解包），registry 不再自己解析 tar 格式
  let files: Map<string, string>;
  try {
    files = readArchiveFilesSync(archivePath, ['packhub.lock.json', 'verify.json']);
  } catch {
    errors.push(`${packName}@${version}: 读不了 ${version}.phub，无法核对归档里的锁与报告`);
    return;
  }

  const dirLock = parseJsonObject(readFileSync(join(versionDir, 'packhub.lock.json'), 'utf8'));
  const short = (value: unknown): string => String(value ?? '(无)').slice(0, 16);
  const archiveLockText = files.get('packhub.lock.json');
  if (archiveLockText === undefined) {
    errors.push(
      `${packName}@${version}: 归档里缺 packhub.lock.json（发布必须带锁，归档要从版本目录打）`,
    );
  } else {
    const archiveLock = parseJsonObject(archiveLockText);
    if (archiveLock?.planHash !== dirLock?.planHash) {
      errors.push(
        `${packName}@${version}: 归档里的锁与版本目录不一致（归档=${short(archiveLock?.planHash)}… 目录=${short(dirLock?.planHash)}…），从版本目录重打归档`,
      );
    }
  }

  const dirVerifyPath = join(versionDir, 'verify.json');
  if (!existsSync(dirVerifyPath)) return;
  const dirVerify = parseJsonObject(readFileSync(dirVerifyPath, 'utf8'));
  const archiveVerifyText = files.get('verify.json');
  if (archiveVerifyText === undefined) {
    errors.push(`${packName}@${version}: 归档里缺 verify.json（版本目录有报告，归档要带同一份）`);
    return;
  }
  const archiveVerify = parseJsonObject(archiveVerifyText);
  if (archiveVerify?.ok !== dirVerify?.ok || archiveVerify?.planHash !== dirVerify?.planHash) {
    errors.push(
      `${packName}@${version}: 归档里的 verify.json 与版本目录不一致（归档 ok=${String(archiveVerify?.ok)} planHash=${short(archiveVerify?.planHash)}… 目录 ok=${String(dirVerify?.ok)} planHash=${short(dirVerify?.planHash)}…）`,
    );
  }
}

/**
 * 扫描 registry/packs，校验并生成索引。
 * 门禁：schema、锁与计划一致、visibility=public、已发布版本不可变、verify 与计划一致才算 verified。
 */
export function buildIndex(registryRoot: string): BuildResult {
  const packsDir = join(registryRoot, 'packs');
  const errors: string[] = [];
  const warnings: string[] = [];
  const packs: IndexPack[] = [];

  const gitShowHead = (relPath: string): string | null => {
    try {
      // cwd 是 registry 根，路径必须相对它；`HEAD:packs/…` 会被 git 当成仓库根路径而失败。
      // 用 `HEAD:./` 明确「相对当前目录」，否则这项门禁会静默跳过。
      return execFileSync('git', ['show', `HEAD:./${relPath}`], {
        cwd: registryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };

  /** 二进制用字节比：`git show` 按 utf8 解码会毁掉归档。 */
  const gitShowHeadBytes = (relPath: string): Buffer | null => {
    try {
      return execFileSync('git', ['show', `HEAD:./${relPath}`], {
        cwd: registryRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };

  for (const scope of dirs(packsDir)) {
    for (const name of dirs(join(packsDir, scope))) {
      const packName = `${scope}/${name}`;
      const versionsDir = join(packsDir, scope, name);
      const versions = dirs(versionsDir).filter((v) => /^\d+\.\d+\.\d+/.test(v));
      if (versions.length === 0) {
        errors.push(`${packName}: 没有版本目录`);
        continue;
      }

      const entries: IndexEntry[] = [];
      for (const version of versions) {
        const dir = join(versionsDir, version);
        const manifestPath = join(dir, 'packhub.yaml');
        if (!existsSync(manifestPath)) {
          errors.push(`${packName}@${version}: 缺少 packhub.yaml`);
          continue;
        }

        // 版本目录里定义「发布了什么」的文件都不许改：清单、锁、验证报告、可选签名。
        // 没进 git（或非 git 仓库）时跳过——这项门禁只在有历史可比时才有意义。
        const norm = (s: string): string => s.replace(/\r\n/g, '\n');
        for (const file of ['packhub.yaml', 'packhub.lock.json', 'verify.json', SIGNATURE_FILE]) {
          const abs = join(dir, file);
          if (!existsSync(abs)) continue;
          const headText = gitShowHead(relative(registryRoot, abs).replaceAll('\\', '/'));
          if (headText === null) continue;
          if (norm(headText) !== norm(readFileSync(abs, 'utf8'))) {
            errors.push(`${packName}@${version}: 版本目录不可变，${file} 已被修改（改动要发新版本）`);
          }
        }

        // 归档也是发布内容：字节变了就说明版本被改过（按 utf8 读会毁掉二进制，所以单独走 buffer）
        const archive = join(versionsDir, `${version}.phub`);
        if (existsSync(archive)) {
          const headBytes = gitShowHeadBytes(relative(registryRoot, archive).replaceAll('\\', '/'));
          if (headBytes) {
            const digest = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
            if (digest(headBytes) !== digest(readFileSync(archive))) {
              errors.push(`${packName}@${version}: 版本目录不可变，${version}.phub 已被修改（改动要发新版本）`);
            }
          }
        }
        const ctx = loadPack(dir);
        for (const e of ctx.issues.filter((i) => i.severity === 'error')) {
          errors.push(`${packName}@${version}: [${e.code}] ${e.message}`);
        }
        if (!ctx.manifest) continue;

        const visibility = ctx.manifest.metadata.visibility ?? 'private';
        if (visibility !== 'public') {
          errors.push(
            `${packName}@${version}: visibility=${visibility}，公共 registry 只收 visibility: public`,
          );
        }

        const lockPath = join(dir, 'packhub.lock.json');
        if (!existsSync(lockPath)) {
          errors.push(`${packName}@${version}: 缺少 packhub.lock.json（发布必须带锁）`);
          continue;
        }
        const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
          planHash?: string;
          plan?: { target?: string; planHash?: string };
          resolved?: { id: string; source: string; integrity: string | null }[];
          plans?: Partial<Record<string, { target?: string; planHash?: string }>>;
        };
        // 归档与版本目录必须装的是同一份发布内容：归档里的锁 / 报告与目录里的语义一致
        if (existsSync(archive)) {
          checkArchiveConsistency(packName, version, dir, archive, errors);
        }
        // 按锁里钉死的 commit/版本算计划，否则「清单写 tag、锁写 commit」会被误判成过期
        const pinned = withLockPins(ctx, lock as unknown as LockFile);
        const { plan } = planFor(pinned);
        if (!plan) {
          errors.push(`${packName}@${version}: 生成计划失败`);
          continue;
        }
        if (lock.planHash !== plan.planHash) {
          errors.push(
            `${packName}@${version}: 锁已过期（lock=${String(lock.planHash).slice(0, 16)}… plan=${plan.planHash.slice(0, 16)}…），重跑 packhub lock`,
          );
        }
        // 多 target 锁：清单声明过的每个 target 都要在锁里有自己的快照，并与当前计划对得上。
        // 快照口径同 kernel 的 checkLockConsistency：`plans?.[target] ?? plan`——单 target 的锁
        // 不写 plans，主计划就是它自己的快照；但回落的快照必须真的属于这个 target，
        // 否则说明多 target 清单只锁了主计划，其它 target 装的时候没有可核对的基准。
        for (const target of ctx.manifest.metadata.targets) {
          const snapshot = lock.plans?.[target] ?? lock.plan;
          if (!snapshot || snapshot.target !== target) {
            errors.push(
              `${packName}@${version}: 锁里没有 ${target} 的计划快照（声明的 target 都要锁住），重跑 packhub lock`,
            );
            continue;
          }
          const { plan: targetPlan } = planFor(pinned, { target });
          if (!targetPlan) {
            errors.push(`${packName}@${version}: 生成 ${target} 计划失败`);
          } else if (targetPlan.planHash !== snapshot.planHash) {
            errors.push(
              `${packName}@${version}: ${target} 的计划与锁不一致（lock=${String(snapshot.planHash).slice(0, 16)}… plan=${targetPlan.planHash.slice(0, 16)}…），重跑 packhub lock`,
            );
          }
        }

        let trust: 'verified' | 'community' = 'community';
        let verifiedAt: string | null = null;
        let signers: string[] = [];
        const verifyPath = join(dir, 'verify.json');
        if (existsSync(verifyPath)) {
          const report = JSON.parse(readFileSync(verifyPath, 'utf8')) as {
            ok?: boolean;
            planHash?: string;
            verifiedAt?: string;
            signatures?: { key: string; ok: boolean }[];
          };
          signers = (report.signatures ?? []).filter((s) => s.ok).map((s) => s.key);
          if (report.ok === true && report.planHash === plan.planHash) {
            trust = 'verified';
            verifiedAt = report.verifiedAt ?? null;
          } else {
            warnings.push(
              `${packName}@${version}: 有 verify.json 但未通过或与当前计划不一致，按 community 处理`,
            );
          }
        }

        entries.push({
          version,
          manifest: ctx.manifest,
          planHash: plan.planHash,
          trust,
          verifiedAt,
          signers,
          manifestHash: sha256(canonicalize(ctx.manifest)),
        });
      }

      if (entries.length === 0) continue;

      const sorted = [...entries].sort((a, b) => (semverGreater(a.version, b.version) ? 1 : -1));
      const lead = sorted[sorted.length - 1]!;
      const meta = (
        lead.manifest as {
          metadata: {
            title?: string;
            name: string;
            description?: string;
            targets: string[];
            keywords?: string[];
            license?: string;
            homepage?: string;
            authors?: { name: string; url?: string }[];
          };
          resources: unknown[];
          requires?: { agent?: string };
        }
      ).metadata;
      const leadManifest = lead.manifest as { requires?: { agent?: string } };
      const allVerified = entries.every((e) => e.trust === 'verified');

      packs.push({
        name: packName,
        title: meta.title ?? meta.name,
        description: meta.description ?? '',
        latest: lead.version,
        versions: sorted.map((e) => e.version),
        targets: meta.targets,
        trust: allVerified ? 'verified' : 'community',
        verifiedAt: lead.verifiedAt,
        signers: lead.signers,
        keywords: meta.keywords ?? [],
        resourceCount: (lead.manifest as { resources: unknown[] }).resources.length,
        install: `packhub add ${packName}`,
        license: meta.license ?? null,
        homepage: meta.homepage ?? null,
        authors: meta.authors ?? [],
        requiresAgent: leadManifest.requires?.agent ?? null,
      });
    }
  }

  // 资源目录也是 registry 的一部分：存在就必须是 v0 且结构合法（坏版本让 check 失败），
  // 不存在只警告——没有资源目录的 registry 仍然合法。
  const resourcesPath = join(registryRoot, 'resources.json');
  const resourcesGate = checkResourcesCatalog(
    existsSync(resourcesPath) ? readFileSync(resourcesPath, 'utf8') : undefined,
  );
  errors.push(...resourcesGate.errors);
  warnings.push(...resourcesGate.warnings);

  return {
    index: { apiVersion: INDEX_API_VERSION, generatedAt: new Date().toISOString(), packs },
    errors,
    warnings,
  };
}

export interface WriteIndexResult {
  ok: boolean;
  path: string;
  packs: number;
}

/** 校验并写 registry/index.json；有错误就不写。 */
export function writeIndex(registryRoot: string, opts: { checkOnly?: boolean } = {}): WriteIndexResult {
  const { index, errors, warnings } = buildIndex(registryRoot);
  for (const w of warnings) console.warn(`warn  ${w}`);
  for (const e of errors) console.error(`error ${e}`);
  const path = join(registryRoot, 'index.json');
  if (errors.length > 0) return { ok: false, path, packs: index.packs.length };
  if (!opts.checkOnly) writeFileSync(path, JSON.stringify(index, null, 2) + '\n', 'utf8');
  return { ok: true, path, packs: index.packs.length };
}
