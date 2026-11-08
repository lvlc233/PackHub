import {
  readActiveMap,
  readInstance,
  requireInstance,
  writeActiveMap,
  type InstanceRecord,
} from './index.ts';

/** 每个宿主记住"当前用哪一份实例"；只是默认值，不排斥同时起多个。 */
export type ActiveMap = Record<string, string>;

export function readActive(): ActiveMap {
  return readActiveMap();
}

export function setActive(idOrName: string): InstanceRecord {
  const rec = requireInstance(idOrName);
  const map = readActiveMap();
  map[rec.harness] = rec.id;
  writeActiveMap(map);
  return rec;
}

export function clearActive(harness?: string): void {
  const map = readActiveMap();
  if (harness) {
    delete map[harness];
  } else {
    for (const key of Object.keys(map)) delete map[key];
  }
  writeActiveMap(map);
}

/** 某个宿主当前选中的实例。 */
export function activeInstance(harness: string): InstanceRecord | undefined {
  const id = readActiveMap()[harness];
  return id ? readInstance(id) : undefined;
}

export function activeEntries(): Array<{ harness: string; record?: InstanceRecord }> {
  const map = readActiveMap();
  return Object.entries(map).map(([harness, id]) => ({ harness, record: readInstance(id) }));
}
