import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadPack } from '@packhub/kernel';
import { lockPack, packArchive } from '@packhub/runtime';
import { runPack, type VerifyReport } from '@packhub/runner';

export interface PublishOptions {
  registry: string;
  /** 只打印将写入什么，不落盘 */
  dryRun?: boolean;
  /** 写到另一个目录（PR 模式：只产出要提交的那部分） */
  out?: string;
  /** 允许覆盖已存在的版本目录（默认拒绝：已发布版本不可变） */
  force?: boolean;
  /** 不联网解析引用（CI 没网时用；锁里会保留未解析的引用） */
  offline?: boolean;
  /** 允许 runner 执行清单里的 install.exec（默认不执行） */
  allowExec?: boolean;
  log?: (line: string) => void;
}

export interface PublishResult {
  name: string;
  version: string;
  /** 版本目录（registry 里或 --out 指的地方） */
  dir: string;
  report: VerifyReport;
  wrote: string[];
}

const FILES = ['packhub.yaml', 'packhub.lock.json', 'packhub.signatures.json', 'PACK.md', 'CHANGELOG.md'];

/**
 * 发布一个包：先跑 runner（干净安装 + 校验），再把版本目录与 .phub 写进 registry。
 * 校验不过就不发布——这是 "发布即验证" 的唯一入口。
 */
export async function publishPack(packDir: string, opts: PublishOptions): Promise<PublishResult> {
  const log = opts.log ?? (() => {});
  const dir = resolve(packDir);
  const registryRoot = resolve(opts.out ?? opts.registry);

  const ctx = loadPack(dir);
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`清单有问题，不能发布：${errors.map((e) => e.message).join('; ')}`);
  }
  const name = ctx.manifest.metadata.name;
  const version = ctx.manifest.metadata.version;
  const [scope] = name.split('/');
  if (!name.includes('/') || !scope) throw new Error(`包名必须是 scope/name：${name}`);

  const versionDir = join(registryRoot, 'packs', scope, name.split('/')[1]!, version);
  if (existsSync(versionDir) && !opts.force) {
    throw new Error(`版本目录已存在：${versionDir}（已发布版本不可变；要发新版本请改 metadata.version）`);
  }

  // 1) 干净环境跑一遍
  const { report } = await runPack(dir, { log, allowExec: opts.allowExec === true });
  if (!report.ok) {
    throw new Error('干净安装或校验未通过，已阻止发布（先修问题，别发布一个装不上的包）');
  }

  // 2) 解析引用并生成/刷新锁，保证 registry 里的锁与计划一致
  const { lock, warnings } = await lockPack(ctx, { target: 'dir', offline: opts.offline === true });
  for (const w of warnings) log(`warn ${w}`);
  if (report.planHash !== lock.planHash) {
    throw new Error(
      'runner 装出来的计划与解析后的锁不一致：先跑 `packhub lock` 把引用钉死（或检查清单是否在锁定后又改过），再发布',
    );
  }

  const wrote: string[] = [];
  if (!opts.dryRun) {
    mkdirSync(versionDir, { recursive: true });
    for (const file of FILES) {
      const src = join(dir, file);
      if (!existsSync(src)) continue;
      writeFileSync(join(versionDir, file), readFileSync(src));
      wrote.push(file);
    }
    // vendored 资源也要进版本目录：清单、锁、报告都在这里，别人克隆 registry 后能直接复核
    for (const sub of ['resources', 'fragments', 'overrides', 'skills', 'glue']) {
      const src = join(dir, sub);
      if (!existsSync(src)) continue;
      cpSync(src, join(versionDir, sub), { recursive: true });
      wrote.push(`${sub}/`);
    }
    writeFileSync(join(versionDir, 'packhub.lock.json'), JSON.stringify(lock, null, 2) + '\n', 'utf8');
    wrote.push('packhub.lock.json');
    writeFileSync(join(versionDir, 'verify.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    wrote.push('verify.json');

    // 3) 归档（vendored，离线可装）
    const archive = join(registryRoot, 'packs', scope, name.split('/')[1]!, `${version}.phub`);
    await packArchive(dir, { vendored: true, out: archive });
    wrote.push(`${version}.phub`);
  } else {
    wrote.push(...FILES.filter((f) => existsSync(join(dir, f))), 'packhub.lock.json', 'verify.json');
  }

  for (const w of wrote) log(`→ ${w}`);
  return { name, version, dir: versionDir, report, wrote };
}

/** PR 模式：把要提交的文件复制到一个干净目录，方便直接开分支。 */
export function stageForPr(packDir: string, registryRoot: string, outDir: string): string[] {
  const ctx = loadPack(packDir);
  const name = ctx.manifest.metadata.name;
  const version = ctx.manifest.metadata.version;
  const [scope] = name.split('/');
  const rel = join('packs', scope!, name.split('/')[1]!, version);
  const target = join(outDir, rel);
  mkdirSync(target, { recursive: true });
  for (const file of ['packhub.yaml', 'packhub.lock.json', 'packhub.signatures.json', 'verify.json']) {
    const src = join(registryRoot, rel, file);
    if (existsSync(src)) cpSync(src, join(target, file));
  }
  const archive = join(registryRoot, 'packs', scope!, name.split('/')[1]!, `${version}.phub`);
  if (existsSync(archive)) cpSync(archive, join(outDir, 'packs', scope!, name.split('/')[1]!, `${version}.phub`));
  return [rel];
}
