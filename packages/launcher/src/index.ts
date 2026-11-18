// 入口按模块分组再导出；调用方（cli / start / 测试）只从这里取。
export { instanceLock, withInstanceLock } from './lock.ts';
export { BASELINE, baselineFromState, readBaseline, writeBaseline } from './baseline.ts';
export type { Baseline, BaselineFile } from './baseline.ts';
export { nowIso } from './time.ts';

export { API_VERSION, RECORD, readRecord, readRecordResult, recordFile } from './records.ts';
export type { InstanceRecord, InstanceStatus, RecordRead } from './records.ts';

export { writeInstance } from './recordWrite.ts';

export { quarantineInstance, failInstance } from './quarantine.ts';

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

// assertNameFree / assertHarness 是 create 与 migrate 的包内共用实现，定义在 validators.ts，不对外导出。
export { adoptInstance, createInstance, seedHome } from './create.ts';
export type { AdoptOptions, CreateInstanceOptions } from './create.ts';

export { removeInstance } from './remove.ts';
export type { RemoveOptions, RemoveResult } from './remove.ts';

export { rebaselineInstance, updateInstance } from './update.ts';
export type { UpdateInstanceResult } from './update.ts';

export { cloneInstance, migrateInstance, renameInstance } from './migrate.ts';
export type { MigrateOptions, MigrateResult } from './migrate.ts';

export { exportTemplate, readTemplate, writeTemplate } from './template.ts';
export type { InstanceTemplate } from './template.ts';
