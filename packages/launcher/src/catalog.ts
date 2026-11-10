import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PalError } from './errors.ts';
import { instancesRoot } from './paths.ts';
import { quarantineInstance } from './quarantine.ts';
import { readRecordResult, type InstanceRecord } from './records.ts';

/**
 * 实例清单与「当前实例」一览表：扫实例根、按名字/身份找记录、坏记录隔离，以及每个宿主记住的默认实例。
 * 只依赖 fs/path、records.ts、quarantine.ts、paths.ts 与 PalError；不 import index.ts（避免循环）。
 * 建/删/改实例的写入流程在 create.ts / update.ts / remove.ts / migrate.ts；index.ts 只做 re-export。
 */

/** 实例根清单：正常记录 + 坏记录（坏记录不静默消失，移进隔离区并留下原因）。 */
export interface InstanceScan {
  records: InstanceRecord[];
  broken: Array<{ dir: string; reason: string; quarantined?: string; link?: string }>;
}

/* ---------- 列表 ---------- */

/** 扫实例根；坏记录只报告不移动（读操作不该有副作用）。 */
export function scanInstances(): InstanceScan {
  const base = instancesRoot();
  if (!existsSync(base)) return { records: [], broken: [] };
  const records: InstanceRecord[] = [];
  const broken: InstanceScan['broken'] = [];
  const seen = new Set<string>();
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(base, entry.name);
    const read = readRecordResult(dir);
    if (read.record) {
      records.push(read.record);
      seen.add(read.record.id);
    } else {
      broken.push({ dir, reason: read.error ?? '未知原因' });
    }
  }
  // 接管来的实例：记录在用户目录里，列表靠 .links 找到
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name !== '.links') continue;
    for (const link of safeFiles(join(base, entry.name))) {
      try {
        const data = JSON.parse(readFileSync(link.file, 'utf8')) as { id?: string; root?: string };
        if (!data.id || !data.root) throw new Error('指针缺字段');
        if (seen.has(data.id)) continue;
        const read = readRecordResult(data.root);
        if (read.record) {
          records.push(read.record);
          seen.add(read.record.id);
        } else {
          broken.push({ dir: data.root, reason: read.error ?? '未知原因', link: link.file });
        }
      } catch (err) {
        broken.push({ dir: link.file, reason: `指针读不了：${(err as Error).message}`, link: link.file });
      }
    }
  }
  records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { records, broken };
}

function safeFiles(dir: string): Array<{ file: string }> {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({ file: join(dir, entry.name) }));
  } catch {
    return [];
  }
}

/** 列出实例；坏记录默认移进隔离区，不再从列表里凭空消失。 */
export function listInstances(opts: { quarantine?: boolean } = {}): InstanceRecord[] {
  const scan = scanInstances();
  if (opts.quarantine === false) return scan.records;
  for (const bad of scan.broken) {
    const moved = quarantineInstance(bad.dir, bad.reason, bad.link);
    if (moved) bad.quarantined = moved;
  }
  return scan.records;
}

export function readInstance(nameOrId: string): InstanceRecord | undefined {
  return listInstances().find((i) => i.id === nameOrId || i.name === nameOrId);
}

export function requireInstance(nameOrId: string): InstanceRecord {
  const record = readInstance(nameOrId);
  if (!record) {
    throw new PalError('unknown-instance', `没有这个实例：${nameOrId}`, {
      hint: 'pal list 看现有实例',
      details: { target: nameOrId },
    });
  }
  return record;
}

/* ---------- 当前实例（每个宿主一个默认） ---------- */

export type ActiveMap = Record<string, string>;

export function activeMapPath(): string {
  return join(instancesRoot(), '.active.json');
}

export function readActiveMap(): ActiveMap {
  const file = activeMapPath();
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as ActiveMap;
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function writeActiveMap(map: ActiveMap): void {
  mkdirSync(instancesRoot(), { recursive: true });
  const file = activeMapPath();
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

/** 删除/改名实例后把指向它的默认值清掉；只在包内用，index.ts 不对外导出。 */
export function dropActive(id: string): void {
  const map = readActiveMap();
  let touched = false;
  for (const [harness, value] of Object.entries(map)) {
    if (value === id) {
      delete map[harness];
      touched = true;
    }
  }
  if (touched) writeActiveMap(map);
}
