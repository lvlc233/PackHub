import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPalServer, type PalServer } from '../src/server.ts';
import { resetHarnessCache } from '../src/harness.ts';

let tmp: string;
let server: PalServer;

const url = (path: string): string => `${server.url}${path.replace(/^\//, '')}`;

/** 界面就是这么发请求的：同一个头，同一个来源。 */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'application/json', 'x-pal-client': 'pal-ui', ...extra };
}

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url(path), { ...init, headers: headers((init.headers as Record<string, string>) ?? {}) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* 静态文件不是 JSON */
  }
  return { status: res.status, body: body as never };
}

async function json(path: string, init: RequestInit = {}): Promise<any> {
  const res = await call(path, init);
  if (res.status >= 400) throw new Error(JSON.stringify(res.body));
  return res.body;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-server-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  process.env.PACKHUB_HOME = join(tmp, 'home');
  delete process.env.PACKHUB_INDEX;
  server = await startPalServer({ port: 0 });
});

afterEach(async () => {
  await server.close();
  delete process.env.PACKHUB_INSTANCES;
  delete process.env.PACKHUB_HOME;
  resetHarnessCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('PAL 本地界面 API', () => {
  it('首页是界面，不是空响应', async () => {
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('PAL');
    expect(text).toContain('/app.js');
  });

  it('创建、列出、设为当前、看日志、体检、删除', async () => {
    const first = await json('/api/instances');
    expect(first.instances).toEqual([]);

    const rec = await json('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'web', harness: 'dir' }),
    });
    expect(rec.name).toBe('web');
    expect(rec.status).toBe('installed');

    const list = await json('/api/instances');
    expect(list.instances.map((item: { id: string }) => item.id)).toEqual([rec.id]);
    expect(list.active.dir).toBe(rec.id);

    await json(`/api/instances/${rec.id}/active`, { method: 'POST' });
    expect(await json('/api/active')).toEqual([{ harness: 'dir', id: rec.id }]);

    const logs = await json(`/api/instances/${rec.id}/logs`);
    expect(logs.text).toBe('');
    expect(Array.isArray(logs.files)).toBe(true);

    const health = await json(`/api/instances/${rec.id}/health`);
    expect(health.id).toBe(rec.id);
    expect(health.checks.map((check: { name: string }) => check.name)).toContain('baseline');

    const removed = await json(`/api/instances/${rec.id}`, { method: 'DELETE' });
    expect(removed.removed).toBe(true);
    expect((await json('/api/instances')).instances).toEqual([]);
  });

  it('跨源写请求被拒绝，缺客户端头的写请求也被拒绝', async () => {
    const cross = await fetch(url('/api/instances'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pal-client': 'pal-ui',
        origin: 'http://evil.example',
      },
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'evil', harness: 'dir' }),
    });
    expect(cross.status).toBe(403);
    expect(((await cross.json()) as { code: string }).code).toBe('forbidden');

    const noHeader = await fetch(url('/api/instances'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'csrf', harness: 'dir' }),
    });
    expect(noHeader.status).toBe(403);

    // 读接口不受影响
    expect((await call('/api/instances')).status).toBe(200);
  });

  it('未知实例 404、未知宿主 400，错误里带稳定 code', async () => {
    const missing = await call('/api/instances/nope/stop', { method: 'POST' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('unknown-instance');

    const badHarness = await call('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'x', harness: 'nope' }),
    });
    expect(badHarness.status).toBe(400);
    expect(badHarness.body.code).toBe('unknown-harness');
    expect(badHarness.body.hint).toContain('dsh');
  });

  it('缺字段 400；宿主发现结果带版本与可启动性', async () => {
    const res = await call('/api/instances', { method: 'POST', body: JSON.stringify({ name: 'x' }) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid-input');

    const harnesses = await json('/api/harnesses?probe=0');
    const ids = harnesses.map((item: { id: string }) => item.id);
    expect(ids).toEqual(['dir', 'dsh', 'claude-code', 'codex']);
    const claude = harnesses.find((item: { id: string }) => item.id === 'claude-code');
    expect(claude.startable).toBe(false);
    expect(claude.reason).toContain('Claude Code');
  });

  it('包列表带版本；没有索引时也能列本地 Pack', async () => {
    const packs = await json('/api/packs');
    expect(packs.index).toBeNull();
    expect(Array.isArray(packs.local)).toBe(true);
  });

  it('更新接口：同一个 Pack 同一版本不产生变化', async () => {
    const rec = await json('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'upd-me', harness: 'dir' }),
    });
    const result = await json(`/api/instances/${rec.id}/update`, { method: 'POST', body: '{}' });
    expect(result.changed).toBe(false);
    expect(result.to).toBe('lvlc233/doc-review@0.1.0');
  });

  it('打开实例：服务端把凭据拼回去，接口本身不吐 token', async () => {    const rec = await json('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'opened', harness: 'dir' }),
    });
    // 没有地址时明确报错，而不是给一个空跳转
    const res = await call(`/api/instances/${rec.id}/open`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not-running');
  });
});
