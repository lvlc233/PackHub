import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadManifest } from '@packhub/kernel';
import { STATE_API_VERSION } from '@packhub/runtime';

/**
 * 只读目录扫描：在一个目录下按深度找三类 PAL 候选——已有实例、Pack 目录、装过 Pack 的环境。
 * 清单身份交给 kernel 的 loadManifest 读（与 create / update 同一套解析）；
 * state 的格式版本取自 runtime 的 STATE_API_VERSION，比较不写字面量。
 * 其余只依赖 node:fs / node:path：不写盘、不改记录、不取包、不接管（adopt 仍要人给 dir + harness）。
 * 路径比较统一走 pathKey：Windows 大小写不敏感；resolve 之后分隔符也已归一。
 */

export const DEFAULT_SCAN_DEPTH = 2;

/** 三类候选各自的标记文件；与 records.ts / runtime 的落点保持一致，这里不 import 它们。 */
export const INSTANCE_FILE = 'instance.json';
export const PACK_FILE = 'packhub.yaml';
export const STATE_DIR = '.packhub';
export const STATE_FILE = 'state.json';

export type ScanKind = 'instance' | 'pack' | 'environment';

export interface ScanEntry {
  kind: ScanKind;
  /** 候选所在目录（绝对路径）：实例/Pack 是含标记文件的目录，环境是 .packhub 的父目录 */
  dir: string;
  /** 命中用的标记文件（绝对路径） */
  file: string;
  /** 实例名 / 清单 metadata.name */
  name?: string;
  /** 清单 metadata.version（只对 pack） */
  version?: string;
  /** 实例记录里的宿主 id */
  harness?: string;
  /** 实例记录里的 Pack（name/version 从记录读，不重新取包） */
  pack?: { name: string; version: string };
  /** 环境：.packhub/state.json 里的 pack key 数量（可 adopt 的依据） */
  packs?: number;
  /** 像候选但记录读不了（目前只标 instance.json） */
  broken?: boolean;
  /** 这一条自己的问题：坏记录原因、清单缺字段、state 读不了；不影响别的候选 */
  problem?: string;
}

/** 扫到了但没法列成候选的目录（没有权限等）；扫描不因单项失败中断。 */
export interface ScanProblem {
  dir: string;
  reason: string;
}

export interface DirectoryScan {
  root: string;
  depth: number;
  entries: ScanEntry[];
  problems: ScanProblem[];
}

export interface ScanOptions {
  /** 往下扫几层：目录本身算第 0 层。默认 DEFAULT_SCAN_DEPTH。 */
  depth?: number;
}

/** 不进这些目录：依赖目录、版本库元数据、.packhub 内部（装好的副本与状态不是候选）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.packhub']);

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 比较用的路径键：Windows 大小写不敏感；用 / 统一分隔符，避免两侧来源不同时误判不相等。 */
export function pathKey(value: string): string {
  const full = resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function readText(file: string): { text?: string; problem?: string } {
  try {
    return { text: readFileSync(file, 'utf8') };
  } catch (err) {
    return { problem: `读不了：${errorText(err)}` };
  }
}

/**
 * 从 packhub.yaml 读 metadata.name / metadata.version。
 *
 * 走 kernel 的 loadManifest：`pal scan` 与 create / update 必须对同一份 YAML 给出同一个答案
 * （YAML 锚点、行内写法、带注释的值……这些语义只有解析器说得清，这里不再维护第二套）。
 * 读不了或不合法时 problem 带 kernel 的报错；缺哪个字段由 readPackEntry 补成人话。
 */
export function readManifestIdentity(file: string): {
  name?: string;
  version?: string;
  problem?: string;
} {
  const loaded = loadManifest(file);
  const meta = loaded.manifest?.metadata;
  const errors = loaded.issues.filter((issue) => issue.severity === 'error');
  return {
    ...(meta?.name ? { name: meta.name } : {}),
    ...(meta?.version ? { version: meta.version } : {}),
    ...(errors.length > 0
      ? { problem: `清单不合法：${errors.map((issue) => issue.message).join('；')}` }
      : {}),
  };
}

function readInstanceEntry(dir: string, file: string): ScanEntry {
  const base: ScanEntry = { kind: 'instance', dir, file };
  const read = readText(file);
  if (read.text === undefined) {
    return { ...base, broken: true, problem: `instance.json ${read.problem ?? '读不了'}` };
  }
  let data: unknown;
  try {
    data = JSON.parse(read.text);
  } catch (err) {
    return { ...base, broken: true, problem: `instance.json 不是合法 JSON：${errorText(err)}` };
  }
  if (!isRecord(data)) {
    return { ...base, broken: true, problem: 'instance.json 内容不是一个对象' };
  }
  if (typeof data.id !== 'string' || !data.id.trim()) {
    return { ...base, broken: true, problem: 'instance.json 缺少 id' };
  }
  if (typeof data.name !== 'string' || !data.name.trim()) {
    return { ...base, broken: true, problem: 'instance.json 缺少 name' };
  }
  const packValue = isRecord(data.pack) ? data.pack : undefined;
  const packName = typeof packValue?.name === 'string' ? packValue.name : undefined;
  const packVersion = typeof packValue?.version === 'string' ? packValue.version : undefined;
  return {
    ...base,
    name: data.name,
    ...(typeof data.harness === 'string' && data.harness ? { harness: data.harness } : {}),
    ...(packName
      ? { pack: { name: packName, version: packVersion ?? '0.0.0' } }
      : {}),
  };
}

function readPackEntry(dir: string, file: string): ScanEntry {
  const base: ScanEntry = { kind: 'pack', dir, file };
  const identity = readManifestIdentity(file);
  const problems: string[] = [];
  if (!identity.name) problems.push('清单里没有 metadata.name');
  if (!identity.version) problems.push('清单里没有 metadata.version');
  if (identity.problem) problems.push(identity.problem);
  return {
    ...base,
    ...(identity.name ? { name: identity.name } : {}),
    ...(identity.version ? { version: identity.version } : {}),
    ...(problems.length > 0 ? { problem: problems.join('；') } : {}),
  };
}

function readEnvironmentEntry(dir: string, file: string): ScanEntry {
  const base: ScanEntry = { kind: 'environment', dir, file };
  const read = readText(file);
  if (read.text === undefined) {
    return { ...base, packs: 0, problem: `.packhub/state.json ${read.problem ?? '读不了'}` };
  }
  let data: unknown;
  try {
    data = JSON.parse(read.text);
  } catch (err) {
    return { ...base, packs: 0, problem: `.packhub/state.json 不是合法 JSON：${errorText(err)}` };
  }
  if (!isRecord(data)) {
    return { ...base, packs: 0, problem: '.packhub/state.json 里没有 packs 对象' };
  }
  // 版本必须比较：别的代际的 state 不按字段猜，也不静默计数
  if (data.apiVersion !== STATE_API_VERSION) {
    return {
      ...base,
      packs: 0,
      problem: `.packhub/state.json 的格式版本不认识：${String(data.apiVersion)}（只认 ${STATE_API_VERSION}）`,
    };
  }
  if (!isRecord(data.packs)) {
    return { ...base, packs: 0, problem: '.packhub/state.json 里没有 packs 对象' };
  }
  return { ...base, packs: Object.keys(data.packs).length };
}

/**
 * 扫一个目录：目录本身算第 0 层，depth 是最多往下走几层。
 * 每个目录先看三个标记文件（instance.json / packhub.yaml / .packhub/state.json），
 * 再按层数决定要不要进子目录；符号链接不跟随，SKIP_DIRS 里的目录不进去。
 * 只读：不创建、不修改、不删除任何文件。
 */
export function scanDirectory(root: string, opts: ScanOptions = {}): DirectoryScan {
  const start = resolve(root);
  const depth = opts.depth ?? DEFAULT_SCAN_DEPTH;
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error(`扫描深度要 0 或正整数：${String(opts.depth)}`);
  }
  let stat;
  try {
    stat = statSync(start);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`目录不存在：${start}`);
    throw new Error(`读不了目录：${start}：${errorText(err)}`);
  }
  if (!stat.isDirectory()) throw new Error(`不是目录：${start}`);

  const entries: ScanEntry[] = [];
  const problems: ScanProblem[] = [];
  const seen = new Set<string>();
  const queue: Array<{ dir: string; level: number }> = [{ dir: start, level: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const key = pathKey(current.dir);
    if (seen.has(key)) continue;
    seen.add(key);

    const instanceFile = join(current.dir, INSTANCE_FILE);
    if (isFile(instanceFile)) entries.push(readInstanceEntry(current.dir, instanceFile));
    const packFile = join(current.dir, PACK_FILE);
    if (isFile(packFile)) entries.push(readPackEntry(current.dir, packFile));
    const stateFile = join(current.dir, STATE_DIR, STATE_FILE);
    if (isFile(stateFile)) entries.push(readEnvironmentEntry(current.dir, stateFile));

    if (current.level >= depth) continue;
    let children: Dirent[];
    try {
      children = readdirSync(current.dir, { withFileTypes: true });
    } catch (err) {
      problems.push({ dir: current.dir, reason: `读不了目录：${errorText(err)}` });
      continue;
    }
    for (const child of children) {
      // 只认真目录：符号链接的 isDirectory() 是 false，不会被跟到别处
      if (!child.isDirectory()) continue;
      if (SKIP_DIRS.has(child.name.toLowerCase())) continue;
      queue.push({ dir: join(current.dir, child.name), level: current.level + 1 });
    }
  }

  entries.sort(
    (a, b) => pathKey(a.dir).localeCompare(pathKey(b.dir)) || a.kind.localeCompare(b.kind),
  );
  problems.sort((a, b) => pathKey(a.dir).localeCompare(pathKey(b.dir)));
  return { root: start, depth, entries, problems };
}
