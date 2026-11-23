import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFor, type Plan } from '@packhub/kernel';
import { installPack, loadPack, loadState, planPaths } from '../src/index.ts';
import { pruneRemoved } from '../src/install.ts';

const SKILL_MD = `---\nname: hello\ndescription: demo skill\n---\n\n# hello\n`;

const MANIFEST = (version: string): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/codex, version: ${version} }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: hello
    type: skill
    source: ./skills/hello
`;

function makePack(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), `packhub-derived-${version}-`));
  writeFileSync(join(dir, 'packhub.yaml'), MANIFEST(version), 'utf8');
  mkdirSync(join(dir, 'skills/hello'), { recursive: true });
  writeFileSync(join(dir, 'skills/hello/SKILL.md'), SKILL_MD, 'utf8');
  return dir;
}

describe('派生输出：install 期生成的文件也要进 planPaths', () => {
  it('codex 的 agents/openai.yaml 被 planPaths 明确列出，更新后仍在', async () => {
    const project = mkdtempSync(join(tmpdir(), 'packhub-derived-proj-'));
    const v1 = makePack('0.1.0');
    const v2 = makePack('0.2.0');

    const ctx1 = loadPack(v1);
    const plan1 = planFor(ctx1, { harness: 'codex' }).plan!;
    const yamlRel = '.codex/skills/hello/agents/openai.yaml';
    // 计划动作里没有这个文件（install 期才生成），但产物口径必须覆盖它
    expect(plan1.actions.some((a) => a.op === 'write' && a.to === yamlRel)).toBe(false);
    expect(planPaths(plan1)).toContain(yamlRel);

    const installed1 = await installPack(ctx1, plan1, { root: project, packRoot: v1 });
    expect(installed1.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    expect(existsSync(join(project, yamlRel))).toBe(true);
    const state1 = loadState(project);
    expect(state1.packs['demo/codex@0.1.0']?.written).toContainEqual({
      path: yamlRel,
      base: 'root',
    });

    // 更新到 0.2.0：先装新版，再按 planPaths 清理旧版本独有的文件
    const ctx2 = loadPack(v2);
    const plan2 = planFor(ctx2, { harness: 'codex' }).plan!;
    const installed2 = await installPack(ctx2, plan2, {
      root: project,
      packRoot: v2,
      overwrite: true,
    });
    expect(installed2.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    const previous: Plan = plan1; // state 里已被升级并入新 key，直接用安装时的快照
    const prune = pruneRemoved(project, previous, plan2);
    expect(prune.removed).not.toContain(yamlRel);
    expect(existsSync(join(project, yamlRel))).toBe(true);
    // 更新不会把它当「新计划没产出」删掉，写的还是源里的同一份
    expect(readFileSync(join(project, yamlRel), 'utf8')).toContain('display_name: "Hello"');

    rmSync(project, { recursive: true, force: true });
    rmSync(v1, { recursive: true, force: true });
    rmSync(v2, { recursive: true, force: true });
  });
});
