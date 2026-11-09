import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { main } from '../src/cli.ts';
import { psReport } from '../src/ps.ts';
import type { InstanceRecord } from '../src/records.ts';

/** 固定的「现在」：运行时长断言不依赖机器时钟。 */
const NOW = Date.parse('2026-03-01T12:00:00.000Z');

let tmp: string;
let instancesDir: string;

function writeRecord(id: string, overrides: Partial<InstanceRecord> = {}): string {
  const dir = join(instancesDir, id);
  mkdirSync(dir, { recursive: true });
  const record: InstanceRecord = {
    apiVersion: 'packhub.dev/instance/v1',
    id,
    name: id,
    harness: 'dsh',
    root: dir,
    pack: { name: 'demo/ps-pack', version: '0.1.0' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    managed: true,
    ...overrides,
  };
  writeFileSync(join(dir, 'instance.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
  return dir;
}

/** 目录树指纹（相对路径 + 大小 + mtime）：只读账本前后必须完全一致。 */
function fingerprint(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(abs);
      } else if (entry.isFile()) {
        const stat = statSync(abs);
        out.push(`${rel}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-ps-'));
  instancesDir = join(tmp, 'instances');
  process.env.PACKHUB_INSTANCES = instancesDir;
  process.env.PACKHUB_HOME = join(tmp, 'home');
});

afterEach(() => {
  delete process.env.PACKHUB_INSTANCES;
  delete process.env.PACKHUB_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe('pal ps：并发账本', () => {
  it('两条 running 记录占同一端口 → 标出冲突；没有 pid 的 stopped 记录不进来', () => {
    const firstId = '20260101000000-aaaaaaaaaaaa';
    const secondId = '20260101000001-bbbbbbbbbbbb';
    writeRecord(firstId, {
      name: 'alpha',
      pid: process.pid,
      port: 43210,
      url: 'http://127.0.0.1:43210',
      startedAt: new Date(NOW - 90_000).toISOString(),
    });
    writeRecord(secondId, {
      name: 'beta',
      pid: process.pid,
      port: 43210,
      createdAt: '2026-01-02T00:00:00.000Z',
      startedAt: new Date(NOW - 5_000).toISOString(),
    });
    writeRecord('20260101000002-cccccccccccc', {
      name: 'sleepy',
      status: 'stopped',
      port: 43211,
      createdAt: '2026-01-03T00:00:00.000Z',
    });

    const report = psReport({ now: NOW });
    expect(report.instances.map((item) => item.name).sort()).toEqual(['alpha', 'beta']);

    const alpha = report.instances.find((item) => item.id === firstId)!;
    expect(alpha).toMatchObject({
      harness: 'dsh',
      pid: process.pid,
      port: 43210,
      url: 'http://127.0.0.1:43210',
      stale: false,
      uptimeMs: 90_000,
      uptime: '1m 30s',
    });
    expect(report.instances.find((item) => item.id === secondId)?.uptime).toBe('5s');

    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.port).toBe(43210);
    expect(report.conflicts[0]?.ids.slice().sort()).toEqual([firstId, secondId].sort());
    expect(report.conflicts[0]?.names.slice().sort()).toEqual(['alpha', 'beta']);
    expect(report.total).toEqual({
      instances: 2,
      running: 2,
      ports: 1,
      stale: 0,
      conflicts: 1,
    });
  });

  it('pid 已经不在 → 标 stale；instance.json 的内容与 mtime 都不变', () => {
    // 起一个立刻退出的子进程，拿它真实存在过、现在已死的 pid
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
    const deadPid = child.pid;
    expect(typeof deadPid).toBe('number');

    const dir = writeRecord('20260101000000-dddddddddddd', {
      name: 'ghost',
      pid: deadPid,
      port: 43212,
      startedAt: new Date(NOW - 3_600_000).toISOString(),
    });
    const file = join(dir, 'instance.json');
    const beforeText = readFileSync(file, 'utf8');
    const beforeMtime = statSync(file).mtimeMs;

    const report = psReport({ now: NOW });
    expect(report.instances).toHaveLength(1);
    expect(report.instances[0]).toMatchObject({
      id: '20260101000000-dddddddddddd',
      pid: deadPid,
      stale: true,
      uptime: '1h 0m',
    });
    expect(report.total).toMatchObject({ instances: 1, running: 0, stale: 1, conflicts: 0 });

    // 只标 stale，不刷新、不清 pid、不写盘
    expect(readFileSync(file, 'utf8')).toBe(beforeText);
    expect(statSync(file).mtimeMs).toBe(beforeMtime);
    expect(JSON.parse(beforeText).pid).toBe(deadPid);
  });

  it('空环境 → total 全 0，数组为空', () => {
    const report = psReport({ now: NOW });
    expect(report.instances).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(report.broken).toEqual([]);
    expect(report.total).toEqual({
      instances: 0,
      running: 0,
      ports: 0,
      stale: 0,
      conflicts: 0,
    });
  });

  it('只读：跑两遍账本，整棵实例目录（含 mtime）不变，也不产生隔离区', () => {
    writeRecord('20260101000000-eeeeeeeeeeee', {
      name: 'alive',
      pid: process.pid,
      port: 43213,
      startedAt: new Date(NOW - 1_000).toISOString(),
    });
    writeRecord('20260101000001-ffffffffffff', {
      name: 'dead',
      pid: 2_147_483_647,
      port: 43214,
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    const before = fingerprint(instancesDir);
    psReport({ now: NOW });
    psReport({ now: NOW });
    expect(fingerprint(instancesDir)).toEqual(before);
    expect(readdirSync(instancesDir).some((name) => name.startsWith('.'))).toBe(false);
  });
});

describe('pal ps CLI', () => {
  interface CommandShape {
    args?: Record<string, { type?: string; default?: unknown } | undefined>;
  }

  const command = (main as unknown as { subCommands?: Record<string, CommandShape | undefined> })
    .subCommands?.['ps'];

  it('挂了 ps 子命令，声明 --json（boolean，默认 false）', () => {
    expect(command, 'ps 应存在').toBeTruthy();
    expect(command?.args?.json?.type).toBe('boolean');
    expect(command?.args?.json?.default).toBe(false);
  });
});
