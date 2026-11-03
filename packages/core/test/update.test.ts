import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packArchive, updatePack } from '../src/index.ts';

/** 造一个最小 registry：index + 两个版本归档。 */
async function registry(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'packhub-upd-reg-'));
  const mk = async (version: string, content: string): Promise<void> => {
    const dir = join(root, 'packs/demo/upd', version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/upd, version: ${version}, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`,
      'utf8',
    );
    writeFileSync(join(dir, 'rules.md'), content, 'utf8');
    await packArchive(dir, { vendored: true, out: join(root, 'packs/demo/upd', `${version}.phub`) });
  };
  await mk('0.1.0', '# v1\n');
  await mk('0.2.0', '# v2\n');
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify(
      {
        apiVersion: 'packhub.dev/index/v0',
        packs: [{ name: 'demo/upd', latest: '0.2.0', versions: ['0.1.0', '0.2.0'], trust: 'community' }],
      },
      null,
      2,
    ),
    'utf8',
  );
  return root;
}

describe('update', () => {
  it('装 0.1.0 后更新到 0.2.0，内容与 state 都对', async () => {
    const reg = await registry();
    const project = mkdtempSync(join(tmpdir(), 'packhub-upd-proj-'));
    const index = join(reg, 'index.json');

    // 先装旧版本：直接走 updatePack 会取 latest，所以用 add 的等价路径
    const { fetchPack } = await import('../src/index.ts');
    const { installPack, loadPack, planFor } = await import('../src/index.ts');
    const dest = join(project, '.packhub/packs/demo/upd');
    await fetchPack({ name: 'demo/upd', index, version: '0.1.0', dest });
    const ctx = loadPack(dest);
    await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: dest });
    expect(readFileSync(join(project, '.packhub/knowledge/rules.md'), 'utf8')).toBe('# v1\n');

    const res = await updatePack({ name: 'demo/upd', index, projectDir: project });
    expect(res.changed).toBe(true);
    expect(res.to).toBe('demo/upd@0.2.0');
    expect(readFileSync(join(project, '.packhub/knowledge/rules.md'), 'utf8')).toBe('# v2\n');

    const state = JSON.parse(readFileSync(join(project, '.packhub/state.json'), 'utf8'));
    expect(state.packs['demo/upd@0.2.0']).toBeTruthy();
    rmSync(reg, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('已是最新时 changed=false 且不产生新 generation', async () => {
    const reg = await registry();
    const project = mkdtempSync(join(tmpdir(), 'packhub-upd2-'));
    const index = join(reg, 'index.json');
    const first = await updatePack({ name: 'demo/upd', index, projectDir: project });
    expect(first.changed).toBe(true);
    const gens = JSON.parse(readFileSync(join(project, '.packhub/state.json'), 'utf8')).generations;
    const second = await updatePack({ name: 'demo/upd', index, projectDir: project });
    expect(second.changed).toBe(false);
    const gens2 = JSON.parse(readFileSync(join(project, '.packhub/state.json'), 'utf8')).generations;
    expect(gens2.length).toBe(gens.length);
    rmSync(reg, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
});
