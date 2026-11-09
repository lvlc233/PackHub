import { describe, expect, it } from 'vitest';
import {
  API_VERSION,
  mergeRecord,
  partitionRecord,
  type InstanceConfig,
  type InstanceRecord,
  type RuntimeState,
} from '../src/records.ts';

/**
 * 记录的类型分层：配置（InstanceConfig）与运行态（RuntimeState）只是类型上分开，
 * 持久化仍是同一个 instance.json。这里守两件事：往返不丢字段（含可选缺省与未知字段），
 * 以及拆分不把两边的字段混到对方那半。
 */

function minimalRecord(): InstanceRecord {
  return {
    apiVersion: API_VERSION,
    id: '20260101000000-abcdef123456',
    name: 'demo',
    harness: 'dsh',
    root: 'G:/tmp/pal/demo',
    pack: { name: 'demo/pack', version: '1.0.0' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    managed: true,
    status: 'installed',
    ports: [],
  };
}

function fullRecord(): InstanceRecord {
  return {
    ...minimalRecord(),
    harnessVersion: '0.9.0',
    home: 'G:/tmp/pal/demo/home',
    isolation: {
      version: 1,
      layers: {
        assembly: 'instance',
        session: 'instance',
        credentials: 'instance',
        cache: 'shared',
        runtime: 'shared',
      },
    },
    origin: { kind: 'pack', ref: 'demo/pack@1.0.0', dir: 'G:/packs/demo' },
    restart: 'on-failure',
    maxRestarts: 5,
    status: 'running',
    pid: 4321,
    spawnPid: 9999,
    listenPid: 4321,
    port: 5123,
    ports: [5000, 5123],
    url: 'http://127.0.0.1:5123/',
    startedAt: '2026-01-01T00:01:00.000Z',
    lastExit: { code: 1, signal: null, at: '2026-01-01T00:02:00.000Z', restarts: 2 },
    lastError: { code: 'start-failed', message: '宿主退出', at: '2026-01-01T00:02:00.000Z' },
  };
}

describe('记录分层：partitionRecord / mergeRecord', () => {
  it('可选字段缺省：往返后与原记录相等，运行态不会补出空键', () => {
    const rec = minimalRecord();
    const { config, runtime } = partitionRecord(rec);

    expect(mergeRecord(config, runtime)).toEqual(rec);
    expect(runtime.status).toBe('installed');
    expect(runtime.ports).toEqual([]);
    for (const key of ['pid', 'spawnPid', 'listenPid', 'port', 'url', 'startedAt', 'lastExit', 'lastError']) {
      expect(key in runtime).toBe(false);
    }
    for (const key of ['harnessVersion', 'home', 'isolation', 'origin', 'restart', 'maxRestarts']) {
      expect(key in config).toBe(false);
    }
  });

  it('旧记录没有 ports：往返保持缺省，不凭空补字段', () => {
    const { ports: _ports, ...legacy } = minimalRecord();

    const { config, runtime } = partitionRecord(legacy);

    expect('ports' in runtime).toBe(false);
    expect(mergeRecord(config, runtime)).toEqual(legacy);
  });

  it('字段齐全：往返后与原记录相等', () => {
    const rec = fullRecord();
    const { config, runtime } = partitionRecord(rec);

    expect(mergeRecord(config, runtime)).toEqual(rec);
    expect(runtime).toEqual({
      status: 'running',
      pid: 4321,
      spawnPid: 9999,
      listenPid: 4321,
      port: 5123,
      ports: [5000, 5123],
      url: 'http://127.0.0.1:5123/',
      startedAt: '2026-01-01T00:01:00.000Z',
      lastExit: { code: 1, signal: null, at: '2026-01-01T00:02:00.000Z', restarts: 2 },
      lastError: { code: 'start-failed', message: '宿主退出', at: '2026-01-01T00:02:00.000Z' },
    });
  });

  it('配置侧不残留运行态字段，运行态侧不混进配置字段', () => {
    const { config, runtime } = partitionRecord(fullRecord());

    for (const key of ['status', 'pid', 'spawnPid', 'listenPid', 'port', 'ports', 'url', 'startedAt', 'lastExit', 'lastError']) {
      expect(key in config).toBe(false);
    }
    expect('root' in runtime).toBe(false);
    expect('updatedAt' in runtime).toBe(false);
  });

  it('未知/未来字段走展开保留，往返不丢', () => {
    const rec = {
      ...fullRecord(),
      futureConfigField: { enabled: true },
      futureRuntimeField: ['a', 'b'],
    } as unknown as InstanceRecord;

    const { config, runtime } = partitionRecord(rec);
    const merged = mergeRecord(config, runtime) as unknown as Record<string, unknown>;

    expect(merged.futureConfigField).toEqual({ enabled: true });
    // 运行态字段清单是显式的：未登记的新字段留在 config 侧，也照样不丢
    expect(merged.futureRuntimeField).toEqual(['a', 'b']);
  });

  it('纯函数：不改入参，且可以单独换掉运行态', () => {
    const rec = fullRecord();
    const snapshot = structuredClone(rec);
    const { config, runtime } = partitionRecord(rec);
    expect(rec).toEqual(snapshot);

    const stopped: RuntimeState = { ...runtime, status: 'stopped' };
    delete stopped.pid;
    delete stopped.spawnPid;
    delete stopped.listenPid;
    delete stopped.port;
    delete stopped.url;
    const merged = mergeRecord(config, stopped);

    expect(merged.status).toBe('stopped');
    expect('pid' in merged).toBe(false);
    expect('url' in merged).toBe(false);
    expect(merged.ports).toEqual([5000, 5123]);
    expect(merged.id).toBe(rec.id);
    expect(merged.updatedAt).toBe(rec.updatedAt);
  });

  it('config / runtime 可独立构造后合回一条记录', () => {
    const config: InstanceConfig = {
      apiVersion: API_VERSION,
      id: 'id-1',
      name: 'n',
      harness: 'dir',
      root: 'G:/tmp/n',
      pack: { name: 'p', version: '0.0.0' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      managed: false,
    };

    const runtime: RuntimeState = { status: 'broken', ports: [1], lastError: { code: 'x', message: 'y', at: 'z' } };
    const merged = mergeRecord(config, runtime);

    expect(merged.status).toBe('broken');
    expect(merged.ports).toEqual([1]);
    expect(merged.managed).toBe(false);
  });
});
