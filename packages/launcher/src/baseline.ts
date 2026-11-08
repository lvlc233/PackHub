import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TargetId } from '@packhub/kernel';
import { nowIso } from './time.ts';

/**
 * 实例基线：建完实例/更新后记下每个文件的 sha256，之后查漂移都以它为准。
 * 只做纯文件读写；从已安装状态收集清单一类需要 loadState 的逻辑留在 index.ts，
 * 这样本模块不 import index.ts，没有循环。
 */

export const BASELINE = 'baseline.json';

export interface BaselineFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface Baseline {
  apiVersion: 'packhub.dev/baseline/v0';
  pack: string;
  version: string;
  harness: TargetId;
  planHash: string;
  at: string;
  files: BaselineFile[];
  /** 只属于运行时、不参与漂移判断的路径前缀 */
  ignore?: string[];
}

export function hashFile(file: string): BaselineFile | undefined {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return undefined;
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    return { path: file, sha256: hash, bytes: stat.size };
  } catch {
    return undefined;
  }
}

/** 建完实例写基线：后面查“Pack 更新了什么、本地改了什么”都以它为准。 */
export function writeBaseline(root: string, baseline: Omit<Baseline, 'apiVersion' | 'at'>): Baseline {
  const value: Baseline = { apiVersion: 'packhub.dev/baseline/v0', at: nowIso(), ...baseline };
  const file = join(root, BASELINE);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
  return value;
}

export function readBaseline(root: string): Baseline | undefined {
  const file = join(root, BASELINE);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Baseline;
  } catch {
    return undefined;
  }
}
