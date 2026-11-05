import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLock,
  buildPlan,
  parseSource,
  validateGraph,
  type LockFile,
  type Manifest,
  type PackContext,
  type Plan,
} from '@packhub/kernel';
import { download, httpJson, resolvePypiSdist } from './download.ts';

/** 一个引用解析后的样子：可复现的 source + 字节哈希（拿不到就是 null）。 */
export interface ResolvedReference {
  id: string;
  source: string;
  integrity: string | null;
}

export interface ResolveOptions {
  /** 不联网：只处理本地引用与已有 pin，其余保留原样并给 warning */
  offline?: boolean;
  /** 测试注入：npm 元数据 */
  npmMeta?: (name: string, version: string) => Promise<{ version: string; integrity?: string }>;
  /** 测试注入：git ls-remote */
  lsRemote?: (repoUrl: string, ref: string) => string | null;
  /** 测试注入：下载并算哈希 */
  hashUrl?: (url: string) => Promise<string>;
  /** 是否在 lock 时为 github 归档算 sha256（默认算；大仓库会多一次下载） */
  hashGithub?: boolean;
  /** 测试注入：PyPI sdist */
  pypi?: (name: string, version: string) => Promise<{ url: string; version: string; sha256?: string }>;
}

export interface ResolveReport {
  resolved: ResolvedReference[];
  warnings: string[];
}

const SHA40 = /^[0-9a-f]{40}$/i;
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 支持 ^ / ~ / 精确版本；其它形态（含 ||、>*）不猜，交给 npm 自己报错。 */
function pickVersion(versions: string[], range: string): string | undefined {
  const want = range.trim();
  const target = parseSemver(want.replace(/^[\^~]/, ''));
  if (!target) return undefined;
  const op = want.startsWith('^') ? '^' : want.startsWith('~') ? '~' : '=';
  const candidates = versions
    .map((v) => ({ v, s: parseSemver(v) }))
    .filter((x): x is { v: string; s: [number, number, number] } => x.s !== null)
    .filter(({ s }) => {
      const [ma, mi, pa] = target;
      if (op === '=') return s[0] === ma && s[1] === mi && s[2] === pa;
      if (op === '~') return s[0] === ma && s[1] === mi && s[2] >= pa;
      // ^：主版本非 0 时只认同主版本；0.x 时认同 minor（semver 的 caret 规则简化版）
      return ma > 0 ? s[0] === ma && (s[1] > mi || (s[1] === mi && s[2] >= pa)) : s[0] === 0 && s[1] === mi && s[2] >= pa;
    })
    .sort((a, b) => (a.s[0] - b.s[0]) || (a.s[1] - b.s[1]) || (a.s[2] - b.s[2]));
  return candidates.at(-1)?.v;
}

async function defaultNpmMeta(name: string, version: string): Promise<{ version: string; integrity?: string }> {
  const encodedVersion = encodeURIComponent(version);
  const single = await httpJson<{ version?: string; dist?: { integrity?: string } }>(
    `https://registry.npmjs.org/${name}/${encodedVersion}`,
    { accept: 'application/json' },
  ).catch(() => null);
  if (single?.version) {
    return { version: single.version, ...(single.dist?.integrity ? { integrity: single.dist.integrity } : {}) };
  }

  // 标签或范围：取缩略 packument 自己挑最高满足版本
  const data = await httpJson<{
    'dist-tags'?: Record<string, string>;
    versions?: Record<string, { dist?: { integrity?: string } }>;
  }>(`https://registry.npmjs.org/${name}`, { accept: 'application/vnd.npm.install-v1+json' });
  const tagged = data['dist-tags']?.[version];
  if (tagged) {
    return {
      version: tagged,
      ...(data.versions?.[tagged]?.dist?.integrity
        ? { integrity: data.versions[tagged]!.dist!.integrity }
        : {}),
    };
  }
  const picked = EXACT.test(version) ? version : pickVersion(Object.keys(data.versions ?? {}), version);
  if (!picked || !data.versions?.[picked]) throw new Error(`npm 找不到版本：${name}@${version}`);
  return {
    version: picked,
    ...(data.versions[picked]?.dist?.integrity
      ? { integrity: data.versions[picked]!.dist!.integrity }
      : {}),
  };
}

function defaultLsRemote(repoUrl: string, ref: string): string | null {
  const candidates = ref === 'HEAD' ? ['HEAD'] : [`refs/tags/${ref}`, `refs/heads/${ref}`, ref];
  for (const candidate of candidates) {
    try {
      const out = execFileSync('git', ['ls-remote', '--exit-code', repoUrl, candidate], {
        encoding: 'utf8',
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }).trim();
      const sha = out.split(/\r?\n/)[0]?.split(/\s+/)[0];
      if (sha && SHA40.test(sha)) return sha.toLowerCase();
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

async function defaultHashUrl(url: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-hash-'));
  try {
    const res = await download(url, join(dir, 'blob'));
    return res.integrity;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 把清单里的引用解析成可复现的形态：
 * npm 范围/tag → 具体版本 + dist.integrity；github 分支/tag → commit；
 * https 单文件 → 下载后 sha256；pypi → sdist 的 sha256。
 * 解析不了就保留原样并给 warning——不假装锁住了。
 */
export async function resolveReferences(
  manifest: Manifest,
  opts: ResolveOptions = {},
): Promise<ResolveReport> {
  const npmMeta = opts.npmMeta ?? defaultNpmMeta;
  const lsRemote = opts.lsRemote ?? defaultLsRemote;
  const hashUrl = opts.hashUrl ?? defaultHashUrl;
  const pypi = opts.pypi ?? ((name: string, version: string) => resolvePypiSdist(`pypi:${name}@${version}`));

  const resolved: ResolvedReference[] = [];
  const warnings: string[] = [];

  for (const res of manifest.resources) {
    const keep = (): ResolvedReference => ({
      id: res.id,
      source: res.source,
      integrity: res.integrity ?? null,
    });

    let parsed;
    try {
      parsed = parseSource(res.source);
    } catch (err) {
      warnings.push(`${res.id}: ${(err as Error).message}`);
      resolved.push(keep());
      continue;
    }

    if (parsed.kind === 'local') {
      resolved.push(keep());
      continue;
    }
    if (parsed.kind === 'packhub') {
      warnings.push(`${res.id}: packhub:// 引用还没有下载实现，保留原样`);
      resolved.push(keep());
      continue;
    }
    if (opts.offline) {
      warnings.push(`${res.id}: --offline，未解析 ${parsed.kind} 引用`);
      resolved.push(keep());
      continue;
    }

    try {
      if (parsed.kind === 'http') {
        const integrity = res.integrity ?? (await hashUrl(res.source));
        resolved.push({ id: res.id, source: res.source, integrity });
        continue;
      }

      if (parsed.kind === 'npm') {
        const pin = parsed.pin;
        const meta = await npmMeta(parsed.locator.replace(/^npm:/, ''), pin ?? 'latest');
        resolved.push({
          id: res.id,
          source: `npm:${parsed.locator.replace(/^npm:/, '')}@${meta.version}`,
          integrity: res.integrity ?? meta.integrity ?? null,
        });
        continue;
      }

      if (parsed.kind === 'github') {
        const repo = parsed.locator.replace(/^github:/, '');
        let sha = parsed.pin;
        if (!sha || !SHA40.test(sha)) {
          const found = lsRemote(`https://github.com/${repo}`, sha ?? 'HEAD');
          if (!found) {
            warnings.push(`${res.id}: 解析不到 ${sha ?? 'HEAD'} 对应的 commit（网络或仓库不可达）`);
            resolved.push(keep());
            continue;
          }
          sha = found;
        }
        // 有了 commit 就能算归档字节哈希：github 的 tar.gz 不再是 integrity: null
        let integrity = res.integrity ?? null;
        if (!integrity && opts.hashGithub !== false) {
          try {
            integrity = await hashUrl(`https://codeload.github.com/${repo}/tar.gz/${sha}`);
          } catch (err) {
            warnings.push(`${res.id}: github 归档哈希算不出来（${(err as Error).message}），锁里留 null`);
          }
        }
        const subpath = parsed.subpath ? `/${parsed.subpath}` : '';
        resolved.push({ id: res.id, source: `github:${repo}${subpath}@${sha}`, integrity });
        continue;
      }

      if (parsed.kind === 'pypi') {
        if (!parsed.pin) {
          warnings.push(`${res.id}: pypi 引用必须 pin 版本`);
          resolved.push(keep());
          continue;
        }
        const sdist = await pypi(parsed.locator.replace(/^pypi:/, ''), parsed.pin);
        const integrity = res.integrity
          ?? (sdist.sha256 ? `sha256-${Buffer.from(sdist.sha256, 'hex').toString('base64')}` : null);
        resolved.push({ id: res.id, source: `pypi:${parsed.locator.replace(/^pypi:/, '')}@${sdist.version}`, integrity });
        continue;
      }
    } catch (err) {
      warnings.push(`${res.id}: ${(err as Error).message}`);
    }
    resolved.push(keep());
  }

  return { resolved, warnings };
}

/** 把解析结果写回清单（source/integrity），用于生成锁与按锁安装。 */
export function pinManifest(manifest: Manifest, resolved: ResolvedReference[]): Manifest {
  const byId = new Map(resolved.map((r) => [r.id, r]));
  return {
    ...manifest,
    resources: manifest.resources.map((res) => {
      const hit = byId.get(res.id);
      if (!hit) return res;
      return {
        ...res,
        source: hit.source,
        ...(hit.integrity ? { integrity: hit.integrity } : {}),
      };
    }),
  };
}

export interface LockPackOptions extends ResolveOptions {
  target?: 'dir' | 'dsh' | 'claude-code';
}

export interface LockPackResult {
  lock: LockFile;
  /** 按解析结果改过的清单 */
  manifest: Manifest;
  plan: Plan;
  warnings: string[];
}

/**
 * 解析引用 → 生成锁。计划也基于解析后的清单算，锁里的 planHash 才能指导安装。
 */
export async function lockPack(ctx: PackContext, opts: LockPackOptions = {}): Promise<LockPackResult> {
  const report = await resolveReferences(ctx.manifest, opts);
  const manifest = pinManifest(ctx.manifest, report.resolved);
  const { graph, issues } = validateGraph(manifest);
  // 「未 pin」正是解析要解决的问题；解析不到的已经在 warnings 里，锁里记为 null。
  // 其余结构性问题仍然拒绝。
  const errors = issues.filter(
    (i) =>
      i.severity === 'error' &&
      i.code !== 'unpinned-source' &&
      i.code !== 'http-missing-integrity',
  );
  if (errors.length > 0) {
    throw new Error(`解析后的清单不合法：${errors.map((e) => e.message).join('; ')}`);
  }
  const { plan, issues: planIssues } = buildPlan(manifest, graph, {
    target: opts.target ?? 'dir',
    targetVars: {},
  });
  if (!plan) throw new Error(`生成计划失败：${planIssues.map((i) => i.message).join('; ')}`);
  return {
    lock: buildLock(manifest, plan, { resolved: report.resolved }),
    manifest,
    plan,
    warnings: report.warnings,
  };
}
