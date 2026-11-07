import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * PAL 的所有落点集中在这里：实例根、取包缓存、隔离区、归档区。
 * 其他模块不再各自拼路径，测试也只需要覆盖一次 PACKHUB_HOME / PACKHUB_INSTANCES。
 */
function homeBase(): string {
  return resolve(process.env.PACKHUB_HOME ?? join(homedir(), '.packhub'));
}

/** 实例存放的根；测试与多环境都用它隔离。 */
export function instancesRoot(): string {
  return resolve(process.env.PACKHUB_INSTANCES ?? join(homeBase(), 'instances'));
}

/** 取回来的 Pack 放这里，按来源与版本分目录。 */
export function cacheRoot(): string {
  return join(homeBase(), 'cache', 'packs');
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

export function newId(date = new Date()): string {
  return `${stamp(date)}-${Math.random().toString(36).slice(2, 6)}`;
}
