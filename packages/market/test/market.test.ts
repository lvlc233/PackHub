import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPack, installPack, loadPack, planFor } from '@packhub/runtime';
import {
  login,
  publishToMarket,
  register,
  searchMarket,
  rateVersion,
  startMarket,
  yankVersion,
  type RunningMarket,
} from '../src/index.ts';

let market: RunningMarket;
let registryRoot: string;
let home: string;
let project: string;

const PACK = `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo-market/rules
  version: 0.1.0
  title: 团队规范
  description: 一个可发布的最小包
  visibility: public
  targets: [dir]
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
verify:
  - type: file-exists
    path: "\${target.knowledgeDir}/rules.md"
`;

beforeAll(async () => {
  registryRoot = mkdtempSync(join(tmpdir(), 'packhub-market-reg-'));
  home = mkdtempSync(join(tmpdir(), 'packhub-market-home-'));
  process.env.PACKHUB_HOME = home;
  market = await startMarket({ root: registryRoot, port: 0 });
});

afterAll(async () => {
  await market.close();
  delete process.env.PACKHUB_HOME;
  rmSync(registryRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  if (project) rmSync(project, { recursive: true, force: true });
});

describe('市场写端', () => {
  it('注册 → 发布 → 索引可搜 → 能装 → 下载计数', async () => {
    const session = await register(market.url, 'Demo Market');
    expect(session.scope).toBe('demo-market');

    const packDir = mkdtempSync(join(tmpdir(), 'packhub-market-pack-'));
    writeFileSync(join(packDir, 'packhub.yaml'), PACK, 'utf8');
    writeFileSync(join(packDir, 'rules.md'), '# rules\n', 'utf8');

    const published = await publishToMarket(packDir, { url: market.url, token: session.token });
    expect(published.name).toBe('demo-market/rules');
    expect(published.version).toBe('0.1.0');

    const index = JSON.parse(readFileSync(join(registryRoot, 'index.json'), 'utf8'));
    expect(index.packs.some((p: { name: string }) => p.name === 'demo-market/rules')).toBe(true);

    const hits = await searchMarket(market.url, '规范');
    expect(hits[0]?.name).toBe('demo-market/rules');

    // 市场产出的 registry 就是普通静态 registry：客户端能直接装
    project = mkdtempSync(join(tmpdir(), 'packhub-market-proj-'));
    const dest = join(project, '.packhub/packs/demo-market/rules');
    await fetchPack({ name: 'demo-market/rules', index: join(registryRoot, 'index.json'), dest });
    const ctx = loadPack(dest);
    await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: dest });
    expect(existsSync(join(project, '.packhub/knowledge/rules.md'))).toBe(true);

    // 下载计数
    const res = await fetch(`${market.url}/download?name=demo-market/rules&version=0.1.0`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    const after = await searchMarket(market.url, '规范');
    expect(after[0]?.downloads).toBe(1);

    // 评分：一个账号一票，搜索里带均分
    const rated = await rateVersion(`${published.name}@${published.version}`, 5, {
      url: market.url,
      token: session.token,
      comment: '安装一次就通了',
    });
    expect(rated.rating.count).toBe(1);
    expect(rated.rating.average).toBe(5);
    const withRating = await searchMarket(market.url, '规范');
    expect(withRating[0]?.rating?.average).toBe(5);

    // 已有 token 可以登录（复用）
    const relogin = await login(market.url, session.token);
    expect(relogin.name).toBe('Demo Market');

    // 下架：索引移除、下载 410、版本目录移入 quarantine
    await yankVersion('demo-market/rules@0.1.0', { url: market.url, token: session.token, reason: '测试下架' });
    const indexAfter = JSON.parse(readFileSync(join(registryRoot, 'index.json'), 'utf8'));
    expect(indexAfter.packs.some((p: { name: string }) => p.name === 'demo-market/rules')).toBe(false);
    const gone = await fetch(`${market.url}/download?name=demo-market/rules&version=0.1.0`);
    expect(gone.status).toBe(410);
    expect(existsSync(join(registryRoot, '.market/quarantine/demo-market/rules/0.1.0/packhub.yaml'))).toBe(true);

    rmSync(packDir, { recursive: true, force: true });
  });

  it('只能发布自己 scope 的包，且拒绝可执行校验', async () => {
    const session = await register(market.url, 'Other');
    const packDir = mkdtempSync(join(tmpdir(), 'packhub-market-bad-'));
    writeFileSync(
      join(packDir, 'packhub.yaml'),
      PACK.replace('demo-market/rules', 'stolen/rules'),
      'utf8',
    );
    writeFileSync(join(packDir, 'rules.md'), '# rules\n', 'utf8');
    await expect(publishToMarket(packDir, { url: market.url, token: session.token })).rejects.toThrow(
      /只能发布 other\//,
    );

    writeFileSync(
      join(packDir, 'packhub.yaml'),
      `${PACK.replace('demo-market/rules', 'other/rules')}
  - type: command
    run: ["node", "-e", "process.exit(0)"]
`,
      'utf8',
    );
    await expect(publishToMarket(packDir, { url: market.url, token: session.token })).rejects.toThrow(
      /只读校验/,
    );
    rmSync(packDir, { recursive: true, force: true });
  });

  it('人工审核：上传进 staging，批准后才进索引', async () => {
    const reg = mkdtempSync(join(tmpdir(), 'packhub-market-review-'));
    const m = await startMarket({ root: reg, port: 0, requireReview: true, adminToken: 'secret' });
    try {
      const session = await register(m.url, 'Reviewer');
      const packDir = mkdtempSync(join(tmpdir(), 'packhub-market-review-pack-'));
      writeFileSync(join(packDir, 'packhub.yaml'), PACK.replace('demo-market/rules', 'reviewer/rules'), 'utf8');
      writeFileSync(join(packDir, 'rules.md'), '# rules\n', 'utf8');

      const res = await publishToMarket(packDir, { url: m.url, token: session.token });
      expect(res.status).toBe('pending');
      expect((await searchMarket(m.url, '规范')).length).toBe(0);

      const queue = await fetch(`${m.url}/api/admin/queue`, {
        headers: { 'x-market-admin': 'secret' },
      });
      const queued = (await queue.json()) as { pending: { name: string }[] };
      expect(queued.pending[0]?.name).toBe('reviewer/rules');

      const approved = await fetch(`${m.url}/api/admin/review`, {
        method: 'POST',
        headers: { 'x-market-admin': 'secret', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'reviewer/rules', version: '0.1.0', action: 'approve' }),
      });
      expect(approved.status).toBe(200);
      expect((await searchMarket(m.url, '规范')).length).toBe(1);

      // 管理页与概览：页面本身公开，数据接口要 token
      const page = await fetch(`${m.url}/admin`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('市场管理');
      expect((await fetch(`${m.url}/api/admin/stats`)).status).toBe(401);
      const statsRes = await fetch(`${m.url}/api/admin/stats`, {
        headers: { 'x-market-admin': 'secret' },
      });
      expect(statsRes.status).toBe(200);
      const stats = (await statsRes.json()) as { accounts: number; pending: number; versions: number };
      expect(stats.accounts).toBeGreaterThan(0);
      expect(stats.pending).toBe(0);
      expect(stats.versions).toBeGreaterThan(0);

      // 管理 token 可轮换：旧 token 立刻失效，新 token 可用，动作写进审计
      const rotated = await fetch(`${m.url}/api/admin/rotate`, {
        method: 'POST',
        headers: { 'x-market-admin': 'secret', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(rotated.status).toBe(200);
      const rotatedBody = (await rotated.json()) as { token: string };
      expect(rotatedBody.token.length).toBeGreaterThan(20);
      const oldQueue = await fetch(`${m.url}/api/admin/queue`, {
        headers: { 'x-market-admin': 'secret' },
      });
      expect(oldQueue.status).toBe(401);
      const newQueue = await fetch(`${m.url}/api/admin/queue`, {
        headers: { 'x-market-admin': rotatedBody.token },
      });
      expect(newQueue.status).toBe(200);
      const audit = readFileSync(join(reg, '.market/admin-audit.jsonl'), 'utf8');
      expect(audit).toContain('"action":"approve"');
      expect(audit).toContain('"action":"rotate-admin-token"');

      const download = await fetch(`${m.url}/download?name=reviewer/rules&version=0.1.0`);
      expect(download.status).toBe(200);
      await download.arrayBuffer();
      rmSync(packDir, { recursive: true, force: true });
    } finally {
      await m.close();
      rmSync(reg, { recursive: true, force: true });
    }
  });
  it('未登录不能发布或下架', async () => {
    const res = await fetch(`${market.url}/api/publish`, { method: 'POST', body: 'x' });
    expect(res.status).toBe(401);
    void mkdirSync;
  });
});
