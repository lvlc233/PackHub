import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planFor } from '@packhub/kernel';
import { installPack, loadPack, verifyPack } from '../src/index.ts';

const EXAMPLE_DIR = fileURLToPath(new URL('../../../test/fixtures/packs/team-conventions/', import.meta.url));

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'packhub-'));
  cpSync(EXAMPLE_DIR, work, { recursive: true });
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('示例 Pack', () => {
  it('通过 schema 与图校验', () => {
    const ctx = loadPack(work);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(ctx.manifest.metadata.name).toBe('lvlc233/team-conventions');
  });

  it('同一输入产出同一 planHash', () => {
    const a = planFor(loadPack(work));
    const b = planFor(loadPack(work));
    expect(a.plan?.planHash).toBe(b.plan?.planHash);
    expect(a.plan?.planHash).toMatch(/^sha256-/);
  });

  it('按资源类型生成原语', () => {
    const { plan } = planFor(loadPack(work));
    const ops = plan!.actions.map((a) => a.op);
    expect(ops).toContain('write');
  });
});

describe('计划细节', () => {
  it('github 子路径的 skill 从解包后的子目录挂载', async () => {
    const { parseManifest } = await import('@packhub/kernel');
    const { validateGraph } = await import('@packhub/kernel');
    const { buildPlan } = await import('@packhub/kernel');
    const { DIR_LAYOUT_VARS } = await import('@packhub/kernel');

    const manifest = parseManifest(`apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: t/sub
  version: 0.0.1
requires:
  packhub: ">=0.0.1 <0.1"
resources:
  - id: rules
    type: skill
    source: github:o/r/skills/code-review@9f2c1ab7d4e5f60718293a4b5c6d7e8f90123456
`).manifest!;
    const { graph } = validateGraph(manifest);
    // 不传 harness = 平铺目录；落点表显式给平铺那份
    const { plan } = buildPlan(manifest, graph, {
      layoutVars: DIR_LAYOUT_VARS,
      platform: 'linux-x64',
    });
    const link = plan!.actions.find((a) => a.op === 'link.skill');
    expect(link && 'from' in link ? link.from : '').toBe('.packhub/cache/skills/rules/skills/code-review');
  });

});

describe('install + verify 闭环（本地资源，离线）', () => {
  it('装完通过 verify，重复安装为 noop', async () => {
    const ctx = loadPack(work);
    const { plan } = planFor(ctx);
    expect(plan).toBeDefined();
    // 夹具没有作者 verify 项、资源也没声明 integrity：作者项与派生项都是 0
    expect(plan!.verify).toEqual([]);

    const first = await installPack(ctx, plan!);
    expect(first.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    expect(existsSync(join(work, '.packhub/config/editorconfig.yaml'))).toBe(true);
    expect(existsSync(join(work, '.packhub/knowledge/style-guide.md'))).toBe(true);

    const results = await verifyPack(ctx.dir, plan!);
    expect(results).toEqual([]);

    const second = await installPack(ctx, plan!);
    expect(second.outcomes.some((o) => o.status === 'noop')).toBe(true);
  });

  it('state 快照跟着计划走：平铺没有 harness 字段，宿主装才写 harness', async () => {
    const { loadState } = await import('../src/index.ts');
    const key = 'lvlc233/team-conventions@0.0.2';

    // 平铺：装进 work 自己
    const ctx = loadPack(work);
    await installPack(ctx, planFor(ctx).plan!);
    const flat = loadState(work).packs[key]!.plan!;
    expect(flat).not.toHaveProperty('harness');

    // 宿主形态：另找一个根，按 dsh 的落点装
    const project = mkdtempSync(join(tmpdir(), 'packhub-plan-harness-'));
    await installPack(ctx, planFor(ctx, { harness: 'dsh' }).plan!, { root: project, packRoot: work });
    const hosted = loadState(project).packs[key]!.plan!;
    expect(hosted.harness).toBe('dsh');
    rmSync(project, { recursive: true, force: true });
  });

  it('清单变化会体现在锁的 contentHash 里', async () => {
    const { buildLock } = await import('@packhub/kernel');
    const ctx = loadPack(work);
    const lock = buildLock(ctx.manifest);
    expect(lock.pack).toBe(`lvlc233/team-conventions@${ctx.manifest.metadata.version}`);
    expect(lock.contentHash).toMatch(/^sha256-/);
    expect(lock.resolved).toHaveLength(ctx.manifest.resources.length);
    expect(lock.resolved.every((r) => r.integrity === null)).toBe(true);

    const changed = buildLock({
      ...ctx.manifest,
      resources: [
        ...ctx.manifest.resources,
        { id: 'extra-rules', type: 'knowledge', source: './resources/extra.md' },
      ],
    });
    expect(changed.contentHash).not.toBe(lock.contentHash);
  });
});
