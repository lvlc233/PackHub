import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPack, planFor, verifyInstalled } from '../src/index.ts';

function pack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-inst-'));
  mkdirSync(join(dir, 'resources'), { recursive: true });
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/inst, version: 0.0.1, targets: [dir] }
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

describe('在项目根上验已装的包', () => {
  it('plan 与安装根都来自 state：项目里没有 packhub.yaml 也能验', async () => {
    const src = pack();
    const project = mkdtempSync(join(tmpdir(), 'packhub-inst-proj-'));
    const ctx = loadPack(src);
    await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: src });

    const reports = await verifyInstalled(project);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.pack).toBe('demo/inst@0.0.1');
    expect(reports[0]!.results.map((r) => r.status)).toEqual(['pass']);
    expect(reports[0]!.ok).toBe(true);

    rmSync(src, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('文件被删后验不过，且能按包名过滤', async () => {
    const src = pack();
    const project = mkdtempSync(join(tmpdir(), 'packhub-inst-proj2-'));
    const ctx = loadPack(src);
    await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: src });
    rmSync(join(project, '.packhub/knowledge/rules.md'), { force: true });

    expect((await verifyInstalled(project))[0]!.ok).toBe(false);
    expect((await verifyInstalled(project, { pack: 'demo/inst@0.0.1' }))[0]!.results[0]!.status).toBe('fail');
    expect((await verifyInstalled(project, { pack: 'demo/missing@1.0.0' }))[0]!.ok).toBe(false);

    rmSync(src, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
});
