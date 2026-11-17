import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHub } from '../src/index.ts';

let server: Awaited<ReturnType<typeof startHub>>;
let base = '';

/** 一份最小可用清单：各个 /api/plan 用例共用，避免每处再抄一遍。 */
const DRAFT = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/hub, version: 0.0.1, targets: [dir, dsh] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: x
    type: knowledge
    source: https://example.com/a.md
    integrity: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
`;

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


  it('包名按 kernel 的 PACK_NAME_PATTERN 判定（本地的宽松正则已删）', async () => {
    // 旧正则（/^[a-z0-9-]+\/[a-z0-9-]+$/）会放过开头是 `-` 的包名；现在跟 kernel 的 schema 判据一致
    for (const name of ['-demo/res', 'demo/res/extra', 'Demo/res', 'demo//res']) {
      const res = await fetch(`${base}/api/registry/pack?name=${encodeURIComponent(name)}`);
      expect(res.status).toBe(400);
    }
    // 形状合法但不是 registry 里的包：仍按 404 处理
    const missing = await fetch(`${base}/api/registry/pack?name=${encodeURIComponent('demo-/res')}`);
    expect(missing.status).toBe(404);
  });

  it('索引与包页带 ETag / Cache-Control，条件请求回 304', async () => {    const first = await fetch(`${base}/api/registry`);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"/);
    expect(first.headers.get('cache-control')).toContain('max-age');
    const second = await fetch(`${base}/api/registry`, { headers: { 'if-none-match': etag! } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  it('包页返回解析后的元数据（license / authors / requires.agent）', async () => {
    const idx = (await (await fetch(`${base}/api/registry`)).json()) as { packs: { name: string }[] };
    const name = idx.packs[0]?.name;
    if (!name) return;
    const detail = (await (
      await fetch(`${base}/api/registry/pack?name=${encodeURIComponent(name)}`)
    ).json()) as { metadata: { name: string; license: string | null } | null };
    expect(detail.metadata?.name).toBe(name);
    expect(detail.metadata).toHaveProperty('license');
  });


  it('请求体超过上限返回 413，而不是把内存吃满', async () => {
    const res = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: 'x'.repeat(1024 * 1024 + 10), target: 'dir' }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('body-too-large');
  });

  it('未知 target 直接 400，不产出枚举外的计划', async () => {
    const res = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: DRAFT, target: 'nope' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('未知 target');
    // 报错里给出可选值：从 kernel 的 TARGET_IDS 来，不在路由里再手写一份
    expect(body.error).toContain('dir');
    expect(body.error).toContain('dsh');
  });

  it('请求体不是 JSON 返回 400（按 code 映射，不靠文案猜）', async () => {
    const res = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('body-invalid-json');
  });

  it('清单里的 ./ 路径读不到服务器文件：context 指向 Hub 自己的文件只报 issue', async () => {
    // 这个串只出现在 Hub 自己的 package.json 里；响应里出现它就说明越界读成功了
    const marker = 'pack:local';
    const pkg = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    expect(pkg).toContain(marker);

    const res = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: `${DRAFT}context: ./package.json
`,
        target: 'dsh',
      }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(marker);
    const body = JSON.parse(text) as { plan: unknown; issues: { code: string }[] };
    expect(body.plan).toBeNull();
    expect(body.issues.map((issue) => issue.code)).toContain('context-file-missing');
  });

  it('内联 context 照常进计划（限制的是读文件的 ./ 路径，不是清单里的文本）', async () => {
    const res = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: `${DRAFT}context: |
  这是内联上下文，不是文件路径。
`,
        target: 'dsh',
      }),
    });
    const body = (await res.json()) as {
      plan: { actions: { op: string; content?: string }[] } | null;
    };
    const instruction = body.plan?.actions.find((action) => action.op === 'instruction');
    expect(instruction?.content).toContain('这是内联上下文，不是文件路径。');
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
