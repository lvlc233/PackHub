#!/usr/bin/env node
// 全量重锁：registry 里每个已发布版本按自己的版本目录重做一遍发布内容。
//
// 每个版本按顺序做（任何一步失败立刻非零退出，并说清哪个包、哪个版本、哪一步）：
//   1) lock     按版本目录重算锁（与 `packhub lock` 同一入口 lockPack；锁只记引用与完整性，
//              不再按 target 存计划快照）
//   2) sign     这个版本原来有签名就重签（需要 --key 或 PACKHUB_RELOCK_KEY）；没有签名跳过
//   3) verify   在干净目录里重跑 runner（真装 + 读校验），通过才写 verify.json
//   4) archive  从版本目录重打 .phub（与发布同一入口 packVersionArchive，vendored）
// 全部版本做完再重建 registry/index.json（唯一入口 buildIndex/writeIndex，不手写索引）。
//
// 原子性：1~3 步先在临时副本上做（新锁与新签名只写进副本），runner 通过后才落盘。
// 某个版本失败时，那个版本的目录与归档一个字节都没被改。
//
// 幂等：内容没变就不改写文件；锁的 resolvedAt、verify 的 verifiedAt、index 的 generatedAt
// 这些时间戳不参与「内容是否变了」的比较。所以第二次跑只重新核对、不动盘。
//
// 网络：lock 要解析远程引用（npm / github 归档哈希），verify 要真装（远程来源要能取到）。
// 本机取不到的版本用 --skip <scope/name@version> 显式跳过（会打印，不会静默跳过）。
//
// 版本目录相对 git HEAD 有改动时，index.json 这一步会被「版本目录不可变」门禁拦下
// （这是对已提交历史的保护，不是脚本缺陷）。流程是：先 --skip-index 跑完 → 提交版本目录 →
// 再跑 pnpm registry:index（或本脚本不带 --skip-index 再跑一遍，前四步会显示「不变」）。
//
// 用法：
//   pnpm registry:relock                                  # 全量：四个步骤 + 重建索引
//   pnpm registry:relock -- --skip-index                  # 只重做版本目录内容（提交前用）
//   pnpm registry:relock -- --key ./packhub.key
//   pnpm registry:relock -- --skip lvlc233/remote-demo@0.0.1
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { LOCK_FILE, PACKHUB_ENV, canonicalize, loadPack } from '../../packages/kernel/src/index.ts';
import {
  lockPack,
  readSignatures,
  signContentHash,
  writeSignature,
} from '../../packages/runtime/src/index.ts';
import { runPack } from '../../packages/runner/src/index.ts';
import { buildIndex, packVersionArchive, writeIndex } from '../../packages/registry/src/index.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const REGISTRY = join(ROOT, 'registry');
const PACKS = join(REGISTRY, 'packs');
const INDEX = join(REGISTRY, 'index.json');

const argv = process.argv.slice(2);
const SKIP_INDEX = argv.includes('--skip-index');
const skips = new Set();
let keyPath = process.env[PACKHUB_ENV.relockKey];
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (token === '--skip-index') continue;
  if (token === '--key') {
    keyPath = argv[++i];
    if (!keyPath) {
      console.error('--key 需要私钥 PEM 路径');
      process.exit(2);
    }
    continue;
  }
  if (token === '--skip') {
    const label = argv[++i];
    if (!label || !/^[a-z0-9-]+\/[a-z0-9-]+@\d+\.\d+\.\d+/.test(label)) {
      console.error('--skip 需要 scope/name@version，例如 --skip lvlc233/remote-demo@0.0.1');
      process.exit(2);
    }
    skips.add(label);
    continue;
  }
  console.error(`未知参数 ${token}（可用：--skip-index、--key <私有 PEM>、--skip <scope/name@version>）`);
  process.exit(2);
}
if (keyPath) keyPath = resolve(keyPath);

/** 一步失败就抛：顶层统一打印「哪个包哪个版本哪一步」，不做「跳过继续」。 */
class StepError extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}

function dirs(p) {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

/** 去掉指定时间戳字段后按规范化 JSON 比：只关心内容变没变。 */
function contentOf(value, timestamps) {
  return canonicalize(
    JSON.parse(JSON.stringify(value, (key, v) => (timestamps.includes(key) ? undefined : v))),
  );
}

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

function rel(p) {
  return relative(ROOT, p).replaceAll('\\', '/');
}

const stats = {
  versions: 0,
  skipped: [],
  lockChanged: [],
  lockSame: [],
  verifyChanged: [],
  verifySame: [],
  signed: [],
  skippedSign: [],
  archiveChanged: [],
  archiveSame: [],
};

/** 在临时副本上算出新锁；引用解析失败（warnings）不能静默写进锁。 */
async function computeLock(dir, label) {
  const ctx = loadPack(dir);
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) throw new StepError('lock', `清单有错误：${errors.map((e) => e.message).join('; ')}`);
  if (!ctx.manifest) throw new StepError('lock', '清单读不出来');

  const res = await lockPack(ctx);
  if (res.warnings.length > 0) {
    throw new StepError('lock', `有引用没解析出来（不能静默写进锁）：${res.warnings.join('; ')}`);
  }
  return res;
}

/** 有独立签名文件就重签（写进 stage）；清单内联签名要改清单，交给人工。 */
function resign(stageDir, realDir, label, contentHash, manifest) {
  const inline = manifest.signatures ?? [];
  if (inline.length > 0) {
    throw new StepError(
      'sign',
      '这个版本把签名写在清单里；本脚本不手写 YAML，先用 packhub sign 人工重签，再重跑本脚本',
    );
  }
  const entries = readSignatures(realDir);
  if (entries.length === 0) {
    stats.skippedSign.push(label);
    return;
  }
  if (!keyPath) {
    throw new StepError(
      'sign',
      `这个版本有 ${entries.length} 个签名要重签，但没给私钥：--key <路径> 或 ${PACKHUB_ENV.relockKey}`,
    );
  }
  if (!existsSync(keyPath)) throw new StepError('sign', `私钥文件不存在：${keyPath}`);
  const pem = readFileSync(keyPath, 'utf8');
  const pack = `${manifest.metadata.name}@${manifest.metadata.version}`;
  const signature = signContentHash(pem, pack, contentHash);
  if (!entries.some((s) => s.key === signature.key)) {
    throw new StepError(
      'sign',
      `私钥的公钥 id ${signature.key.slice(0, 12)}… 不在这个版本的签名里，拒绝换签名者`,
    );
  }
  writeSignature(stageDir, signature);
  stats.signed.push(`${label}（key ${signature.key.slice(0, 12)}…）`);
}

/** 序列化写文件（与 build-index / publish 的格式一致：两空格缩进 + 结尾换行）。 */
function jsonText(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

/** 前 1~3 步：在临时副本上重算锁 → 重签 → 跑 runner；通过后把变化落进真实目录。 */
async function rebuildVersion(dir, label) {
  const work = mkdtempSync(join(tmpdir(), 'packhub-relock-'));
  const stage = join(work, 'version');
  try {
    cpSync(dir, stage, { recursive: true });
    const planned = await computeLock(stage, label).catch((err) => {
      throw new StepError(`${label} · lock`, err.message);
    });

    // 新锁先只写副本：runner 看到的是重锁后的内容
    writeFileSync(join(stage, LOCK_FILE), jsonText(planned.lock), 'utf8');
    try {
      resign(stage, dir, label, planned.lock.contentHash, planned.manifest);
    } catch (err) {
      throw new StepError(`${label} · sign`, err.message);
    }

    let report;
    try {
      ({ report } = await runPack(stage));
    } catch (err) {
      throw new StepError(`${label} · verify`, err.message);
    }
    if (!report.ok) {
      const failed = report.outcomes.filter((o) => o.status !== 'done' && o.status !== 'noop');
      const badChecks = report.checks.filter((c) => c.status !== 'pass');
      throw new StepError(
        `${label} · verify`,
        'runner 未通过：' +
          (failed.map((o) => `${o.actionId}=${o.status}`).join('、') || '安装动作均完成') +
          (badChecks.length
            ? `；校验未过：${badChecks.map((c) => `[${c.index}] ${c.type} ${c.detail}`).join('、')}`
            : ''),
      );
    }

    // 到这里才动真实目录：锁、签名、verify.json
    const lockPath = join(dir, LOCK_FILE);
    const previous = readJson(lockPath);
    if (previous && contentOf(previous, ['resolvedAt']) === contentOf(planned.lock, ['resolvedAt'])) {
      stats.lockSame.push(label);
    } else {
      writeFileSync(lockPath, jsonText(planned.lock), 'utf8');
      stats.lockChanged.push(
        `${label}：contentHash ${String(previous?.contentHash ?? (previous ? '(无 contentHash)' : '(无锁)')).slice(0, 18)}… → ${planned.lock.contentHash.slice(0, 18)}…（${rel(lockPath)}）`,
      );
    }

    if (existsSync(join(stage, 'packhub.signatures.json'))) {
      cpSync(join(stage, 'packhub.signatures.json'), join(dir, 'packhub.signatures.json'));
    }

    const verifyPath = join(dir, 'verify.json');
    const previousVerify = readJson(verifyPath);
    if (previousVerify && contentOf(previousVerify, ['verifiedAt']) === contentOf(report, ['verifiedAt'])) {
      stats.verifySame.push(label);
    } else {
      writeFileSync(verifyPath, jsonText(report), 'utf8');
      stats.verifyChanged.push(label);
    }

    return {
      lockChanged: stats.lockChanged.some((s) => s.startsWith(label)),
      lockDetail: stats.lockChanged.find((s) => s.startsWith(label)),
      signChanged: stats.signed.some((s) => s.startsWith(label)),
      signDetail: stats.signed.find((s) => s.startsWith(label)),
      verifyChanged: stats.verifyChanged.includes(label),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** 4) 重打 .phub（从版本目录打，与 publish 同一入口）；逐字节没变就不覆盖。 */
async function repack(dir, label, archiveOut) {
  const work = mkdtempSync(join(tmpdir(), 'packhub-relock-pack-'));
  const tmp = join(work, 'out.phub');
  try {
    await packVersionArchive(dir, tmp);
    const next = readFileSync(tmp);
    const previous = existsSync(archiveOut) ? readFileSync(archiveOut) : undefined;
    const digest = (buf) => createHash('sha256').update(buf).digest('hex');
    if (previous && digest(previous) === digest(next)) {
      stats.archiveSame.push(label);
      return { changed: false };
    }
    cpSync(tmp, archiveOut);
    const detail = `${label}：${previous?.length ?? 0} → ${next.length} 字节（${rel(archiveOut)}）`;
    stats.archiveChanged.push(detail);
    return { changed: true, detail };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const versions = [];
  for (const scope of dirs(PACKS)) {
    for (const name of dirs(join(PACKS, scope))) {
      for (const version of dirs(join(PACKS, scope, name))) {
        if (!/^\d+\.\d+\.\d+/.test(version)) continue;
        versions.push({ scope, name, version });
      }
    }
  }
  if (versions.length === 0) {
    console.log('registry 里没有可重锁的版本');
    return;
  }
  for (const label of skips) {
    if (!versions.some(({ scope, name, version }) => `${scope}/${name}@${version}` === label)) {
      throw new StepError('skip', `--skip 的版本在 registry 里不存在：${label}`);
    }
  }

  for (const { scope, name, version } of versions) {
    const label = `${scope}/${name}@${version}`;
    const dir = join(PACKS, scope, name, version);
    const archiveOut = join(PACKS, scope, name, `${version}.phub`);
    stats.versions++;
    if (skips.has(label)) {
      stats.skipped.push(label);
      console.log(`\nskip  ${label}：--skip 显式跳过，未动任何文件`);
      continue;
    }
    console.log(`\n→ ${label}`);

    const res = await rebuildVersion(dir, label);
    console.log(`  lock      ${res.lockChanged ? res.lockDetail : '内容未变，保留原锁'}`);
    console.log(`  sign      ${res.signChanged ? res.signDetail : '这个版本没有签名，跳过'}`);
    console.log(
      `  verify    ${res.verifyChanged ? '通过，verify.json 已更新' : '通过，verify.json 内容未变'}`,
    );

    const archive = await repack(dir, label, archiveOut).catch((err) => {
      throw new StepError(`${label} · archive`, err.message);
    });
    console.log(
      `  archive   ${archive.changed ? archive.detail : `${version}.phub 字节未变，保留原归档`}`,
    );
  }

  if (SKIP_INDEX) {
    console.log('\nindex      --skip-index：跳过索引重建（提交版本目录后跑 pnpm registry:index）');
  } else {
    const { index, errors, warnings } = buildIndex(REGISTRY);
    for (const w of warnings) console.warn(`warn  ${w}`);
    for (const e of errors) console.error(`error ${e}`);
    if (errors.length > 0) {
      const immutable = errors.some((e) => e.includes('版本目录不可变'));
      throw new StepError(
        'index',
        `${errors.length} 个错误，索引未写入（脚本不会手写 index.json）` +
          (immutable
            ? '；其中含「版本目录不可变」：这批 relock 还没提交，先提交版本目录再跑 pnpm registry:index'
            : ''),
      );
    }
    const previous = readJson(INDEX);
    if (previous && contentOf(previous, ['generatedAt']) === contentOf(index, ['generatedAt'])) {
      console.log('\nindex      内容未变，保留原索引');
    } else {
      const written = writeIndex(REGISTRY);
      if (!written.ok) throw new StepError('index', '索引门禁未通过，索引未写入');
      console.log(`\nindex      已重建 ${rel(written.path)}：${written.packs} 个包`);
    }
  }

  console.log(
    `\n${stats.versions} 个版本：锁改写 ${stats.lockChanged.length}、锁未变 ${stats.lockSame.length}；` +
      `verify 改写 ${stats.verifyChanged.length}、未变 ${stats.verifySame.length}；` +
      `重签 ${stats.signed.length}、无签名 ${stats.skippedSign.length}；` +
      `归档改写 ${stats.archiveChanged.length}、未变 ${stats.archiveSame.length}；` +
      `显式跳过 ${stats.skipped.length}${stats.skipped.length ? `（${stats.skipped.join('、')}）` : ''}`,
  );
}

main().catch((err) => {
  if (err instanceof StepError) {
    console.error(`\nx ${err.step}: ${err.message}`);
  } else {
    console.error(`\nx ${err?.stack ?? err}`);
  }
  process.exitCode = 1;
});
