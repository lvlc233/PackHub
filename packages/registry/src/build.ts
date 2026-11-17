import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  INDEX_API_VERSION,
  canonicalize,
  contentHashOf,
  loadPack,
  parseCatalog,
  sha256,
  type ResolvedRef,
  type ResourceCatalog,
} from '@packhub/kernel';
import { SIGNATURE_FILE, readArchiveFilesSync } from '@packhub/runtime';

export interface IndexEntry {
  version: string;
  manifest: unknown;
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
 * 归档 ↔ 版本目录的语义一致：锁的 `contentHash`、报告的 `ok` 与 `contentHash` 相等。
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
    if (archiveLock?.contentHash !== dirLock?.contentHash) {
      errors.push(
        `${packName}@${version}: 归档里的锁与版本目录不一致（归档=${short(archiveLock?.contentHash)}… 目录=${short(dirLock?.contentHash)}…），从版本目录重打归档`,
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
  if (archiveVerify?.ok !== dirVerify?.ok || archiveVerify?.contentHash !== dirVerify?.contentHash) {
    errors.push(
      `${packName}@${version}: 归档里的 verify.json 与版本目录不一致（归档 ok=${String(archiveVerify?.ok)} contentHash=${short(archiveVerify?.contentHash)}… 目录 ok=${String(dirVerify?.ok)} contentHash=${short(dirVerify?.contentHash)}…）`,
    );
  }
}

/**
 * CI 判定：GitHub Actions 把 `CI` 设成 `true`；空串 / `0` / `false` 当作没设。
 * 调用时才读环境变量（不在模块加载时固化），测试才能按场景切。
 */
function inCI(): boolean {
  const flag = process.env.CI;
  return flag !== undefined && flag !== '' && flag !== '0' && flag.toLowerCase() !== 'false';
}

/**
 * 扫描 registry/packs，校验并生成索引。
 * 门禁：schema、锁与内容（contentHash）一致、visibility=public、已发布版本不可变、
 * verify 报告绑定同一份内容才算 verified。
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

  /**
   * 取不到 HEAD 里的那份文件时，不可变性核对等于没做：本地允许（未提交的新版本、非 git 目录），
   * 但必须留下路径。CI 里改成 error——CI 全绿必须能推出「版本没被改过」。
   * 版本目录里不存在的文件不进来（没有的东西谈不上被改）。
   */
  const reportSkippedImmutability = (where: string, relPath: string): void => {
    const detail = `取不到 git 历史，${relPath} 的不可变性核对没有做`;
    if (inCI()) errors.push(`${where}: ${detail}（CI 里不允许跳过）`);
    else warnings.push(`${where}: ${detail}（本地允许，未提交的新版本）`);
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
        // 没进 git（或非 git 仓库）时跳过——但跳过必须留痕：本地 warning 带路径，CI 里算错误。
        const norm = (s: string): string => s.replace(/\r\n/g, '\n');
        for (const file of ['packhub.yaml', 'packhub.lock.json', 'verify.json', SIGNATURE_FILE]) {
          const abs = join(dir, file);
          if (!existsSync(abs)) continue;
          const relPath = relative(registryRoot, abs).replaceAll('\\', '/');
          const headText = gitShowHead(relPath);
          if (headText === null) {
            reportSkippedImmutability(`${packName}@${version}`, relPath);
            continue;
          }
          if (norm(headText) !== norm(readFileSync(abs, 'utf8'))) {
            errors.push(`${packName}@${version}: 版本目录不可变，${file} 已被修改（改动要发新版本）`);
          }
        }

        // 归档也是发布内容：字节变了就说明版本被改过（按 utf8 读会毁掉二进制，所以单独走 buffer）
        const archive = join(versionsDir, `${version}.phub`);
        if (existsSync(archive)) {
          const relPath = relative(registryRoot, archive).replaceAll('\\', '/');
          const headBytes = gitShowHeadBytes(relPath);
          if (headBytes === null) {
            reportSkippedImmutability(`${packName}@${version}`, relPath);
          } else {
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
          contentHash?: string;
          resolved?: ResolvedRef[];
        };
        // 归档与版本目录必须装的是同一份发布内容：归档里的锁 / 报告与目录里的语义一致
        if (existsSync(archive)) {
          checkArchiveConsistency(packName, version, dir, archive, errors);
        }
        // 锁只描述内容：重算 contentHash（清单 + 锁的 resolved），与目标无关。
        // 旧口径的锁没有 contentHash，按过期处理，提示重锁。
        const actual = contentHashOf(ctx.manifest, lock.resolved ?? []);
        if (typeof lock.contentHash !== 'string') {
          errors.push(
            `${packName}@${version}: 锁是旧口径（没有 contentHash），重跑 packhub lock 再发布`,
          );
        } else if (lock.contentHash !== actual) {
          errors.push(
            `${packName}@${version}: 锁已过期（lock=${lock.contentHash.slice(0, 16)}… content=${actual.slice(0, 16)}…），重跑 packhub lock`,
          );
        }

        let trust: 'verified' | 'community' = 'community';
        let verifiedAt: string | null = null;
        let signers: string[] = [];
        const verifyPath = join(dir, 'verify.json');
        if (existsSync(verifyPath)) {
          const report = JSON.parse(readFileSync(verifyPath, 'utf8')) as {
            ok?: boolean;
            contentHash?: string;
            verifiedAt?: string;
            signatures?: { key: string; ok: boolean }[];
          };
          signers = (report.signatures ?? []).filter((s) => s.ok).map((s) => s.key);
          // 报告绑定的是内容：只有 ok 且跑的是锁住的这份内容，才算 verified
          if (report.ok === true && report.contentHash === actual) {
            trust = 'verified';
            verifiedAt = report.verifiedAt ?? null;
          } else {
            warnings.push(
              `${packName}@${version}: 有 verify.json 但未通过或与当前内容不一致，按 community 处理`,
            );
          }
        }

        entries.push({
          version,
          manifest: ctx.manifest,
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
