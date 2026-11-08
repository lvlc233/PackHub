import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { TargetId } from '@packhub/kernel';
import { PalError } from './errors.ts';
import type { InstanceRecord } from './records.ts';
import { requireInstance } from './catalog.ts';
import { nowIso } from './time.ts';

/**
 * 实例模板：导出实例的来源信息、写/读模板文件。
 * 从 index.ts 搬出来；不 import index.ts（避免循环）。
 */

export interface InstanceTemplate {
  apiVersion: 'packhub.dev/instance-template/v0';
  name: string;
  harness: TargetId;
  pack: { name: string; version: string; ref?: string };
  origin?: InstanceRecord['origin'];
  createdAt: string;
  /** 接管来的实例没有可复现的来源，导出时明确写出来 */
  reproducible: boolean;
  note?: string;
}

export function exportTemplate(nameOrId: string): InstanceTemplate {
  const record = requireInstance(nameOrId);
  const reproducible = record.origin?.kind === 'pack' && Boolean(record.origin.ref);
  return {
    apiVersion: 'packhub.dev/instance-template/v0',
    name: record.name,
    harness: record.harness,
    pack: record.pack,
    ...(record.origin ? { origin: record.origin } : {}),
    createdAt: nowIso(),
    reproducible,
    ...(reproducible
      ? {}
      : { note: '这份实例不是用 Pack 引用建的，导出的模板只能记录它是什么，不能复原内容' }),
  };
}

export function writeTemplate(template: InstanceTemplate, file: string): string {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(resolve(file), JSON.stringify(template, null, 2) + '\n', 'utf8');
  return resolve(file);
}

export function readTemplate(file: string): InstanceTemplate {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new PalError('not-found', `没有这个模板文件：${abs}`);
  let data: InstanceTemplate;
  try {
    data = JSON.parse(readFileSync(abs, 'utf8')) as InstanceTemplate;
  } catch (err) {
    throw new PalError('invalid-input', `模板读不了：${(err as Error).message}`, { cause: err });
  }
  if (data?.apiVersion !== 'packhub.dev/instance-template/v0') {
    throw new PalError('invalid-input', '不是 PAL 实例模板（apiVersion 不对）');
  }
  if (!data.reproducible) {
    throw new PalError('invalid-input', `这份模板不可复现：${data.note ?? '没有来源引用'}`, {
      hint: '从 Pack registry 或 .phub / git+ 引用建的实例才能导出可复现模板',
    });
  }
  return data;
}
