import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPalServer, type PalServer } from '../src/server.ts';

let tmp: string;
let server: PalServer;

const url = (path: string): string => `${server.url}${path.replace(/^\//, '')}`;
const json = async (path: string, init?: RequestInit): Promise<unknown> => {
  const res = await fetch(url(path), init);
  const body = (await res.json()) as unknown;
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body;
};

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-server-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  server = await startPalServer({ port: 0 });
});

afterEach(async () => {
  await server.close();
  delete process.env.PACKHUB_INSTANCES;
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

  it('创建、列出、设为当前、看日志、删除', async () => {
    expect(await json('/api/instances')).toEqual([]);

    const rec = (await json('/api/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pack: 'examples/doc-review', name: 'web', harness: 'dir' }),
    })) as { id: string; name: string; status: string };
    expect(rec.name).toBe('web');
    expect(rec.status).toBe('installed');

    const list = (await json('/api/instances')) as Array<{ id: string }>;
    expect(list.map((item) => item.id)).toEqual([rec.id]);

    await json(`/api/instances/${rec.id}/active`, { method: 'POST' });
    expect(await json('/api/active')).toEqual([{ harness: 'dir', id: rec.id }]);

    expect(await json(`/api/instances/${rec.id}/logs`)).toEqual({ log: '' });

    await json(`/api/instances/${rec.id}`, { method: 'DELETE' });
    expect(await json('/api/instances')).toEqual([]);
  });

  it('缺字段时 400', async () => {
    const res = await fetch(url('/api/instances'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(400);
  });
});
