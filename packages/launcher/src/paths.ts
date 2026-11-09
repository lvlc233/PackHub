import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * PAL 的所有落点集中在这里：实例根、取包缓存、隔离区、归档区。
 * 其他模块不再各自拼路径，测试也只需要覆盖一次 PACKHUB_HOME / PACKHUB_INSTANCES。
 */
function homeBase(): string {
  return resolve(process.env.PACKHUB_HOME ?? join(homedir(), '.packhub'));
}

/** PAL 自己的配置：新实例的默认隔离策略放这里（不是任何实例的配置）。 */
export function palConfigFile(): string {
  return join(homeBase(), 'config.json');
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
 * 整实例快照的默认落点：<PACKHUB_HOME>/backups/<名字>-<时间戳>/。
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
