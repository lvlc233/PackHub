import type { TargetId } from '@packhub/kernel';
import { HARNESS_IDS } from './layout.ts';
import { listInstances } from './catalog.ts';
import { PalError } from './errors.ts';

/**
 * 建实例之前的校验：名字不能撞车、宿主必须是已知的那几个。
 * 从 create.ts 搬出来；create / adopt / migrate 共用，不从 index.ts 对外导出。
 */

/* ---------- 校验 ---------- */

/** 名字不能撞上已有实例。建实例、接管、复制、改名都要过这一关，所以从这里导出共用。 */
export function assertNameFree(name: string): void {
  if (listInstances().some((i) => i.name === name)) {
    throw new PalError('name-taken', `实例名已存在：${name}`, { hint: '换一个名字，或先删掉旧实例' });
  }
}

export function assertHarness(value: string): TargetId {
  if (!(HARNESS_IDS as string[]).includes(value)) {
    throw new PalError('unknown-harness', `没有这个宿主：${value}`, {
      hint: `可选：${HARNESS_IDS.join(' / ')}`,
      details: { harness: value, choices: HARNESS_IDS },
    });
  }
  return value as TargetId;
}
