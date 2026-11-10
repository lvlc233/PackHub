import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_LOCK,
  coreFilePath,
  coreLockPath,
  readCoreInfo,
  startCore,
  type PalCore,
} from '../src/core.ts';
import { isPalError } from '../src/errors.ts';
import type { InstanceRecord } from '../src/records.ts';
import type { WatchStats } from '../src/watch.ts';

let tmp: string;
let homes: PalCore[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-core-'));
});

afterEach(async () => {
  for (const core of homes) await core.close().catch(() => {});
  homes = [];
  rmSync(tmp, { recursive: true, force: true });
});

/** 一条能过类型检查的最小记录：core 只把它原样转给客户端。 */
function record(id: string, status: InstanceRecord['status'] = 'running'): InstanceRecord {
  return { id, name: id, status } as unknown as InstanceRecord;
}

const emptyStats: WatchStats = { checked: 0, restarted: 0, broken: 0, skipped: 0 };

async function call(core: PalCore, op: string, params: Record<string, unknown> = {}) {
  const res = await fetch(new URL('rpc', core.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pal-token': core.token },
    body: JSON.stringify({ op, params }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('core：单例、发现、转发', () => {
  it('起来就写 core.json（pid/url/token），/health 用 token 认人', async () => {
    const core = await startCore({ home: tmp, supervise: false, log: () => {} });
    homes.push(core);

    const saved = readCoreInfo(tmp);
    expect(saved?.pid).toBe(process.pid);
    expect(saved?.url).toBe(core.url);
    expect(saved?.token).toBe(core.token);

    const ok = await fetch(new URL('health', core.url), { headers: { 'x-pal-token': core.token } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.pid).toBe(process.pid);

    const denied = await fetch(new URL('health', core.url));
    expect(denied.status).toBe(403);
  });

  it('同一个 home 只许一个 core：第二个拿到 busy，第一个照常服务', async () => {
    const first = await startCore({ home: tmp, supervise: false, log: () => {} });
    homes.push(first);

    await expect(startCore({ home: tmp, supervise: false, log: () => {} })).rejects.toSatisfy(
      (err: unknown) => isPalError(err) && err.code === 'busy',
    );

    const health = await fetch(new URL('health', first.url), { headers: { 'x-pal-token': first.token } });
    expect(health.status).toBe(200);
  });

  it('start/stop/restart 转给注入的实现，参数原样过去', async () => {
    const start = vi.fn(async (id: string, params: { port?: number }) => record(`${id}:${params.port ?? '-'}`));
    const stop = vi.fn(async (id: string, force: boolean) => record(`${id}:${force ? 'force' : 'soft'}`, 'stopped'));
    const restart = vi.fn(async (id: string) => record(`${id}:restart`));
    const core = await startCore({ home: tmp, supervise: false, log: () => {}, ops: { start, stop, restart } });
    homes.push(core);

    const started = await call(core, 'start', { id: 'a', port: 5123 });
    expect(started.status).toBe(200);
    expect(started.body.result.id).toBe('a:5123');
    expect(start).toHaveBeenCalledWith('a', { port: 5123 });

    const stopped = await call(core, 'stop', { id: 'b', force: true });
    expect(stopped.body.result.id).toBe('b:force');
    expect(stop).toHaveBeenCalledWith('b', true);

    const restarted = await call(core, 'restart', { id: 'c' });
    expect(restarted.body.result.id).toBe('c:restart');
    expect(restart).toHaveBeenCalledWith('c');
  });

  it('未知操作与坏 token 都按语义拒绝', async () => {
    const core = await startCore({ home: tmp, supervise: false, log: () => {} });
    homes.push(core);

    const unknown = await call(core, 'nope');
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('invalid-input');

    const bad = await fetch(new URL('rpc', core.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pal-token': 'wrong' },
      body: JSON.stringify({ op: 'status' }),
    });
    expect(bad.status).toBe(403);
  });

  it('后台看护先跑一轮（启动即接管），结果可再手动要一次', async () => {
    const watch = vi.fn(async () => emptyStats);
    const core = await startCore({ home: tmp, log: () => {}, intervalMs: 60_000, ops: { watch } });
    homes.push(core);

    // 启动那一轮是接管：等它落到 mock 上
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1));
    const again = await call(core, 'watch');
    expect(again.status).toBe(200);
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it('shutdown 之后 core.json 与锁都清掉，端口不再接客', async () => {
    const core = await startCore({ home: tmp, supervise: false, log: () => {} });
    expect(existsSync(join(tmp, CORE_LOCK))).toBe(true);

    const bye = await call(core, 'shutdown');
    expect(bye.body.result.stopping).toBe(true);

    await vi.waitFor(() => expect(existsSync(coreFilePath(tmp))).toBe(false), { timeout: 3000 });
    expect(existsSync(coreLockPath(tmp))).toBe(false);
    expect(readCoreInfo(tmp)).toBeUndefined();
    await expect(fetch(new URL('health', core.url), { headers: { 'x-pal-token': core.token } })).rejects.toThrow();
  });

  it('core.json 坏了就当作没有 core；读得出来也不代表人还活着', async () => {
    const file = coreFilePath(tmp);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        apiVersion: 'packhub.dev/pal/core/v1',
        pid: 99_999_999,
        host: '127.0.0.1',
        port: 1,
        url: 'http://127.0.0.1:1/',
        token: 't',
        startedAt: new Date().toISOString(),
        version: '0.0.0-test',
        home: tmp,
      }),
      'utf8',
    );
    // readCoreInfo 只解析；pid 死活由 probeCore 判
    expect(readCoreInfo(tmp)?.pid).toBe(99_999_999);
    writeFileSync(file, 'not json', 'utf8');
    expect(readCoreInfo(tmp)).toBeUndefined();
  });
});
