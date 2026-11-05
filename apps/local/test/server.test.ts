import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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


  it('创作台保存：写 packhub.yaml，已存在时拒绝；发布到临时 registry', async () => {
    const rel = `tmp/api-pack-${Math.random().toString(36).slice(2, 8)}`;
    const regRel = `tmp/api-reg-${Math.random().toString(36).slice(2, 8)}`;
    const manifest = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/created, version: 0.1.0, targets: [dir], visibility: public }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`;
    try {
      const created = await fetch(`${base}/api/packs/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: rel, manifest }),
      });
      expect(created.status).toBe(201);
      expect(existsSync(join(process.cwd(), rel, 'packhub.yaml'))).toBe(true);

      const again = await fetch(`${base}/api/packs/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: rel, manifest }),
      });
      expect(again.status).toBe(409);

      writeFileSync(join(process.cwd(), rel, 'rules.md'), '# rules\n', 'utf8');
      const published = await fetch(`${base}/api/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: rel, registry: regRel }),
      });
      expect(published.status).toBe(200);
      const body = (await published.json()) as { indexed: boolean; name: string };
      expect(body.indexed).toBe(true);
      expect(body.name).toBe('demo/created');
      const index = JSON.parse(readFileSync(join(process.cwd(), regRel, 'index.json'), 'utf8'));
      expect(index.packs.some((p: { name: string }) => p.name === 'demo/created')).toBe(true);
    } finally {
      rmSync(join(process.cwd(), rel), { recursive: true, force: true });
      rmSync(join(process.cwd(), regRel), { recursive: true, force: true });
    }
  });

  it('安装可以指定项目目录；重复保存需要 force', async () => {
    const rel = `tmp/api-pack2-${Math.random().toString(36).slice(2, 8)}`;
    const into = `tmp/api-proj-${Math.random().toString(36).slice(2, 8)}`;
    const manifest = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/into, version: 0.1.0, targets: [dir], visibility: public }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`;
    try {
      const created = await fetch(`${base}/api/packs/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: rel, manifest }),
      });
      expect(created.status).toBe(201);
      writeFileSync(join(process.cwd(), rel, 'rules.md'), '# rules\n', 'utf8');

      const forced = await fetch(`${base}/api/packs/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: rel, manifest, force: true }),
      });
      expect(forced.status).toBe(201);

      const installed = await fetch(`${base}/api/install?dir=${encodeURIComponent(rel)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ into }),
      });
      expect(installed.status).toBe(200);
      expect(existsSync(join(process.cwd(), into, '.packhub/state.json'))).toBe(true);
      expect(existsSync(join(process.cwd(), into, '.packhub/knowledge/rules.md'))).toBe(true);
    } finally {
      rmSync(join(process.cwd(), rel), { recursive: true, force: true });
      rmSync(join(process.cwd(), into), { recursive: true, force: true });
    }
  });
  it('registry 索引可读', async () => {
    const res = await fetch(`${base}/api/registry`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { packs: unknown[] };
    expect(Array.isArray(data.packs)).toBe(true);
  });
});
