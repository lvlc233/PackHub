import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { PalError } from './errors.ts';

/**
 * PAL 的所有落点集中在这里：数据目录、实例根、取包缓存、隔离区、归档区。
 * 其他模块不再各自拼路径，测试也只需要覆盖一次 PACKHUB_HOME / PACKHUB_INSTANCES。
 *
 * 数据目录（PAL home）按下面的顺序决定，先命中先赢：
 *   1. `PACKHUB_HOME`：显式覆盖，测试与多环境都用它；
 *   2. `pal config --home` 写过的手动选择（location.json）；
 *   3. 便携默认：打包后的 `pal.cjs` 同级 `data/`，目录可写时才用；
 *   4. 系统默认：Windows `%LOCALAPPDATA%\PackHub`，其它平台 `~/.packhub`。
 *
 * 没有旧版兼容层：0.x 还没人用，旧路径不参与解析，少一条分支。
 */

export type PalHomeSource = 'env' | 'pointer' | 'portable' | 'default';

export const HOME_SOURCE_LABEL: Record<PalHomeSource, string> = {
  env: '环境变量 PACKHUB_HOME',
  pointer: '自定义（location.json）',
  portable: '便携（程序目录旁）',
  default: '系统默认',
};

export interface HomeChoiceInput {
  env?: string;
  pointerHome?: string;
  portable?: string;
  portableWritable?: boolean;
  fallback: string;
}

/**
 * 纯函数版的数据目录选择：不碰文件系统，测试直接给输入。
 * 指针只接受绝对路径；指到相对路径/空串就当没设，继续走后面的规则。
 */
export function choosePalHome(input: HomeChoiceInput): { home: string; source: PalHomeSource } {
  const env = input.env?.trim();
  if (env) return { home: resolve(env), source: 'env' };
  const pointer = input.pointerHome?.trim();
  if (pointer && isAbsolute(pointer)) return { home: resolve(pointer), source: 'pointer' };
  if (input.portable && input.portableWritable) return { home: resolve(input.portable), source: 'portable' };
  return { home: resolve(input.fallback), source: 'default' };
}

function localAppData(): string {
  const value = process.env.LOCALAPPDATA?.trim();
  return value ? resolve(value) : join(homedir(), 'AppData', 'Local');
}

function posixHome(): string {
  return join(homedir(), '.packhub');
}

function fallbackHome(): string {
  return process.platform === 'win32' ? join(localAppData(), 'PackHub') : posixHome();
}

/**
 * 手动选择存在哪。放在一个与数据目录无关的固定位置：
 * 数据目录本身可能被改到别的盘，指针必须还能被下一次启动找到。
 * `PACKHUB_LOCATION_FILE` 只给测试/多环境用。
 */
export function locationFile(): string {
  const override = process.env.PACKHUB_LOCATION_FILE?.trim();
  return override ? resolve(override) : join(localAppData(), 'PackHub', 'location.json');
}

function readPointerHome(): string | undefined {
  try {
    const data = JSON.parse(readFileSync(locationFile(), 'utf8')) as { home?: unknown };
    return typeof data.home === 'string' ? data.home : undefined;
  } catch {
    // 读不了/坏 JSON/没有文件：当作没设过。真正的写失败会在 pal config 里报。
    return undefined;
  }
}

/** 打包形态（pal.cjs）才谈得上“程序目录旁”；源码跑 bin.ts 时没有这个概念。 */
function bundledHome(): string | undefined {
  const entry = process.argv[1];
  if (!entry) return undefined;
  const full = resolve(entry);
  return /[\\/]pal\.cjs$/i.test(full) ? join(dirname(full), 'data') : undefined;
}

function canWrite(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface PalHomeInfo {
  home: string;
  source: PalHomeSource;
}

/** 当前进程实际使用的数据目录与它的来源。 */
export function palHomeInfo(): PalHomeInfo {
  const portable = bundledHome();
  return choosePalHome({
    env: process.env.PACKHUB_HOME,
    pointerHome: readPointerHome(),
    ...(portable ? { portable } : {}),
    portableWritable: portable !== undefined && canWrite(dirname(portable)),
    fallback: fallbackHome(),
  });
}

function homeBase(): string {
  return palHomeInfo().home;
}

/**
 * PAL 自己的数据目录（core.json / core.lock / core.log 落这里）。
 * 与实例无关：core 是 PAL 的一份，不是某个实例的。
 */
export function palHome(): string {
  return homeBase();
}

/**
 * PAL 自己的配置：新实例的默认隔离策略放这里（不是任何实例的配置）。
 * 文件名故意不叫 `config.json`：PackHub CLI 的 registry 配置（`registries` /
 * `defaultRegistry`）用的是 `$PACKHUB_HOME/config.json`，两者在 `PACKHUB_HOME`
 * 指向同一目录时会撞车；PAL 不能覆盖它，也不该按自己的 schema 去读它。
 */
export function palConfigFile(): string {
  return join(homeBase(), 'pal.json');
}

/** 实例存放的根；测试与多环境都用它隔离。 */
export function instancesRoot(): string {
  return resolve(process.env.PACKHUB_INSTANCES ?? join(homeBase(), 'instances'));
}

/** 取回来的 Pack 放这里，按来源与版本分目录。 */
export function cacheRoot(): string {
  return join(homeBase(), 'cache', 'packs');
}

/**
 * 实例模板的默认导出目录：放在 PAL home 下，不能放进 instancesRoot。
 * instancesRoot 只放实例目录；扫描会把没有 instance.json 的目录当坏记录隔离。
 */
export function exportsRoot(): string {
  return join(homeBase(), 'exports');
}

/**
 * 整实例快照的默认落点：<数据目录>/backups/<名字>-<时间戳>/。
 * 和 exportsRoot 一样不能放进 instancesRoot：备份目录里也有 instance.json，
 * 放进去会被列表当成第二份实例。
 */
export function backupsRoot(): string {
  return join(homeBase(), 'backups');
}

/** 坏记录/失败现场的隔离区：移到这里，不留在实例列表里，也不删。 */
export function quarantineRoot(): string {
  return join(instancesRoot(), '.quarantine');
}

/** 建实例失败时的现场（只在我们自己建的根上产生）。 */
export function failedRoot(): string {
  return join(instancesRoot(), '.failed');
}

/** 删除实例时选择“保留数据”的去处。 */
export function archiveRoot(): string {
  return join(instancesRoot(), '.archive');
}

/** 数据目录里有没有东西（实例、缓存、备份、导出、PAL 全局配置都算）。给“换目录”前的确认用。 */
export function homeHasData(home: string = homeBase()): boolean {
  // 只看 PAL 自己的 pal.json；config.json 可能是 PackHub CLI 的配置，不算 PAL 的数据。
  if (existsSync(join(home, 'pal.json'))) return true;
  for (const dir of ['instances', 'backups', 'exports', 'cache']) {
    try {
      if (readdirSync(join(home, dir)).some((name) => !name.startsWith('.'))) return true;
    } catch {
      /* 目录不存在或读不了：当作没有 */
    }
  }
  return false;
}

/**
 * 写手动选择（pal config --home）：把目标目录建出来，再原子写指针。
 * 只写“选哪”，不搬数据；已有数据怎么搬由调用方提示。
 */
export function writeHomePointer(home: string): string {
  const text = String(home ?? '').trim();
  if (!text) {
    throw new PalError('invalid-input', '数据目录不能为空', { hint: '给一个绝对路径，例如 D:\\PackHubData' });
  }
  if (!isAbsolute(text)) {
    throw new PalError('invalid-input', '数据目录必须是绝对路径', {
      hint: 'PAL 不解析相对路径；例如 D:\\PackHubData',
      details: { home: text },
    });
  }
  const target = resolve(text);
  if (target === parse(target).root) {
    throw new PalError('invalid-input', '数据目录不能是盘符根或文件系统根', {
      hint: '给一个具体目录，PAL 会按需创建',
      details: { home: target },
    });
  }
  const file = locationFile();
  try {
    mkdirSync(target, { recursive: true });
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ home: target }, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(`${file}.tmp-${process.pid}`, { force: true });
    } catch {
      /* 临时文件清不掉不影响结论 */
    }
    throw new PalError('invalid-input', `数据目录不可用：${(err as Error).message}`, {
      hint: '换一个可写、非盘符根的目录',
      details: { home: target, file },
      cause: err,
    });
  }
  return target;
}

export function stamp(date = new Date()): string {
  return date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

/**
 * 实例 id：`yyyyMMddHHmmss-` + 12 位十六进制随机串（node:crypto，48 bit）。
 * 前缀是 14 位时间戳，排序即时间序；后缀只含 [0-9a-f]，可直接当目录名、`.links/<id>.json` 与 URL 段。
 * 不用 Math.random：可预测，且 36 进制截 4 位时同毫秒只有 36^4 种（1000 个同时建约 26% 撞上），
 * slice(2, 6) 还可能不足 4 位。48 bit 下同毫秒 1000 个的碰撞概率约 2e-9。
 */
export function newId(date = new Date()): string {
  return `${stamp(date)}-${randomBytes(6).toString('hex')}`;
}
