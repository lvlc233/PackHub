import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packArchive } from '../src/index.ts';
import { updatePack } from '../src/index.ts';

const MANIFEST = (version: string, resources: string): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/prune, version: ${version}, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
${resources}`;

const RULES = `  - id: rules
    type: knowledge
    source: ./resources/rules.md
`;

async function registry(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'packhub-prune-reg-'));
  const mk = async (version: string, resources: string, files: Record<string, string>): Promise<void> => {
    const dir = join(root, 'packs/demo/prune', version);
    mkdirSync(join(dir, 'resources'), { recursive: true });
    writeFileSync(join(dir, 'packhub.yaml'), MANIFEST(version, resources), 'utf8');
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, 'resources', name), content, 'utf8');
    }
    await packArchive(dir, { vendored: true, out: join(root, 'packs/demo/prune', `${version}.phub`) });
  };

  await mk('0.1.0', RULES + `  - id: extra
    type: knowledge
    source: ./resources/extra.md
`, { 'rules.md': '# v1\n', 'extra.md': '# extra\n' });
  await mk('0.2.0', RULES, { 'rules.md': '# v2\n' });

  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify(
      {
        apiVersion: 'packhub.dev/index/v0',
        packs: [{ name: 'demo/prune', latest: '0.2.0', versions: ['0.1.0', '0.2.0'], trust: 'community' }],
      },
      null,
      2,
    ),
    'utf8',
  );
  return root;
}

describe('update 的删除语义', () => {
  it('新版本去掉的资源要从磁盘和 state 里一起消失', async () => {
    const reg = await registry();
    const project = mkdtempSync(join(tmpdir(), 'packhub-prune-proj-'));
    const index = join(reg, 'index.json');

    const { fetchPack, installPack, loadPack, planFor } = await import('../src/index.ts');
    const dest = join(project, '.packhub/packs/demo/prune');
    await fetchPack({ name: 'demo/prune', index, version: '0.1.0', dest });
    const ctx = loadPack(dest);
    await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: dest });

    expect(existsSync(join(project, '.packhub/knowledge/extra.md'))).toBe(true);

    const res = await updatePack({ name: 'demo/prune', index, projectDir: project });
    expect(res.changed).toBe(true);
    expect(res.pruned).toContain('.packhub/knowledge/extra.md');
    expect(existsSync(join(project, '.packhub/knowledge/extra.md'))).toBe(false);
    expect(readFileSync(join(project, '.packhub/knowledge/rules.md'), 'utf8')).toBe('# v2\n');

    const state = JSON.parse(readFileSync(join(project, '.packhub/state.json'), 'utf8'));
    expect(state.packs['demo/prune@0.2.0']).toBeTruthy();
    expect(state.packs['demo/prune@0.1.0']).toBeUndefined();
    expect(state.packs['demo/prune@0.2.0'].written).not.toContain('.packhub/knowledge/extra.md');

    const { verifyInstalled } = await import('../src/index.ts');
    const reports = await verifyInstalled(project);
    expect(reports[0]!.planHash).toBe(res.planHash);
    expect(reports[0]!.ok).toBe(true);

    rmSync(reg, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
});
