import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.ts';

let server: Awaited<ReturnType<typeof startServer>>;
let base = '';

beforeAll(async () => {
  server = await startServer({ root: process.cwd(), port: 0 });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
});

const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/api, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: search
    type: mcp
    source: npm:@scope/x@1.0.0
    transport: stdio
`;

describe('HTTP API', () => {
  it('草稿预览返回计划，不落盘', async () => {
    const res = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: MANIFEST, target: 'claude-code' }),
    });
    const data = (await res.json()) as {
      plan: { actions: { op: string }[]; planHash: string } | null;
      issues: unknown[];
    };
    expect(data.plan).toBeTruthy();
    expect(data.plan!.actions.map((a) => a.op)).toContain('register.mcp');
    expect(data.plan!.planHash).toMatch(/^sha256-/);
  });

  it('清单有错时只返回问题，不给计划', async () => {
    const res = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: 'apiVersion: nope', target: 'dir' }),
    });
    const data = (await res.json()) as { plan: unknown; issues: { severity: string }[] };
    expect(data.plan).toBeNull();
    expect(data.issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('registry 索引可读', async () => {
    const res = await fetch(`${base}/api/registry`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { packs: unknown[] };
    expect(Array.isArray(data.packs)).toBe(true);
  });
});
