import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFor } from '@packhub/kernel';
import { installPack, loadPack, verifyAt } from '../src/index.ts';

/** 一个最小的平铺包：一个知识文件 + 一条 file-exists 校验。 */
function pack(name = 'demo/inst'): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-vat-'));
  mkdirSync(join(dir, 'resources'), { recursive: true });
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: ${name}, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./resources/rules.md
verify:
  - type: file-exists
    path: "\${target.knowledgeDir}/rules.md"
`,
    'utf8',
  );
  writeFileSync(join(dir, 'resources/rules.md'), '# rules\n', 'utf8');
  return dir;
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('verifyAt：模式判定与两种模式的结果形状', () => {
  it('项目模式：没有 packhub.yaml 但装过包，计划和检查根都来自 state', async () => {
    const src = pack();
    const project = tmp('packhub-vat-proj-');
    const ctx = loadPack(src);
    await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: src });

    const res = await verifyAt(project);
    expect(res.mode).toBe('installed');
    expect(res.ready).toBe(true);
    expect(res.issues).toEqual([]);
    // 项目模式没有「单一计划」，planHash 由每个包各带一份
    expect(res.planHash).toBe('');
    expect(res.installed).toHaveLength(1);
    expect(res.installed[0]!.pack).toBe('demo/inst@0.0.1');
    expect(res.results.map((r) => r.status)).toEqual(['pass']);
    expect(res.failed).toBe(0);
    expect(res.skipped).toBe(0);

    rmSync(src, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('Pack 模式：有清单的目录按清单出计划，planHash 与 planFor 同一份', async () => {
    const src = pack();
    // Pack 模式是「在项目根上验」，所以先原地装一遍，检查路径才会落在根上
    const ctx = loadPack(src);
    await installPack(ctx, planFor(ctx).plan!);

    const res = await verifyAt(src);
    expect(res.mode).toBe('pack');
    expect(res.ready).toBe(true);
    expect(res.issues).toEqual([]);
    expect(res.installed).toEqual([]);
    expect(res.planHash).toBe(planFor(loadPack(src)).plan!.planHash);
    expect(res.results.map((r) => r.status)).toEqual(['pass']);
    expect(res.failed).toBe(0);
    expect(res.skipped).toBe(0);

    rmSync(src, { recursive: true, force: true });
  });

  it('清单与已装包都在时按 Pack 模式：目录里的清单是更明确的意图', async () => {
    const src = pack();
    const project = tmp('packhub-vat-both-');
    const ctx = loadPack(src);
    await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: src });
    // 项目自己也是一份 Pack：校验看项目根下的 mine.md
    writeFileSync(join(project, 'mine.md'), '# mine\n', 'utf8');
    writeFileSync(
      join(project, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/proj, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: mine
    type: knowledge
    source: ./mine.md
verify:
  - type: file-exists
    path: mine.md
`,
      'utf8',
    );

    const res = await verifyAt(project);
    expect(res.mode).toBe('pack');
    expect(res.planHash).toBe(planFor(loadPack(project)).plan!.planHash);
    // 不是项目模式：state 里的那个包没有进结果
    expect(res.installed).toEqual([]);

    rmSync(src, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('既没清单也没已装包：ready=false，问题留给命令层打印（退出码 2 的数据来源）', async () => {
    const empty = tmp('packhub-vat-empty-');

    const res = await verifyAt(empty);
    expect(res.mode).toBe('pack');
    expect(res.ready).toBe(false);
    expect(res.results).toEqual([]);
    expect(res.failed).toBe(0);
    expect(res.issues.some((i) => i.severity === 'error' && i.code === 'manifest-missing')).toBe(true);

    rmSync(empty, { recursive: true, force: true });
  });

  it('Pack 模式：harness 只决定落点，没有声明门（metadata.targets 已删）', async () => {
    const src = pack();

    const res = await verifyAt(src, { harness: 'claude-code' });
    expect(res.mode).toBe('pack');
    // 计划按传入的 harness 现算；清单没有「声明过的 harness」这回事，缺文件才算失败
    expect(res.ready).toBe(true);
    expect(res.planHash).toBe(planFor(loadPack(src), { harness: 'claude-code' }).plan!.planHash);
    expect(res.results.map((r) => r.status)).toEqual(['fail']);

    rmSync(src, { recursive: true, force: true });
  });

  it('项目模式里文件被删：failed = 失败项 + 整包 !ok 一条（与旧退出码判据逐项一致）', async () => {
    const src = pack();
    const project = tmp('packhub-vat-broken-');
    const ctx = loadPack(src);
    await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: src });
    rmSync(join(project, '.packhub/knowledge/rules.md'), { force: true });

    const res = await verifyAt(project);
    expect(res.mode).toBe('installed');
    expect(res.installed[0]!.ok).toBe(false);
    expect(res.results.map((r) => r.status)).toEqual(['fail']);
    // 1 项 fail + 这个包 ok=false 的 1 条 = 2
    expect(res.failed).toBe(2);
    expect(res.skipped).toBe(0);

    rmSync(src, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('项目模式把 pack 过滤原样交给 verifyInstalled（runtime 选项，不是 CLI 参数）', async () => {
    const src = pack();
    const project = tmp('packhub-vat-filter-');
    const ctx = loadPack(src);
    await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: src });

    const one = await verifyAt(project, { pack: 'demo/inst@0.0.1' });
    expect(one.installed.map((r) => r.pack)).toEqual(['demo/inst@0.0.1']);
    // state 里没有的包：verifyInstalled 给一条 skipped 记录，整包不算完成
    const missing = await verifyAt(project, { pack: 'demo/other@1.0.0' });
    expect(missing.installed[0]!.results[0]!.status).toBe('skipped');
    expect(missing.failed).toBe(1);
    expect(missing.skipped).toBe(1);

    rmSync(src, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
});
