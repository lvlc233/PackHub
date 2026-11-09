import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceRecord } from '../src/records.ts';
import { readEvents } from '../src/logs.ts';
import { main } from '../src/cli.ts';
import { DEFAULT_WATCH_INTERVAL_MS, watchLoop, watchOnce } from '../src/watch.ts';

let tmp: string;
let instancesDir: string;

/** 一个一定已经死掉的 pid（不在活进程表里）。 */
const DEAD_PID = 2_147_483_647;

function writeRecord(id: string, overrides: Partial<InstanceRecord> = {}): string {
  const dir = join(instancesDir, id);
  mkdirSync(dir, { recursive: true });
  const record: InstanceRecord = {
    apiVersion: 'packhub.dev/instance/v1',
    id,
    name: id,
    harness: 'dsh',
    root: dir,
    pack: { name: 'demo/watch-pack', version: '0.1.0' },
    planHash: 'abc',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    managed: true,
    ...overrides,
  };
  writeFileSync(join(dir, 'instance.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
  return dir;
}

function readRecordFile(id: string): InstanceRecord {
  return JSON.parse(readFileSync(join(instancesDir, id, 'instance.json'), 'utf8')) as InstanceRecord;
}

function writeRunning(id: string, pid: number): void {
  const rec = readRecordFile(id);
  writeFileSync(
    join(instancesDir, id, 'instance.json'),
    JSON.stringify(
      { ...rec, status: 'running', pid, port: 43001, url: `http://127.0.0.1:43001` },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

function eventsOf(id: string): Array<Record<string, unknown>> {
  return readEvents(join(instancesDir, id), 50);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-watch-'));
  instancesDir = join(tmp, 'instances');
  process.env.PACKHUB_INSTANCES = instancesDir;
  process.env.PACKHUB_HOME = join(tmp, 'home');
});

afterEach(() => {
  delete process.env.PACKHUB_INSTANCES;
  delete process.env.PACKHUB_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe('pal watch：headless 看护', () => {
  it('on-failure 死 pid → start 调用一次，lastExit.restarts+1，记录回到 running', async () => {
    const id = '20260101000000-aaaaaaaaaaaa';
    writeRecord(id, {
      pid: DEAD_PID,
      port: 43000,
      url: 'http://127.0.0.1:43000',
      restart: 'on-failure',
      maxRestarts: 3,
      lastExit: { code: 1, signal: null, at: '2026-01-01T00:00:00.000Z', restarts: 1 },
    });
    const start = vi.fn(async (target: string) => {
      writeRunning(target, 4242);
    });

    const stats = await watchOnce({ isAlive: (pid) => pid !== DEAD_PID, start });

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(id);
    const rec = readRecordFile(id);
    expect(rec.status).toBe('running');
    expect(rec.pid).toBe(4242);
    expect(rec.lastExit?.restarts).toBe(2);
    expect(eventsOf(id).some((event) => event.event === 'watch-restart')).toBe(true);
    expect(stats).toEqual({ checked: 1, restarted: 1, broken: 0, skipped: 0 });
  });

  it('restarts 已到 max → 写 broken，start 不调用', async () => {
    const id = '20260101000000-bbbbbbbbbbbb';
    writeRecord(id, {
      pid: DEAD_PID,
      port: 43010,
      url: 'http://127.0.0.1:43010',
      restart: 'on-failure',
      maxRestarts: 3,
      lastExit: { code: 1, signal: null, at: '2026-01-01T00:00:00.000Z', restarts: 3 },
    });
    const start = vi.fn();

    const stats = await watchOnce({ isAlive: (pid) => pid !== DEAD_PID, start });

    expect(start).not.toHaveBeenCalled();
    const rec = readRecordFile(id);
    expect(rec.status).toBe('broken');
    expect(rec.pid).toBeUndefined();
    expect(rec.port).toBeUndefined();
    expect(rec.url).toBeUndefined();
    expect(rec.lastExit?.restarts).toBe(3);
    expect(eventsOf(id).some((event) => event.event === 'watch-exit')).toBe(true);
    expect(stats).toEqual({ checked: 1, restarted: 0, broken: 1, skipped: 0 });
  });

  it("restart='never' 的死 pid → 直接标 broken", async () => {
    const id = '20260101000000-cccccccccccc';
    writeRecord(id, {
      pid: DEAD_PID,
      port: 43020,
      url: 'http://127.0.0.1:43020',
      restart: 'never',
    });
    const start = vi.fn();

    const stats = await watchOnce({ isAlive: (pid) => pid !== DEAD_PID, start });

    expect(start).not.toHaveBeenCalled();
    const rec = readRecordFile(id);
    expect(rec.status).toBe('broken');
    expect(rec.pid).toBeUndefined();
    expect(rec.port).toBeUndefined();
    expect(rec.url).toBeUndefined();
    expect(stats).toEqual({ checked: 1, restarted: 0, broken: 1, skipped: 0 });
  });

  it('活着的 running 与 stopped / installing 记录完全不动（内容与 mtime 不变）', async () => {
    const aliveId = '20260101000000-dddddddddddd';
    const stoppedId = '20260101000001-eeeeeeeeeeee';
    const installingId = '20260101000002-ffffffffffff';
    writeRecord(aliveId, { pid: 1111, port: 43030, url: 'http://127.0.0.1:43030' });
    writeRecord(stoppedId, { status: 'stopped', name: 'stopped' });
    writeRecord(installingId, { status: 'installing', name: 'installing' });

    const ids = [aliveId, stoppedId, installingId];
    const before = ids.map((id) => {
      const file = join(instancesDir, id, 'instance.json');
      return { text: readFileSync(file, 'utf8'), mtime: statSync(file).mtimeMs };
    });
    const start = vi.fn();

    const stats = await watchOnce({ isAlive: (pid) => pid === 1111, start });

    expect(start).not.toHaveBeenCalled();
    ids.forEach((id, index) => {
      const file = join(instancesDir, id, 'instance.json');
      expect(readFileSync(file, 'utf8')).toBe(before[index]!.text);
      expect(statSync(file).mtimeMs).toBe(before[index]!.mtime);
    });
    expect(stats).toEqual({ checked: 3, restarted: 0, broken: 0, skipped: 3 });
  });

  it('watchLoop 用 AbortController 跑一轮即停，返回这一轮统计', async () => {
    const id = '20260101000000-111111111111';
    writeRecord(id, {
      pid: DEAD_PID,
      port: 43040,
      url: 'http://127.0.0.1:43040',
      restart: 'on-failure',
      maxRestarts: 3,
    });
    const start = vi.fn(async (target: string) => {
      writeRunning(target, 4243);
    });
    const controller = new AbortController();

    const stats = await watchLoop({
      intervalMs: 60_000,
      signal: controller.signal,
      isAlive: (pid) => pid !== DEAD_PID,
      start,
      onRound: () => controller.abort(),
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(stats).toEqual({ checked: 1, restarted: 1, broken: 0, skipped: 0 });
    expect(DEFAULT_WATCH_INTERVAL_MS).toBe(2000);
  });
});

describe('pal watch CLI', () => {
  interface CommandShape {
    args?: Record<string, { type?: string; default?: unknown } | undefined>;
  }

  const command = (main as unknown as { subCommands?: Record<string, CommandShape | undefined> })
    .subCommands?.['watch'];

  it('挂了 watch 子命令，--interval 是字符串，默认 2000', () => {
    expect(command, 'watch 应存在').toBeTruthy();
    expect(command?.args?.interval?.type).toBe('string');
    expect(command?.args?.interval?.default).toBe('2000');
  });
});
