import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHub } from '../src/index.ts';

let server: Awaited<ReturnType<typeof startHub>>;
let base = '';

beforeAll(async () => {
  server = await startHub({ root: process.cwd(), port: 0 });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
});

describe('Hub（只读发布端）', () => {
  it('给索引与包页数据', async () => {
    const idx = await fetch(`${base}/api/registry`);
    expect(idx.status).toBe(200);
    const data = (await idx.json()) as { packs: { name: string }[] };
    expect(Array.isArray(data.packs)).toBe(true);

    const name = data.packs[0]?.name;
    if (!name) return;
    const pack = await fetch(`${base}/api/registry/pack?name=${encodeURIComponent(name)}`);
    expect(pack.status).toBe(200);
    const detail = (await pack.json()) as { manifest: string; verify: unknown };
    expect(detail.manifest).toContain('apiVersion: packhub.dev/v0');
  });

  it('计划预览照常，但没有任何执行接口', async () => {
    const planRes = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/hub, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: x
    type: knowledge
    source: https://example.com/a.md
    integrity: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
`,
        target: 'dir',
      }),
    });
    const planBody = (await planRes.json()) as { plan: { actions: unknown[] } | null };
    expect(planBody.plan).toBeTruthy();

    for (const path of ['/api/install', '/api/verify', '/api/packs']) {
      const isGet = path === '/api/packs';
      const res = await fetch(`${base}${path}`, {
        method: isGet ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(isGet ? {} : { body: JSON.stringify({ dir: '.', pack: '.' }) }),
      });
      expect(res.status).toBe(404);
    }
  });
});
