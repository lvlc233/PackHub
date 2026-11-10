import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { TargetId } from '@packhub/kernel';
import { PalError } from './errors.ts';
import { API_VERSION, RUNTIME, readRecordResult, type InstanceRecord } from './records.ts';
import { writeInstance } from './recordWrite.ts';
import { requireInstance } from './catalog.ts';
import { ADAPTERS, credentialRels } from './layout.ts';
import { LOCK } from './lock.ts';
import { STOPPING_MARK } from './stopMark.ts';
import { isPidAlive } from './process.ts';
import { backupsRoot, instancesRoot, newId, stamp } from './paths.ts';
import { nowIso } from './time.ts';
import { assertExternalRoot, assertHarness, assertNameFree } from './validators.ts';

/**
 * 整实例备份与恢复：目录快照，不引 tar 依赖。
 *
 * 备份就是「把实例根原样拷一份」：excluded 的只有运行痕迹（锁、停止标记、logs/、runtime.json）与凭据 ——
 * 根里的 secrets.json，以及宿主自己的凭据文件（`ADAPTERS.credentialFiles`，如 auth.json）。
 * 凭据默认不带——对齐 A3 的 copy 方向，要带必须显式 includeSecrets；
 * runtime.json 是运行态，不跟凭据走、也不跟着恢复（includeSecrets 也不带）。
 *
 * 恢复总是生成一份新实例：新 id、新根（显式 root 只收外部目录），记录整体重写；
 * 备份目录里的 backup.json 是信封，不进实例根。
 *
 * 只依赖 fs/path 与包内底层模块，不 import index.ts（避免循环）。
 */

export const BACKUP_FILE = 'backup.json';
export const BACKUP_API_VERSION = 'packhub.dev/instance-backup/v0';

/** 备份信封：身份摘要 + 是否带凭据 + 文件数；配置本体在备份目录的 instance.json 里（运行态不备份）。 */
export interface BackupMeta {
  apiVersion: typeof BACKUP_API_VERSION;
  instance: {
    id: string;
    name: string;
    harness: TargetId;
    /** Pack 名（不是整份 pack 对象）；版本单独给 */
    pack: string;
    version: string;
    createdAt: string;
  };
  createdAt: string;
  includesSecrets: boolean;
  /** 备份目录里的文件数（不含 backup.json 自己） */
  fileCount: number;
}

export interface BackupOptions {
  /** 备份目录；默认 <PACKHUB_HOME>/backups/<名字>-<时间戳> */
  out?: string;
  /** 把凭据也带上（根里的 secrets.json 与宿主凭据文件）；默认不带 */
  includeSecrets?: boolean;
}

export interface BackupResult {
  dir: string;
  meta: BackupMeta;
}

export interface RestoreOptions {
  /** 新实例名；默认沿用备份里的名字（重名时调用方必须另给） */
  name?: string;
  /** 新实例根；不写就由 instancesRoot 按新 id 分配 */
  root?: string;
}

/* ---------- 公共小工具 ---------- */

/** 比较用的路径形式：Windows 大小写不敏感，统一分隔符。 */
function pathKey(value: string): string {
  const full = resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

/** a 与 b 是同一处，或一处包含另一处（恢复时不能把备份拷进它自己里面）。 */
function overlaps(a: string, b: string): boolean {
  const x = pathKey(a);
  const y = pathKey(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** 实例根内的相对路径，统一用 /；命令与日志里都是这个形状。 */
function relOf(root: string, target: string): string {
  return relative(root, target).replace(/\\/g, '/');
}

/** 备份目录名：名字里可能有 / \ 空格等不能当目录名的东西，统一压成 -。 */
function backupDirName(name: string): string {
  const safe = name
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${safe || 'instance'}-${stamp()}`;
}

/** 拷完再数：只数文件（符号链接也算一个条目），不含之后写的 backup.json。 */
function countFiles(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(join(dir, entry.name));
    else total += 1;
  }
  return total;
}

/** 运行痕迹：备份与恢复都不搬。`logs/` 只排实例根这一层；runtime.json 是运行态，永不进备份。 */
const SKIP_RUNTIME = new Set([LOCK, STOPPING_MARK, 'logs', RUNTIME, 'secrets.json']);

/**
 * cpSync 的过滤器：按「相对实例根」的路径判断，绝不接受解析后落到根外的条目
 * （源路径由 cpSync 自己给出，这里是兜底，防止符号链接/怪路径把备份带到别处）。
 * skipCred 是宿主凭据文件的相对路径集合（由 layout 的 credentialRels 给出）；includeSecrets 时不传。
 */
function copyFilter(
  root: string,
  opts: { includeSecrets: boolean; skipCred?: ReadonlySet<string>; extra?: ReadonlySet<string> },
): (src: string) => boolean {
  return (src) => {
    const rel = relOf(root, src);
    if (!rel) return true;
    if (rel.startsWith('../') || rel === '..' || isAbsolute(rel)) return false;
    if (SKIP_RUNTIME.has(rel)) {
      return rel === 'secrets.json' && opts.includeSecrets;
    }
    if (opts.skipCred?.has(rel)) return false;
    if (opts.extra?.has(rel)) return false;
    return true;
  };
}

/* ---------- 备份 ---------- */

/**
 * 备份一份实例：整根复制到目标目录，写 backup.json。
 * 默认不带 secrets.json；目标目录必须不存在（不覆盖旧备份）。
 */
export function backupInstance(idOrName: string, opts: BackupOptions = {}): BackupResult {
  const record = requireInstance(idOrName);
  if (record.pid && isPidAlive(record.pid)) {
    throw new PalError('already-running', `实例还在运行：pid ${record.pid}`, {
      hint: '先停掉再备份，拷一份正在写的 home 没有意义',
      details: { id: record.id },
    });
  }
  // 凭据默认不带：要带必须显式给 includeSecrets
  const includeSecrets = opts.includeSecrets === true;
  // 宿主凭据文件按 ADAPTERS.credentialFiles 剥离，路径由 layout 统一算，不在这里另立清单
  const skipCred = includeSecrets
    ? undefined
    : new Set(credentialRels(record.harness, record.root, record.home));
  const dir = opts.out === undefined ? join(backupsRoot(), backupDirName(record.name)) : resolve(opts.out);
  if (existsSync(dir)) {
    throw new PalError('root-occupied', '备份目录已存在', {
      hint: '换一个目录，或先删掉旧备份；PAL 不覆盖已有目录',
      details: { dir },
    });
  }
  mkdirSync(dirname(dir), { recursive: true });
  try {
    cpSync(record.root, dir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: copyFilter(record.root, { includeSecrets, skipCred }),
    });
  } catch (err) {
    // 目标目录是这次新建的：拷一半失败就清掉，别留一份看不懂的半份备份
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 删不掉就留着，至少能看到失败现场 */
    }
    throw new PalError('internal', `备份没写完：${(err as Error).message}`, {
      hint: '确认目标目录可写，且源实例没有文件正被独占',
      cause: err,
      details: { dir },
    });
  }

  const meta: BackupMeta = {
    apiVersion: BACKUP_API_VERSION,
    instance: {
      id: record.id,
      name: record.name,
      harness: record.harness,
      pack: record.pack.name,
      version: record.pack.version,
      createdAt: record.createdAt,
    },
    createdAt: nowIso(),
    includesSecrets: includeSecrets,
    fileCount: countFiles(dir),
  };
  writeFileSync(join(dir, BACKUP_FILE), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return { dir, meta };
}

/* ---------- 恢复 ---------- */

/**
 * 备份目录必须是 backup.json 所在的那一层：`..` 段直接拒绝（不让输入借相对路径跳到别处），
 * 目录不存在按 not-found，没有 backup.json 就是 invalid-input。
 */
function requireBackupDir(dir: string): string {
  const raw = String(dir ?? '').trim();
  if (!raw) {
    throw new PalError('invalid-input', '要指定备份目录', {
      hint: '给含 backup.json 的目录；pal backup 的输出就是它',
    });
  }
  if (raw.split(/[\\/]+/).some((segment) => segment === '..')) {
    throw new PalError('invalid-input', '备份目录不能包含 .. 段', {
      hint: '写备份目录本身（含 backup.json 的那一层）的路径，不要用 .. 绕路',
      details: { dir: raw },
    });
  }
  const source = resolve(raw);
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new PalError('not-found', '备份目录不存在', {
      hint: '恢复是只读的：读不到就是路径写错了，PAL 不会替你创建',
      details: { dir: source },
    });
  }
  if (!existsSync(join(source, BACKUP_FILE))) {
    throw new PalError('invalid-input', '这个目录不是 PAL 备份（没有 backup.json）', {
      hint: '指向 pal backup 输出的那一层目录',
      details: { dir: source },
    });
  }
  return source;
}

function readBackupMeta(source: string): BackupMeta {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(join(source, BACKUP_FILE), 'utf8'));
  } catch (err) {
    throw new PalError('invalid-input', `backup.json 读不了：${(err as Error).message}`, {
      hint: '备份可能没写完；重新做一次 pal backup',
      cause: err,
      details: { dir: source },
    });
  }
  const meta = data as Partial<BackupMeta> | undefined;
  if (!meta || typeof meta !== 'object' || meta.apiVersion !== BACKUP_API_VERSION) {
    throw new PalError('invalid-input', '不是 PAL 实例备份（apiVersion 不对）', {
      details: { dir: source, expected: BACKUP_API_VERSION },
    });
  }
  if (!meta.instance || typeof meta.instance !== 'object' || typeof meta.instance.id !== 'string') {
    throw new PalError('invalid-input', 'backup.json 缺实例身份', {
      hint: '备份信封坏了；从别的备份恢复，或重新做一次',
      details: { dir: source },
    });
  }
  return meta as BackupMeta;
}

/**
 * 从备份恢复成一份新实例：新 id、新根、记录整体重写，备份内容原样复制回来。
 * 不覆盖已有实例根（root-occupied），新名字撞车由 assertNameFree 报 name-taken。
 */
export function restoreBackup(dir: string, opts: RestoreOptions = {}): InstanceRecord {
  const source = requireBackupDir(dir);
  const meta = readBackupMeta(source);

  // 配置本体在备份目录的 instance.json 里（runtime.json 不进备份）：root / home 还是旧路径，下面全部重写
  const read = readRecordResult(source);
  if (!read.record) {
    throw new PalError('invalid-input', `备份里的实例记录读不了：${read.error ?? '未知原因'}`, {
      hint: '备份里必须有能解析的 instance.json',
      details: { dir: source },
    });
  }
  const saved = read.record;
  const harness = assertHarness(saved.harness);

  const name = String(opts.name ?? meta.instance.name ?? saved.name).trim();
  if (!name) {
    throw new PalError('invalid-input', '恢复出来的实例要一个名字', {
      hint: '不给 --name 时沿用备份里的名字',
    });
  }
  assertNameFree(name);

  const id = newId();
  const root = opts.root === undefined ? join(instancesRoot(), id) : assertExternalRoot(opts.root);
  if (overlaps(source, root)) {
    throw new PalError('invalid-input', '实例根不能与备份目录重叠', {
      hint: '换一个和备份目录不相交的实例根',
      details: { dir: source, root },
    });
  }
  if (existsSync(root)) {
    throw new PalError('root-occupied', '目标目录已存在，不覆盖', {
      hint: '换一个还没被占用的目录；恢复总是新实例',
      details: { root },
    });
  }
  mkdirSync(dirname(root), { recursive: true });
  try {
    cpSync(source, root, {
      recursive: true,
      force: true,
      errorOnExist: false,
      // 旧锁与旧停止标记不能跟着回填；backup.json 是信封，也不进实例根
      filter: copyFilter(source, { includeSecrets: true, extra: new Set([BACKUP_FILE]) }),
    });
  } catch (err) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* 删不掉就留着现场 */
    }
    throw new PalError('internal', `恢复没写完：${(err as Error).message}`, {
      hint: '确认目标目录可写；失败时不会留半份实例记录',
      cause: err,
      details: { dir: source, root },
    });
  }

  // home 跟着根走：备份里的 home 在旧根内，就按相对路径搬到新根；
  // 不在根内（接管来的外部 home）时按宿主的 homeDir 落到新根里，找不到就不写。
  const relHome = saved.home ? relOf(saved.root, saved.home) : '';
  const insideHome = Boolean(relHome) && !relHome.startsWith('../') && relHome !== '..' && !isAbsolute(relHome);
  const adapterHomeDir = ADAPTERS[harness].homeDir;
  const home = insideHome
    ? join(root, relHome)
    : adapterHomeDir && existsSync(join(root, adapterHomeDir))
      ? join(root, adapterHomeDir)
      : undefined;

  const next: InstanceRecord = {
    ...saved,
    apiVersion: API_VERSION,
    id,
    name,
    root,
    status: 'installed',
    managed: true,
    // 恢复出来的不是 Pack 重建的：只记它从哪份实例拷来，和 clone 一个口径
    origin: { kind: 'copy', from: saved.id },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ports: [],
  };
  if (home) next.home = home;
  else delete next.home;
  // 运行痕迹全部作废：旧 pid/port 指的不是这份实例；入口也回到未启动状态
  delete next.pid;
  delete next.spawnPid;
  delete next.listenPid;
  delete next.port;
  delete next.url;
  delete next.entry;
  delete next.endpoint;
  delete next.exitCode;
  delete next.startedAt;
  delete next.lastExit;
  delete next.lastError;

  writeInstance(next);
  // 写记录返回不等于落盘：从新根读回来，别把内存里的 draft 当事实
  const back = readRecordResult(root);
  if (!back.record) {
    throw new PalError('record-corrupt', `恢复后读不到新根的记录：${back.error ?? '没有 instance.json'}`, {
      hint: '写记录没有真正落盘；实例根里可能有备份内容，但没有可用记录',
      details: { root, dir: source },
    });
  }
  return back.record;
}
