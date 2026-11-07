import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { canonicalize, loadPack, planFor, sha256, type LockFile } from '@packhub/kernel';
import { withLockPins } from '@packhub/runtime';

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
  apiVersion: 'packhub.dev/index/v0';
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

        const relManifest = relative(registryRoot, manifestPath).replaceAll('\\', '/');
        const headText = gitShowHead(relManifest);
        const norm = (s: string): string => s.replace(/\r\n/g, '\n');
        if (headText !== null && norm(headText) !== norm(readFileSync(manifestPath, 'utf8'))) {
          errors.push(`${packName}@${version}: 版本目录不可变，packhub.yaml 已被修改（应发新版本）`);
        }
        // verify.json 也是已发布内容：CI 复核应该写到临时位置，不能改版本目录的时间戳
        const verifyRel = relative(registryRoot, join(dir, 'verify.json')).replaceAll('\\', '/');
        const headVerify = gitShowHead(verifyRel);
        if (headVerify !== null && norm(headVerify) !== norm(readFileSync(join(dir, 'verify.json'), 'utf8'))) {
          errors.push(`${packName}@${version}: 版本目录不可变，verify.json 已被修改`);
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
          resolved?: { id: string; source: string; integrity: string | null }[];
          plans?: Partial<Record<string, { planHash?: string }>>;
        };
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
        // 多 target 锁：每个声明过的 target 都要和锁里的快照对得上
        for (const target of ctx.manifest.metadata.targets) {
          const expected = lock.plans?.[target]?.planHash;
          if (!expected) continue;
          const { plan: targetPlan } = planFor(pinned, { target });
          if (!targetPlan) {
            errors.push(`${packName}@${version}: 生成 ${target} 计划失败`);
          } else if (targetPlan.planHash !== expected) {
            errors.push(
              `${packName}@${version}: ${target} 的计划与锁不一致（lock=${String(expected).slice(0, 16)}… plan=${targetPlan.planHash.slice(0, 16)}…），重跑 packhub lock`,
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

  return {
    index: { apiVersion: 'packhub.dev/index/v0', generatedAt: new Date().toISOString(), packs },
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
