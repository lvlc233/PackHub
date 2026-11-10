import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { API_VERSION, partitionRecord, recordFile, runtimeFile, type InstanceRecord } from './records.ts';
import { nowIso } from './time.ts';
import { instancesRoot } from './paths.ts';

/**
 * 写实例记录：记录本体（recordFile/runtimeFile/API_VERSION/读取）在 records.ts，这里只放带副作用的写。
 * 写记录同时维护 .links 指针，所以它不能待在纯读模块里；也不从入口模块 import（避免循环）。
 */

function linksDir(): string {
  return join(instancesRoot(), '.links');
}

function linkFile(id: string): string {
  return join(linksDir(), `${id}.json`);
}

function insideInstances(dir: string): boolean {
  const base = resolve(instancesRoot());
  const target = resolve(dir);
  return target === base || target.startsWith(base + sep) || target.startsWith(base + '/');
}

/**
 * 接管的目录在实例根之外：记录仍然写在那个目录里（root 就是身份），
 * 另外在 .links 留一个指针，列表才找得到它。删指针不动用户的目录。
 */
function writeLink(record: InstanceRecord): void {
  const file = linkFile(record.id);
  if (insideInstances(record.root)) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(linksDir(), { recursive: true });
  writeFileSync(file, JSON.stringify({ id: record.id, name: record.name, root: record.root }, null, 2) + '\n', 'utf8');
}

export function removeLink(id: string): void {
  rmSync(linkFile(id), { force: true });
}

/** 原子写：临时文件 + rename。写到一半崩溃只会留临时文件，不会留半份 JSON。 */
function writeAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 临时文件删不掉就留着，不影响主流程 */
    }
    throw err;
  }
}

/**
 * 写记录：拆成 config（instance.json）与 runtime（runtime.json）两份，各自原子。
 * 先写 runtime 再写 instance：崩在中间时 runtime 是新的、config 是旧的；
 * 读取以 runtime 为准，运行态不会丢，配置也还是原来那份能读的。
 */
export function writeInstance(record: InstanceRecord): void {
  const next: InstanceRecord = { ...record, apiVersion: API_VERSION, updatedAt: nowIso() };
  const { config, runtime } = partitionRecord(next);
  writeAtomic(runtimeFile(next.root), runtime);
  writeAtomic(recordFile(next.root), config);
  record.updatedAt = next.updatedAt;
  writeLink(next);
}
