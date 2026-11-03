import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPack, loadPack, planFor, verifyPack } from '../src/index.ts';

const EXAMPLE_DIR = fileURLToPath(new URL('../../../examples/team-conventions/', import.meta.url));

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
    expect(ops).toContain('merge.config');
  });
});

describe('install + verify 闭环（本地资源，离线）', () => {
  it('装完通过 verify，重复安装为 noop', () => {
    const ctx = loadPack(work);
    const { plan } = planFor(ctx);
    expect(plan).toBeDefined();

    const first = installPack(ctx, plan!);
    expect(first.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    expect(existsSync(join(work, '.packhub/config.json'))).toBe(true);
    expect(existsSync(join(work, '.packhub/knowledge/style-guide.md'))).toBe(true);

    const results = verifyPack(ctx.dir, plan!);
    expect(results.filter((r) => r.status === 'fail')).toEqual([]);

    const second = installPack(ctx, plan!);
    expect(second.outcomes.some((o) => o.status === 'noop')).toBe(true);
  });

  it('planHash 变化会体现在锁文件里', async () => {
    const { buildLock } = await import('../src/lock.ts');
    const ctx = loadPack(work);
    const { plan } = planFor(ctx);
    const lock = buildLock(ctx.manifest, plan!);
    expect(lock.pack).toBe('lvlc233/team-conventions@0.0.1');
    expect(lock.planHash).toBe(plan!.planHash);
    expect(lock.resolved).toHaveLength(ctx.manifest.resources.length);
    expect(lock.resolved.every((r) => r.integrity === null)).toBe(true);
  });
});
