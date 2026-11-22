import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPack, planFor, type PlanAction, type PlanShape, type VerifyCheck } from '@packhub/kernel';
import {
  derivedChecks,
  installPack,
  mcpProbeChecks,
  verifyAt,
  verifyInstalled,
  verifyPack,
} from '../src/index.ts';
import { checksWithDerived } from '../src/derived-checks.ts';

const hash = (s: string): string => `sha256-${createHash('sha256').update(s).digest('base64')}`;

/** 与 CLI 的 SAFE_CHECKS 同一组：安装后自动复核只跑只读的三类。 */
const SAFE_TYPES = ['file-exists', 'config-key', 'knowledge-integrity'] as const;

const CONTENT = '# rules\n';

/** 一个声明了 integrity 的 knowledge 包，作者不写 verify。 */
function integrityPack(name = 'demo/derived'): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-derived-'));
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: ${name}, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
    integrity: ${hash(CONTENT)}
`,
    'utf8',
  );
  writeFileSync(join(dir, 'rules.md'), CONTENT, 'utf8');
  return dir;
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('派生检查：write.integrity → knowledge-integrity', () => {
  it('作者不写 verify：安装后的 SAFE_CHECKS 复核与项目模式 verify 都自动带上派生项并 pass', async () => {
    const src = integrityPack();
    const project = tmp('packhub-derived-proj-');
    const ctx = loadPack(src);
    await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: src });

    // 安装后自动复核：派生项在，且只读的三类之外（command / mcp-ready）不进来
    const reports = await verifyInstalled(project, {
      pack: 'demo/derived@0.0.1',
      types: [...SAFE_TYPES],
    });
    expect(reports[0]!.results.map((r) => [r.type, r.status])).toEqual([
      ['knowledge-integrity', 'pass'],
    ]);
    expect(reports[0]!.ok).toBe(true);

    // verify（项目模式）走同一份派生逻辑
    const at = await verifyAt(project);
    expect(at.mode).toBe('installed');
    expect(at.results.map((r) => [r.type, r.status])).toEqual([['knowledge-integrity', 'pass']]);
    expect(at.failed).toBe(0);

    rmSync(src, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('改过落盘文件后派生项 fail，整包 !ok 让 failed 多一条', async () => {
    const src = integrityPack();
    const project = tmp('packhub-derived-bad-');
    const ctx = loadPack(src);
    await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: src });
    writeFileSync(join(project, '.packhub/knowledge/rules.md'), '# tampered\n', 'utf8');

    const at = await verifyAt(project);
    expect(at.results.map((r) => [r.type, r.status])).toEqual([['knowledge-integrity', 'fail']]);
    // 1 项 fail + 这个包 ok=false 的 1 条
    expect(at.failed).toBe(2);
    expect(at.installed[0]!.ok).toBe(false);

    rmSync(src, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('verifyPack（发布门禁路径）也含派生项', async () => {
    const src = integrityPack();
    const ctx = loadPack(src);
    const { plan } = planFor(ctx);
    // Pack 模式在包目录上验，先原地装一遍
    await installPack(ctx, plan!);

    const results = await verifyPack(src, plan!);
    expect(results.map((r) => [r.type, r.status])).toEqual([['knowledge-integrity', 'pass']]);

    rmSync(src, { recursive: true, force: true });
  });

  it('作者手写同一 resource + integrity 的检查：派生不重复', async () => {
    const dir = integrityPack('demo/authored');
    // 作者自带一条同样的检查（不带 integrity，plan 期会补上资源的哈希）
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/authored, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
    integrity: ${hash(CONTENT)}
verify:
  - type: knowledge-integrity
    resource: rules
`,
      'utf8',
    );
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    expect(plan!.verify).toHaveLength(1);

    // 派生前去重键（resource + 期望哈希）已经存在，派生段为空
    expect(derivedChecks(plan!, plan!.verify)).toEqual([]);
    await installPack(ctx, plan!);
    const results = await verifyPack(dir, plan!);
    expect(results.map((r) => [r.type, r.status])).toEqual([['knowledge-integrity', 'pass']]);

    rmSync(dir, { recursive: true, force: true });
  });
});

/** 只有 plan / actions 的假计划：派生只看动作，不需要真装。 */
function fakePlan(): PlanShape {
  const actions = [
    {
      op: 'write',
      actionId: 'write#1',
      from: './rules.md',
      to: '.packhub/knowledge/rules.md',
      resource: 'rules',
      integrity: hash(CONTENT),
    },
    {
      op: 'register.mcp',
      actionId: 'register.mcp#1',
      spec: { transport: 'stdio', command: 'node', args: ['mcp.mjs'] },
      path: '.packhub/config.json',
      resource: 'fake-mcp',
    },
  ] as unknown as PlanAction[];
  return { actions };
}

describe('MCP 探活派生：默认不生成', () => {
  it('checksWithDerived 默认只接 integrity 派生，不含 mcp-ready', () => {
    expect(checksWithDerived(fakePlan(), []).map((c) => c.type)).toEqual(['knowledge-integrity']);
  });

  it('probeMcp: true 时对每个 register.mcp 生成一条 mcp-ready（假 spec，不真连）', () => {
    expect(checksWithDerived(fakePlan(), [], { probeMcp: true }).map((c) => c.type)).toEqual([
      'knowledge-integrity',
      'mcp-ready',
    ]);
    expect(mcpProbeChecks(fakePlan(), [])).toEqual([{ type: 'mcp-ready', resource: 'fake-mcp' }]);
  });

  it('作者已写同名资源的 mcp-ready：派生不重复', () => {
    const author: VerifyCheck[] = [{ type: 'mcp-ready', resource: 'fake-mcp' }];
    expect(mcpProbeChecks(fakePlan(), author)).toEqual([]);
  });

  it('清单里有 MCP 时 verify 默认结果没有 mcp-ready（真探活只在 --probe-mcp）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-derived-mcp-'));
    mkdirSync(join(dir, 'resources'), { recursive: true });
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/mcp-pack, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: fake-mcp
    type: mcp
    source: npm:@demo/fake-mcp@1.0.0
    transport: stdio
`,
      'utf8',
    );
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    expect(plan!.actions.map((a) => a.op)).toEqual(['register.mcp']);
    await installPack(ctx, plan!);

    const at = await verifyAt(dir);
    expect(at.results).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('夹具的 verify 段（作者项瘦身到推不出来的部分）', () => {
  const DOC = fileURLToPath(new URL('../../../test/fixtures/packs/doc-review/', import.meta.url));
  const TEAM = fileURLToPath(new URL('../../../test/fixtures/packs/team-conventions/', import.meta.url));

  it('doc-review 只剩 2 条 command；装完 verify 出两条 pass，派生段为空（没声明 integrity）', async () => {
    const work = tmp('packhub-fixture-doc-');
    cpSync(DOC, work, { recursive: true });
    const ctx = loadPack(work);
    const { plan } = planFor(ctx);
    expect(plan!.verify.map((c) => c.type)).toEqual(['command', 'command']);
    await installPack(ctx, plan!);

    const at = await verifyAt(work);
    expect(at.mode).toBe('pack');
    expect(at.results.map((r) => [r.type, r.status])).toEqual([
      ['command', 'pass'],
      ['command', 'pass'],
    ]);
    expect(at.failed).toBe(0);

    rmSync(work, { recursive: true, force: true });
  });

  it('team-conventions 没有 verify 键：作者项与派生项都是 0', async () => {
    const work = tmp('packhub-fixture-team-');
    cpSync(TEAM, work, { recursive: true });
    const ctx = loadPack(work);
    const { plan } = planFor(ctx);
    expect(plan!.verify).toEqual([]);
    await installPack(ctx, plan!);

    const results = await verifyPack(work, plan!);
    expect(results).toEqual([]);

    rmSync(work, { recursive: true, force: true });
  });
});
