import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFor } from '@packhub/kernel';
import { activatePack, installPack, loadPack, loadState, readVersionRecord } from '../src/index.ts';
import { pruneRemoved } from '../src/install.ts';

/**
 * `.json` 的共享性由动作决定，不由后缀决定：
 * - knowledge/config 写出来的 `.json` 是本包私有产物，要进版本镜像、要随升级删除、要参与所有权冲突；
 * - 只有 register.mcp 的配置文件按 key 合并，指令文件按托管块合并。
 */
function makePack(
  dir: string,
  name: string,
  version: string,
  resources: string,
  files: Record<string, string>,
): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: ${name}, version: ${version}, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
${resources}`,
    'utf8',
  );
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content, 'utf8');
  return dir;
}

const TWO_KNOWLEDGE = `  - id: rules
    type: knowledge
    source: ./rules.md
  - id: table
    type: knowledge
    source: ./table.json
`;

describe('.json 产物的私有语义', () => {
  it('写出的 .json 进版本镜像，切回旧版本能还原内容', async () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-shared-json-'));
    const project = join(base, 'proj');
    mkdirSync(project, { recursive: true });
    const v1 = makePack(join(base, 'v1'), 'demo/table', '0.1.0', TWO_KNOWLEDGE, {
      'rules.md': '# v1\n',
      'table.json': '{"flavor":"one"}\n',
    });
    const v3 = makePack(join(base, 'v3'), 'demo/table', '0.3.0', TWO_KNOWLEDGE, {
      'rules.md': '# v3\n',
      'table.json': '{"flavor":"three"}\n',
    });

    for (const dir of [v1, v3]) {
      const ctx = loadPack(dir);
      const res = await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: dir });
      expect(res.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    }
    const table = join(project, '.packhub/knowledge/table.json');
    expect(readFileSync(table, 'utf8')).toBe('{"flavor":"three"}\n');

    // 私有产物必须进版本记录：record.files 与 state.written 都要有它
    const record = readVersionRecord(project, 'demo/table', '0.1.0');
    expect(record.files).toContain('.packhub/knowledge/table.json');
    expect(loadState(project).packs['demo/table@0.3.0']?.written).toContain(
      '.packhub/knowledge/table.json',
    );

    // 切回 0.1.0：文件内容按镜像还原，而不是停在 0.3.0 那一份
    await activatePack(project, 'demo/table', '0.1.0');
    expect(readFileSync(table, 'utf8')).toBe('{"flavor":"one"}\n');
    expect(readFileSync(join(project, '.packhub/knowledge/rules.md'), 'utf8')).toBe('# v1\n');

    rmSync(base, { recursive: true, force: true });
  });

  it('升级后新计划不再产出的 .json 会被删掉，而不是当成共享保留', async () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-shared-prune-'));
    const project = join(base, 'proj');
    mkdirSync(project, { recursive: true });
    const v1 = makePack(join(base, 'v1'), 'demo/prune-json', '0.1.0', TWO_KNOWLEDGE, {
      'rules.md': '# v1\n',
      'table.json': '{"flavor":"one"}\n',
    });
    const v2 = makePack(
      join(base, 'v2'),
      'demo/prune-json',
      '0.2.0',
      `  - id: rules
    type: knowledge
    source: ./rules.md
`,
      { 'rules.md': '# v2\n' },
    );

    const ctx1 = loadPack(v1);
    const plan1 = planFor(ctx1).plan!;
    const installed1 = await installPack(ctx1, plan1, { root: project, packRoot: v1 });
    expect(existsSync(join(project, '.packhub/knowledge/table.json'))).toBe(true);

    const ctx2 = loadPack(v2);
    const plan2 = planFor(ctx2).plan!;
    await installPack(ctx2, plan2, { root: project, packRoot: v2 });
    const pruned = pruneRemoved(project, plan1, plan2, installed1.outcomes);

    expect(pruned.removed).toContain('.packhub/knowledge/table.json');
    expect(pruned.kept).not.toContain('.packhub/knowledge/table.json');
    expect(existsSync(join(project, '.packhub/knowledge/table.json'))).toBe(false);
    expect(loadState(project).packs['demo/prune-json@0.2.0']?.written).not.toContain(
      '.packhub/knowledge/table.json',
    );

    rmSync(base, { recursive: true, force: true });
  });

  it('两个包写同一 .json 算所有权冲突；两边都是 register.mcp 时不同 key 可共存', async () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-shared-own-'));
    const project = join(base, 'proj');
    mkdirSync(project, { recursive: true });
    const table = (name: string, content: string): string =>
      makePack(join(base, name), `demo/${name}`, '0.1.0', `  - id: table
    type: knowledge
    source: ./table.json
`, { 'table.json': content });

    const a = table('own-a', '{"owner":"a"}\n');
    const b = table('own-b', '{"owner":"b"}\n');
    const ctxA = loadPack(a);
    await installPack(ctxA, planFor(ctxA).plan!, { root: project, packRoot: a });
    const ctxB = loadPack(b);
    await expect(
      installPack(ctxB, planFor(ctxB).plan!, { root: project, packRoot: b }),
    ).rejects.toThrow(/已被别的包占用/);

    // 同一份配置文件、不同 MCP 键：按 key 合并，不算冲突
    const mcp = (name: string, id: string): string =>
      makePack(
        join(base, name),
        `demo/${name}`,
        '0.1.0',
        `  - id: ${id}
    type: mcp
    transport: stdio
    source: npm:@scope/${id}@1.0.0
`,
        {},
      );
    const m1 = mcp('mcp-a', 'tts-a');
    const m2 = mcp('mcp-b', 'tts-b');
    const project2 = join(base, 'proj-mcp');
    mkdirSync(project2, { recursive: true });
    for (const dir of [m1, m2]) {
      const ctx = loadPack(dir);
      const res = await installPack(ctx, planFor(ctx).plan!, { root: project2, packRoot: dir });
      expect(res.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    }
    const config = JSON.parse(readFileSync(join(project2, '.packhub/config.json'), 'utf8'));
    expect(Object.keys(config.mcpServers).sort()).toEqual(['tts-a', 'tts-b']);

    rmSync(base, { recursive: true, force: true });
  });
});
