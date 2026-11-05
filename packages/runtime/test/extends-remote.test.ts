import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPackResolved, packArchive, planFor } from '../src/index.ts';

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.PACKHUB_INDEX;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 造一个只有 base 包的 registry，并写好 index.json。 */
async function registryWithParent(): Promise<string> {
  const root = temp('packhub-ext-reg-');
  const base = join(root, 'base-src');
  mkdirSync(base, { recursive: true });
  writeFileSync(
    join(base, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/base, version: 1.0.0, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: shared
    type: knowledge
    source: ./shared.md
`,
    'utf8',
  );
  writeFileSync(join(base, 'shared.md'), '# shared\n', 'utf8');
  const archive = join(root, 'packs/demo/base/1.0.0.phub');
  await packArchive(base, { vendored: true, out: archive });
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify(
      {
        apiVersion: 'packhub.dev/index/v0',
        packs: [{ name: 'demo/base', latest: '1.0.0', versions: ['1.0.0'], trust: 'community' }],
      },
      null,
      2,
    ),
    'utf8',
  );
  return join(root, 'index.json');
}

function child(): string {
  const dir = temp('packhub-ext-child-');
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
extends: packhub://demo/base@1.0.0
metadata: { name: demo/child, version: 0.1.0, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: own
    type: knowledge
    source: ./own.md
`,
    'utf8',
  );
  writeFileSync(join(dir, 'own.md'), '# own\n', 'utf8');
  return dir;
}

describe('远程 extends', () => {
  it('从 registry 取父包并合并，装出来的文件和 planHash 都稳定', async () => {
    const index = await registryWithParent();
    process.env.PACKHUB_INDEX = index;
    const dir = child();

    const ctx = await loadPackResolved(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(ctx.manifest.resources.map((r) => r.id).sort()).toEqual(['own', 'shared']);

    const cache = join(dir, '.packhub/cache/extends/demo/base/1.0.0/packhub.yaml');
    expect(existsSync(cache)).toBe(true);

    const first = planFor(ctx).plan!;
    expect(
      first.actions
        .filter((a) => a.op === 'write')
        .map((a) => ('from' in a ? a.from : ''))
        .some((from) => from?.startsWith('./.packhub/cache/extends/demo/base/1.0.0/') === true),
    ).toBe(true);

    // 换一台“机器”：清掉缓存重新取，路径与哈希不变
    rmSync(join(dir, '.packhub'), { recursive: true, force: true });
    const again = planFor(await loadPackResolved(dir)).plan!;
    expect(again.planHash).toBe(first.planHash);

    const project = temp('packhub-ext-proj-');
    const result = await installPack(ctx, first, { root: project, packRoot: dir });
    expect(result.outcomes.every((o) => o.status === 'done' || o.status === 'noop')).toBe(true);
    expect(readFileSync(join(project, '.packhub/knowledge/shared.md'), 'utf8')).toBe('# shared\n');
    expect(readFileSync(join(project, '.packhub/knowledge/own.md'), 'utf8')).toBe('# own\n');
  });

  it('没有 registry 索引时明确报错，不去猜父包', async () => {
    const dir = child();
    delete process.env.PACKHUB_INDEX;
    delete process.env.PACKHUB_HOME;
    const ctx = await loadPackResolved(dir);
    expect(ctx.issues.map((i) => i.code)).toContain('extends-unresolved');
  });

  it('取不到父包时报 extends-fetch，计划不生成', async () => {
    const index = await registryWithParent();
    // 索引存在但归档没了
    rmSync(join(index, '..', 'packs/demo/base/1.0.0.phub'), { force: true });
    process.env.PACKHUB_INDEX = index;
    const ctx = await loadPackResolved(child());
    expect(ctx.issues.map((i) => i.code)).toContain('extends-fetch');
    expect(planFor(ctx).plan).toBeUndefined();
  });
});
