// pal clone / migrate / export / import / backup / restore：搬运。
// 只读的 scan 与 leftovers 已并进 flags（adopt --scan / health --leftovers），
// 实现在这里，由命令层调用，输出与原来一致。
import { defineCommand } from 'citty';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { cloneInstance, exportTemplate, migrateInstance, writeTemplate } from '../index.ts';
import { importFromFile } from '../service.ts';
import { backupInstance, restoreBackup } from '../backup.ts';
import { archiveRoot, failedRoot, instancesRoot, quarantineRoot } from '../paths.ts';
import { scanDirectory, DEFAULT_SCAN_DEPTH, type ScanEntry } from '../scan.ts';
import { assertExternalRoot } from '../validators.ts';
import { PalError } from '../errors.ts';
import { requireTarget } from './shared.ts';

/* ---------- 只读扫描（adopt --scan） ---------- */

function scanLine(entry: ScanEntry): string {
  const head = `${entry.kind}\t${entry.dir}`;
  if (entry.broken) return `${head}\tbroken\t${entry.problem ?? '记录读不了'}`;
  if (entry.kind === 'environment') {
    const line = `${head}\t${entry.packs ?? 0} 个 pack`;
    return entry.problem ? `${line}\t! ${entry.problem}` : line;
  }
  const parts = [head];
  parts.push(entry.name ? (entry.version ? `${entry.name}@${entry.version}` : entry.name) : '-');
  if (entry.harness) parts.push(`harness=${entry.harness}`);
  if (entry.pack) parts.push(`pack=${entry.pack.name}@${entry.pack.version || '?'}`);
  if (entry.problem) parts.push(`! ${entry.problem}`);
  return parts.join('\t');
}

/**
 * 只读扫描一个目录并打印结果（原 pal scan 的实现）。
 * 不写盘、不接管；`dir` 由调用方给（adopt --scan 不写位置参数时传当前目录）。
 */
export function printScan(dir: string, options: { depth: string; json: boolean }): void {
  const depth = Number(options.depth);
  if (!Number.isInteger(depth) || depth < 0) {
    throw new PalError('invalid-input', `--depth 要 0 或正整数，收到：${options.depth}`, {
      hint: '目录本身算第 0 层；默认 2，表示再看两层子目录',
    });
  }
  const target = resolve(dir);
  if (!existsSync(target)) {
    throw new PalError('not-found', `目录不存在：${target}`, {
      hint: '扫描只读，不会替你创建目录',
    });
  }
  if (!statSync(target).isDirectory()) {
    throw new PalError('invalid-input', `不是目录：${target}`);
  }
  const result = scanDirectory(target, { depth });
  if (options.json) {
    // --json 只输出候选数组；目录读不了这类问题走 problems，不混进候选
    console.log(JSON.stringify(result.entries, null, 2));
    return;
  }
  if (result.entries.length === 0) console.log('没扫到实例、Pack 或环境');
  for (const entry of result.entries) console.log(scanLine(entry));
  for (const problem of result.problems) console.log(`! ${problem.dir}\t${problem.reason}`);
  console.log(`共 ${result.entries.length} 条候选（只读扫描，没有写盘）`);
}

/* ---------- 遗留物（health --leftovers） ---------- */

export interface Leftovers {
  root: string;
  quarantine: string[];
  failed: string[];
  archive: string[];
}

/** 只读收集隔离区 / 失败现场 / 归档区（原 pal leftovers 的实现）。 */
export function collectLeftovers(): Leftovers {
  const dirs = { quarantine: quarantineRoot(), failed: failedRoot(), archive: archiveRoot() };
  const report: Leftovers = { root: instancesRoot(), quarantine: [], failed: [], archive: [] };
  for (const key of ['quarantine', 'failed', 'archive'] as const) {
    report[key] = existsSync(dirs[key]) ? listDir(dirs[key]) : [];
  }
  return report;
}

/** 打印遗留物报告；`--json` 的形状与原来的 pal leftovers --json 一致。 */
export function printLeftovers(report: Leftovers, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`实例根：${report.root}`);
  for (const key of ['quarantine', 'failed', 'archive'] as const) {
    console.log(`${key}：${report[key].length === 0 ? '（空）' : ''}`);
    for (const entry of report[key]) console.log(`  ${entry}`);
  }
  console.log('· 只读：隔离区与归档区里的东西没有被删；要搬回去或删掉由人来做。');
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/* ---------- 搬运命令 ---------- */

export const clone = defineCommand({
  meta: { name: 'clone', description: '复制一份实例（连 home 一起拷，可独立改）' },
  args: {
    target: { type: 'positional', required: true, description: '源实例 id 或名字' },
    name: { type: 'string', required: true, description: '新实例名' },
    root: {
      type: 'string',
      description: '新实例根（绝对路径，不能落在 PAL 的实例根里）；不写就由系统分配；相对路径直接拒绝',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const root = args.root === undefined ? undefined : assertExternalRoot(String(args.root));
    const rec = await cloneInstance(requireTarget(args.target), {
      name: String(args.name),
      ...(root ? { root } : {}),
    });
    console.log(args.json ? JSON.stringify(rec, null, 2) : `✓ 复制成 ${rec.id}（${rec.root}）`);
  },
});

export const migrate = defineCommand({
  meta: { name: 'migrate', description: '把实例根挪到别的目录，记录路径一起改' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    to: { type: 'positional', required: true, description: '新的实例根路径' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const moved = migrateInstance(requireTarget(args.target), String(args.to));
    if (args.json) {
      console.log(JSON.stringify(moved.record, null, 2));
      return;
    }
    console.log(`✓ ${moved.record.id} → ${moved.record.root}`);
    if (moved.movedBy === 'copy') {
      console.log('· 跨盘迁移：已复制到目标盘并切换记录，旧根已删除');
    }
  },
});

export const exportCmd = defineCommand({
  meta: { name: 'export', description: '把实例导出成模板（JSON），可在别处重建' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    out: { type: 'string', description: '输出文件；默认 <名字>.pal.json' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const template = exportTemplate(requireTarget(args.target));
    const out = String(args.out ?? `${template.name}.pal.json`);
    const file = writeTemplate(template, out);
    console.log(args.json ? JSON.stringify(template, null, 2) : `✓ 已导出 ${file}`);
  },
});

export const importCmd = defineCommand({
  meta: { name: 'import', description: '从模板重建实例（按记录里的 Pack 引用重取）' },
  args: {
    file: { type: 'positional', required: true, description: '模板文件' },
    name: { type: 'string', description: '新实例名；默认用模板里的名字' },
    index: { type: 'string', description: 'registry 索引' },
    root: {
      type: 'string',
      description: '实例根（绝对路径，不能落在 PAL 的实例根里）；不写就由系统分配；相对路径直接拒绝',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const root = args.root === undefined ? undefined : assertExternalRoot(String(args.root));
    const log = (line: string): void => {
      if (!args.json) console.error(line);
    };
    const rec = await importFromFile({
      file: String(args.file),
      ...(args.name !== undefined ? { name: String(args.name) } : {}),
      ...(args.index ? { index: String(args.index) } : {}),
      ...(root ? { root } : {}),
      log,
    });
    console.log(args.json ? JSON.stringify(rec, null, 2) : `✓ ${rec.id}\n  ${rec.root}`);
  },
});

export const backup = defineCommand({
  meta: {
    name: 'backup',
    description: '整实例快照（目录复制）：含 home 与数据，默认不含凭据；排除锁、停止标记与 logs/',
  },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    out: {
      type: 'string',
      description: '备份目录；默认 <数据目录>/backups/<名字>-<时间戳>（目标必须不存在）',
    },
    'include-secrets': {
      type: 'boolean',
      default: false,
      description: '连 secrets.json 一起备份；默认不带凭据',
    },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const result = backupInstance(requireTarget(args.target), {
      ...(args.out ? { out: String(args.out) } : {}),
      includeSecrets: Boolean(args['include-secrets']),
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`✓ 已备份 ${result.meta.instance.name} → ${result.dir}`);
    console.log(
      `  ${result.meta.fileCount} 个文件${result.meta.includesSecrets ? '（含凭据）' : '（不含凭据）'}`,
    );
    if (!result.meta.includesSecrets) {
      console.log('· 默认不备份 secrets.json：要带凭据请显式加 --include-secrets。');
    }
  },
});

export const restore = defineCommand({
  meta: { name: 'restore', description: '从备份恢复成一份新实例（新 id、新根，不覆盖已有实例）' },
  args: {
    dir: { type: 'positional', required: true, description: '备份目录（含 backup.json 的那一层）' },
    name: { type: 'string', description: '新实例名；默认沿用备份里的名字（重名时另给）' },
    root: {
      type: 'string',
      description: '新实例根（绝对路径，不能落在 PAL 的实例根里）；不写就由系统分配',
    },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const root = args.root === undefined ? undefined : assertExternalRoot(String(args.root));
    const rec = restoreBackup(String(args.dir), {
      ...(args.name ? { name: String(args.name) } : {}),
      ...(root ? { root } : {}),
    });
    if (args.json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    console.log(`✓ 已恢复成 ${rec.id}（${rec.name}）`);
    console.log(`  ${rec.root}`);
    if (!rec.home) console.log('· 备份里没有 home 段：这份实例只有实例根内容。');
  },
});
