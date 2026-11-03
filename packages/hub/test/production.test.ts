import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, type HubOptions } from '../src/index.ts';

const RUNNING: { close: () => Promise<void> }[] = [];
afterAll(async () => {
  for (const r of RUNNING) await r.close();
});

async function start(opts: Partial<HubOptions> = {}): Promise<{ base: string; close: () => Promise<void>; audit?: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-hub-'));
  const audit = join(dir, 'audit.jsonl');
  const server = await startHub({
    root: process.cwd(),
    port: 0,
    ...(opts.auth ? { auth: opts.auth } : {}),
    ...(opts.rpm !== undefined ? { rpm: opts.rpm } : {}),
    auditFile: audit,
    ...opts,
  });
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const close = async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    rmSync(dir, { recursive: true, force: true });
  };
  RUNNING.push({ close });
  return { base, close, audit };
}

describe('Hub 生产化', () => {
  it('健康检查不需要鉴权，并报告包数', async () => {
    const { base, close } = await start({ auth: { token: 'secret' } });
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; packs: number; uptimeSeconds: number };
    expect(body.ok).toBe(true);
    expect(typeof body.packs).toBe('number');
    await close();
  });

  it('配了 token 就要求带上，缺失返回 401', async () => {
    const { base, close } = await start({ auth: { token: 'secret' } });
    expect((await fetch(`${base}/api/registry`)).status).toBe(401);
    const ok = await fetch(`${base}/api/registry`, { headers: { authorization: 'Bearer secret' } });
    expect(ok.status).toBe(200);
    const viaHeader = await fetch(`${base}/api/registry`, { headers: { 'x-packhub-token': 'secret' } });
    expect(viaHeader.status).toBe(200);
    await close();
  });

  it('信任反向代理注入的身份头时，没有该头也拒绝', async () => {
    const { base, close } = await start({ auth: { userHeader: 'x-forwarded-user' } });
    expect((await fetch(`${base}/api/registry`)).status).toBe(401);
    const ok = await fetch(`${base}/api/registry`, { headers: { 'x-forwarded-user': 'alice' } });
    expect(ok.status).toBe(200);
    await close();
  });

  it('对外监听但没配鉴权时拒绝启动（fail-closed）', () => {
    expect(() => startHub({ root: process.cwd(), port: 0, host: '0.0.0.0' })).toThrow(
      /拒绝在 0\.0\.0\.0 上无鉴权启动/,
    );
  });

  it('限流生效：超过 rpm 返回 429', async () => {
    const { base, close } = await start({ rpm: 2 });
    expect((await fetch(`${base}/api/registry`)).status).toBe(200);
    expect((await fetch(`${base}/api/registry`)).status).toBe(200);
    expect((await fetch(`${base}/api/registry`)).status).toBe(429);
    await close();
  });

  it('审计日志记下每次请求（含 401）', async () => {
    const { base, close, audit } = await start({ auth: { token: 'secret' } });
    await fetch(`${base}/api/registry`);
    await fetch(`${base}/api/registry`, { headers: { authorization: 'Bearer secret' } });
    // 先读再关：close 会清掉临时目录
    const lines = readFileSync(audit!, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    await close();
    expect(lines.some((l) => l.status === 401)).toBe(true);
    expect(lines.some((l) => l.status === 200)).toBe(true);
    expect(lines[0].path).toBe('/api/registry');
  });
});
