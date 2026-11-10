import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreCall, ensureCore, probeCore } from '../src/coreClient.ts';
import { coreFilePath, type CoreInfo } from '../src/core.ts';
import { isPalError } from '../src/errors.ts';

let tmp: string;
const servers: Server[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-core-client-'));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** 假 core：只答 health 与 rpc；pid 用本进程，让 probeCore 的存活检查过。 */
async function fakeCore(options: { healthOk?: boolean; rpc?: (op: string) => { status: number; body: unknown } } = {}) {
  const token = 'tok-' + Math.random().toString(16).slice(2);
  const rpcHandler = options.rpc ?? (() => ({ status: 200, body: { ok: true, result: { ok: true } } }));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.headers['x-pal-token'] !== token) {
      res.writeHead(403).end('{}');
      return;
    }
    if (url.pathname === '/health') {
      if (options.healthOk === false) {
        res.writeHead(500).end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += String(chunk)));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}') as { op?: string };
      const answer = rpcHandler(String(payload.op ?? ''));
      res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const info: CoreInfo = {
    apiVersion: 'packhub.dev/pal/core/v1',
    pid: process.pid,
    host: '127.0.0.1',
    port,
    url: `http://127.0.0.1:${port}/`,
    token,
    startedAt: new Date().toISOString(),
    version: '0.0.0-test',
    home: tmp,
  };
  writeFileSync(coreFilePath(tmp), JSON.stringify(info, null, 2), 'utf8');
  return info;
}

/** 假的 node:child_process spawn：调用方自己决定“子进程”做什么。 */
function fakeSpawn(run: () => void) {
  return vi.fn((_file: string, _args: string[], _options: Record<string, unknown>) => {
    run();
    return { exitCode: null, unref: () => {} } as never;
  });
}

describe('core 客户端：发现与按需拉起', () => {
  it('没有 core.json 就当没有 core', async () => {
    expect(await probeCore({ home: tmp })).toBeUndefined();
  });

  it('core.json 指向死 pid 时不连（不拿旧地址当活的）', async () => {
    const info = await fakeCore();
    writeFileSync(coreFilePath(tmp), JSON.stringify({ ...info, pid: 2_147_483_647 }), 'utf8');
    expect(await probeCore({ home: tmp })).toBeUndefined();
  });

  it('health 不通（core 崩了但 pid 还在）也当没有 core', async () => {
    await fakeCore({ healthOk: false });
    expect(await probeCore({ home: tmp })).toBeUndefined();
  });

  it('已经有 core：ensureCore 不 spawn', async () => {
    const info = await fakeCore();
    const spawn = fakeSpawn(() => {});
    const found = await ensureCore({ home: tmp, spawn: spawn as never });
    expect(found.pid).toBe(info.pid);
    expect(found.url).toBe(info.url);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('没有 core：spawn 一个，等 /health 通了就返回', async () => {
    const spawn = fakeSpawn(() => {
      void fakeCore();
    });
    const info = await ensureCore({ home: tmp, spawn: spawn as never, waitMs: 5000 });
    expect(info.pid).toBe(process.pid);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [file, args] = spawn.mock.calls[0]!;
    expect(file).toBe(process.execPath);
    expect(args.slice(-2)).toEqual(['core', 'run']);
  });

  it('spawn 了也等不到 health：core-unavailable，并把 home 带进 details', async () => {
    const spawn = fakeSpawn(() => {});
    await expect(ensureCore({ home: tmp, spawn: spawn as never, waitMs: 400 })).rejects.toSatisfy(
      (err: unknown) => isPalError(err) && err.code === 'core-unavailable' && err.details?.home === tmp,
    );
  });
});

describe('core 客户端：发命令', () => {
  it('成功时返回 core 的结果', async () => {
    await fakeCore({ rpc: () => ({ status: 200, body: { ok: true, result: { id: 'abc' } } }) });
    await expect(coreCall<{ id: string }>('start', { id: 'abc' }, { home: tmp })).resolves.toEqual({ id: 'abc' });
  });

  it('失败时把 code / hint 原样带回，调用方不必解析文案', async () => {
    await fakeCore({
      rpc: () => ({
        status: 404,
        body: { ok: false, code: 'not-found', error: '没有这个实例', hint: '先 pal list' },
      }),
    });
    const err = await coreCall('stop', { id: 'nope' }, { home: tmp }).catch((e: unknown) => e);
    expect(isPalError(err)).toBe(true);
    if (isPalError(err)) {
      expect(err.code).toBe('not-found');
      expect(err.hint).toBe('先 pal list');
      expect(err.status).toBe(404);
    }
  });

  it('调用中途 core 没了：重新拉起后再试一次', async () => {
    const first = await fakeCore({ rpc: () => ({ status: 200, body: { ok: true, result: { gen: 1 } } }) });
    const old = servers.pop()!;
    const spawn = fakeSpawn(() => {
      void fakeCore({ rpc: () => ({ status: 200, body: { ok: true, result: { gen: 2 } } }) });
    });
    old.closeAllConnections?.();
    await new Promise<void>((resolve) => old.close(() => resolve()));

    const result = await coreCall<{ gen: number }>('start', {}, { home: tmp, spawn: spawn as never, waitMs: 5000 });
    expect(result.gen).toBe(2);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(first.url).not.toContain(':0');
  });
});
