import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, readInstance, updateInstance } from '../src/index.ts';

/**
 * codex 的 `agents/openai.yaml` 是 install 期从 SKILL.md frontmatter 生成的派生输出，
 * 计划里没有对应的动作。它被写进 state.written，所以 update 判「旧版独有文件」时
 * 必须知道「新计划仍然会产出它」（kernel 的 planPaths 现在把 codex 目标的这条派生路径算进去），
 * 否则每次 update 都会把刚生成的那份删掉。
 */
const SKILL_V1 = `---
name: note
description: 更新回归用的技能
---

# Note

第一版正文；agents/openai.yaml 由 frontmatter 生成。
`;

let tmp: string;

/** 造一个 target 只有 codex 的 Pack：一个本地 skill。 */
function codexPack(version: string, skill: string): string {
  const dir = join(tmp, `pack-${version}`);
  mkdirSync(join(dir, 'skills', 'note'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'note', 'SKILL.md'), skill, 'utf8');
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/codex-derived, version: ${version}, targets: [codex] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: note
    type: skill
    source: ./skills/note
`,
    'utf8',
  );
  return dir;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-codex-upd-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  process.env.PACKHUB_HOME = join(tmp, 'home');
});

afterEach(() => {
  delete process.env.PACKHUB_INSTANCES;
  delete process.env.PACKHUB_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe('pal update：codex 派生输出', () => {
  it('更新后 <skills>/<skill>/agents/openai.yaml 仍在，也不列进 removedFiles', async () => {
    const v1 = codexPack('0.1.0', SKILL_V1);
    const rec = await createInstance({ name: 'codex-upd', harness: 'codex', packDir: v1, packRef: v1 });
    expect(readInstance(rec.id)?.harness).toBe('codex');

    // launcher 把 codex 的落点换成实例自己的 home 段：home/codex/skills/<id>
    const yaml = join(rec.root, 'home', 'codex', 'skills', 'note', 'agents', 'openai.yaml');
    expect(existsSync(yaml)).toBe(true);
    expect(readFileSync(yaml, 'utf8')).toContain('display_name');

    // 换版本、换 skill 正文：link.skill 会整目录重铺，派生文件由 install 重新生成，
    // 它必须活过 update 的「清掉上一版独有文件」这一步。
    const v2 = codexPack('0.2.0', `${SKILL_V1}\n第二版追加一行。\n`);
    const result = await updateInstance('codex-upd', { packDir: v2 });

    expect(result.changed).toBe(true);
    expect(result.to).toBe('demo/codex-derived@0.2.0');
    expect(result.removedFiles).not.toContain('home/codex/skills/note/agents/openai.yaml');
    expect(existsSync(yaml)).toBe(true);
    expect(readFileSync(yaml, 'utf8')).toContain('display_name');
  });
});
