import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { instancesRoot, readInstance, type InstanceRecord } from './index.ts';

/** 每个宿主记住"当前用哪一份实例配置"；只是默认值，不排斥同时起多个。 */
type ActiveMap = Record<string, string>;

function activePath(): string {
  return join(instancesRoot(), '.active.json');
}

export function readActive(): ActiveMap {
  const file = activePath();
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as ActiveMap;
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeActive(map: ActiveMap): void {
  mkdirSync(instancesRoot(), { recursive: true });
  writeFileSync(activePath(), JSON.stringify(map, null, 2) + '\n', 'utf8');
}

export function setActive(idOrName: string): InstanceRecord {
  const rec = readInstance(idOrName);
  if (!rec) throw new Error(`没有这个实例：${idOrName}`);
  const map = readActive();
  map[rec.harness] = rec.id;
  writeActive(map);
  return rec;
}

export function clearActive(harness?: string): void {
  const map = readActive();
  if (harness) {
    delete map[harness];
  } else {
    for (const key of Object.keys(map)) delete map[key];
  }
  writeActive(map);
}

/** 某个宿主当前选中的实例。 */
export function activeInstance(harness: string): InstanceRecord | undefined {
  const id = readActive()[harness];
  return id ? readInstance(id) : undefined;
}

export function activeEntries(): Array<{ harness: string; record?: InstanceRecord }> {
  const map = readActive();
  return Object.entries(map).map(([harness, id]) => ({ harness, record: readInstance(id) }));
}
