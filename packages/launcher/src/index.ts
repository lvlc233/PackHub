// 锁与基线的实现搬到了 lock.ts / baseline.ts；这里继续按原名导出，调用方（start/server/cli/测试）不受影响
export { instanceLock, withInstanceLock } from './lock.ts';
export { BASELINE, readBaseline, writeBaseline } from './baseline.ts';
export { baselineFromState } from './baseline.ts';
export type { Baseline, BaselineFile } from './baseline.ts';
export { nowIso } from './time.ts';

// 记录的读写搬到了 records.ts；这里继续按原名导出，调用方（start/server/cli/测试）不受影响
export { API_VERSION, RECORD, readRecord, readRecordResult, recordFile } from './records.ts';
export type { InstanceRecord, InstanceStatus, RecordRead } from './records.ts';

// 写记录（带 .links 副作用）搬到了 recordWrite.ts；removeLink 只是内部用，不对外导出
export { writeInstance } from './recordWrite.ts';

// 隔离与失败现场搬到了 quarantine.ts；入口继续按原名导出（moveAside 原本就没导出，这里也不导出）
export { quarantineInstance, failInstance } from './quarantine.ts';

// 实例清单与「当前实例」一览表搬到了 catalog.ts；入口继续按原名导出（dropActive、safeFiles 只是包内用，不导出）
export {
  activeMapPath,
  listInstances,
  readActiveMap,
  readInstance,
  requireInstance,
  scanInstances,
  writeActiveMap,
} from './catalog.ts';
export type { InstanceScan } from './catalog.ts';

// 建实例与接管搬到了 create.ts；入口继续按原名导出（assertNameFree、assertHarness 只是包内共用，不对外导出，
// 现在定义在 validators.ts，create / migrate 都从那里 import）
export { adoptInstance, createInstance, seedHome } from './create.ts';
export type { AdoptOptions, CreateInstanceOptions } from './create.ts';

// 删除搬到了 remove.ts；入口继续按原名导出（removeTreeWithRetry 只是内部用，不导出）
export { removeInstance } from './remove.ts';
export type { RemoveOptions, RemoveResult } from './remove.ts';

// 更新与重新基准化搬到了 update.ts；入口继续按原名导出，调用方（cli/server/测试）不受影响
export { rebaselineInstance, updateInstance } from './update.ts';
export type { UpdateInstanceResult } from './update.ts';

// 复制 / 改名 / 迁移搬到了 migrate.ts；入口继续按原名导出（rollbackMigrate、migrateLocked 只是内部用，不导出）
export { cloneInstance, migrateInstance, migrateInstanceDetailed, renameInstance } from './migrate.ts';
export type { MigrateOptions, MigrateResult } from './migrate.ts';

// 实例模板搬到了 template.ts；入口继续按原名导出
export { exportTemplate, readTemplate, writeTemplate } from './template.ts';
export type { InstanceTemplate } from './template.ts';
