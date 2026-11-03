#!/usr/bin/env node
// 扫描 registry/packs，校验并生成 registry/index.json。
// 用法：node --experimental-strip-types scripts/registry/build-index.mjs [--check]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadPack, planFor, canonicalize, sha256 } from '../../packages/core/src/index.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const PACKS = join(ROOT, 'registry/packs');
const OUT = join(ROOT, 'registry/index.json');
const CHECK = process.argv.includes('--check');

const errors = [];
const warnings = [];
const packs = [];

function dirs(p) {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

function gitShowHead(relPath) {
  try {
    return execFileSync('git', ['show', `HEAD:${relPath}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // 新文件，HEAD 里还没有
  }
}

function semverGreater(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

for (const scope of dirs(PACKS)) {
  for (const name of dirs(join(PACKS, scope))) {
    const packName = `${scope}/${name}`;
    const versionsDir = join(PACKS, scope, name);
    const versions = dirs(versionsDir).filter((v) => /^\d+\.\d+\.\d+/.test(v));
    if (versions.length === 0) {
      errors.push(`${packName}: 没有版本目录`);
      continue;
    }

    const entries = [];
    for (const version of versions) {
      const dir = join(versionsDir, version);
      const manifestPath = join(dir, 'packhub.yaml');
      const relManifest = relative(ROOT, manifestPath).replaceAll('\\', '/');
      if (!existsSync(manifestPath)) {
        errors.push(`${packName}@${version}: 缺少 packhub.yaml`);
        continue;
      }

      // 不可变：已存在的版本目录，manifest 不许变
      const headText = gitShowHead(relManifest);
      const currentText = readFileSync(manifestPath, 'utf8');
      const norm = (s) => s.replace(/\r\n/g, '\n');
      if (headText !== null && norm(headText) !== norm(currentText)) {
        errors.push(`${packName}@${version}: 版本目录不可变，packhub.yaml 已被修改（应发新版本）`);
      }

      const ctx = loadPack(dir);
      const errs = ctx.issues.filter((i) => i.severity === 'error');
      for (const e of errs) errors.push(`${packName}@${version}: [${e.code}] ${e.message}`);
      if (!ctx.manifest) continue;

      const lockPath = join(dir, 'packhub.lock.json');
      if (!existsSync(lockPath)) {
        errors.push(`${packName}@${version}: 缺少 packhub.lock.json（发布必须带锁）`);
        continue;
      }
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      const { plan } = planFor(ctx);
      if (!plan) {
        errors.push(`${packName}@${version}: 生成计划失败`);
        continue;
      }
      if (lock.planHash !== plan.planHash) {
        errors.push(`${packName}@${version}: 锁已过期（lock=${lock.planHash.slice(0, 16)}… plan=${plan.planHash.slice(0, 16)}…），重跑 packhub lock`);
      }

      let trust = 'community';
      let verifiedAt = null;
      const verifyPath = join(dir, 'verify.json');
      if (existsSync(verifyPath)) {
        const report = JSON.parse(readFileSync(verifyPath, 'utf8'));
        if (report.ok === true && report.planHash === plan.planHash) {
          trust = 'verified';
          verifiedAt = report.verifiedAt ?? null;
        } else {
          warnings.push(`${packName}@${version}: 有 verify.json 但未通过或与当前计划不一致，按 community 处理`);
        }
      }

      entries.push({
        version,
        manifest: ctx.manifest,
        planHash: plan.planHash,
        trust,
        verifiedAt,
        manifestHash: sha256(canonicalize(ctx.manifest)),
      });
    }

    if (entries.length === 0) continue;

    const latest = entries.map((e) => e.version).sort((a, b) => (semverGreater(a, b) ? 1 : -1)).at(-1);
    const lead = entries.find((e) => e.version === latest);
    const allVerified = entries.every((e) => e.trust === 'verified');
    const m = lead.manifest.metadata;

    packs.push({
      name: packName,
      title: m.title ?? m.name,
      description: m.description ?? '',
      latest,
      versions: entries.map((e) => e.version).sort((a, b) => (semverGreater(a, b) ? 1 : -1)),
      targets: m.targets,
      trust: allVerified ? 'verified' : 'community',
      verifiedAt: lead.verifiedAt,
      keywords: m.keywords ?? [],
      resourceCount: lead.manifest.resources.length,
      install: `npx packhub add ${packName}`,
    });
  }
}

const index = {
  apiVersion: 'packhub.dev/index/v0',
  generatedAt: new Date().toISOString(),
  packs,
};

for (const w of warnings) console.warn(`warn  ${w}`);
for (const e of errors) console.error(`error ${e}`);

if (errors.length > 0) {
  console.error(`\nregistry: ${errors.length} 个错误，索引未写入。`);
  process.exit(1);
}

if (CHECK) {
  console.log(`registry ok：${packs.length} 个包，${packs.reduce((n, p) => n + p.versions.length, 0)} 个版本`);
} else {
  writeFileSync(OUT, JSON.stringify(index, null, 2) + '\n', 'utf8');
  console.log(`written ${relative(ROOT, OUT).replaceAll('\\', '/')}：${packs.length} 个包`);
}
