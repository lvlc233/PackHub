import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { API_VERSION, recordFile, type InstanceRecord } from './records.ts';
import { nowIso } from './time.ts';
import { instancesRoot } from './paths.ts';

/**
 * 写实例记录：记录本体（recordFile/API_VERSION/读取）在 records.ts，这里只放带副作用的写。
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

/** 原子写：临时文件 + rename。写到一半崩溃只会留临时文件，不会留半份配置。 */
export function writeInstance(record: InstanceRecord): void {
  const next: InstanceRecord = { ...record, apiVersion: API_VERSION, updatedAt: nowIso() };
  const file = recordFile(record.root);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
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
  record.updatedAt = next.updatedAt;
  writeLink(next);
}
