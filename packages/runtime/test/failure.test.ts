import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPack, planFor } from '../src/index.ts';

const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/fail, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./resources/rules.md
  - id: broken
    type: skill
    source: ./skills/missing
`;

function failingPack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-fail-'));
  mkdirSync(join(dir, 'resources'), { recursive: true });
  writeFileSync(join(dir, 'packhub.yaml'), MANIFEST, 'utf8');
  writeFileSync(join(dir, 'resources/rules.md'), '# rules\n', 'utf8');
  return dir;
}

describe('安装失败的回滚', () => {
  it('前面的动作已经写盘，后面的动作失败 → 文件回到装之前，不写 state', async () => {
    const src = failingPack();
    const project = mkdtempSync(join(tmpdir(), 'packhub-fail-proj-'));
    const ctx = loadPack(src);
    const { plan } = planFor(ctx);

    const result = await installPack(ctx, plan!, { root: project, packRoot: src });
    expect(result.outcomes.map((o) => o.status)).toEqual(['done', 'failed']);
    expect(result.rolledBack).toBe(true);
    expect(existsSync(join(project, '.packhub/knowledge/rules.md'))).toBe(false);
    expect(existsSync(join(project, '.packhub/state.json'))).toBe(false);
    expect(existsSync(join(project, '.packhub/snapshots'))).toBe(false);

    rmSync(src, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('同一秒装两个包也会得到两个 generation', async () => {
    const project = mkdtempSync(join(tmpdir(), 'packhub-fail-gen-'));
    for (const name of ['one', 'two']) {
      const src = mkdtempSync(join(tmpdir(), 'packhub-fail-p-'));
      mkdirSync(join(src, 'resources'), { recursive: true });
      writeFileSync(
        join(src, 'packhub.yaml'),
        `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/${name}, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./resources/${name}.md
`,
        'utf8',
      );
      writeFileSync(join(src, 'resources', `${name}.md`), `# ${name}\n`, 'utf8');
      const ctx = loadPack(src);
      await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: src });
      rmSync(src, { recursive: true, force: true });
    }

    const snaps = readdirSync(join(project, '.packhub/snapshots'));
    expect(snaps).toHaveLength(2);
    const state = JSON.parse(readFileSync(join(project, '.packhub/state.json'), 'utf8'));
    expect(state.generations).toHaveLength(2);
    expect(state.generations[0].id).not.toBe(state.generations[1].id);

    rmSync(project, { recursive: true, force: true });
  });
});
