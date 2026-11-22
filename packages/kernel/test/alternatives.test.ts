import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor, validateGraph, type Manifest, type PlanAction } from '../src/index.ts';

function pack(manifest: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-alt-'));
  mkdirSync(join(dir, 'resources'), { recursive: true });
  writeFileSync(join(dir, 'packhub.yaml'), manifest, 'utf8');
  writeFileSync(join(dir, 'resources/a.md'), '# a\n', 'utf8');
  writeFileSync(join(dir, 'resources/b.md'), '# b\n', 'utf8');
  return dir;
}

/** 两个成员的 voice 组；pickBlock 是清单末尾追加的 pick 段。 */
const TWO_MEMBERS = (pickBlock: string): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/alternatives
  version: 0.0.1
requires:
  packhub: ">=0.0.1 <0.1"
alternatives:
  voice: [tts-a, tts-b]
resources:
  - id: tts-a
    type: mcp
    transport: stdio
    source: npm:tts-a@1.2.0
    provides: [tool/speak@1]
  - id: tts-b
    type: mcp
    transport: stdio
    source: npm:tts-b@0.4.0
    provides: [tool/speak@1]
${pickBlock}
`;

/** 只有一个成员的同一份清单：不写 pick 时应该自动选中它。 */
const ONE_MEMBER = `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/one-member
  version: 0.0.1
requires:
  packhub: ">=0.0.1 <0.1"
alternatives:
  voice: [tts-a]
resources:
  - id: tts-a
    type: mcp
    transport: stdio
    source: npm:tts-a@1.2.0
    provides: [tool/speak@1]
`;

/** 计划里被装了哪些资源 id（mcp 的 register.mcp 带 resource 字段）。 */
const installedIds = (actions: PlanAction[]): (string | undefined)[] =>
  actions.map((a) => ('resource' in a ? a.resource : undefined));

describe('备选组与选用（pick）', () => {
  it('单成员自动选中：不写 pick 也装那一个，没有 excluded', () => {
    const dir = pack(ONE_MEMBER);
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const { plan } = planFor(ctx);
    expect(plan).toBeDefined();
    expect(plan!.excluded).toEqual([]);
    expect(installedIds(plan!.actions)).toContain('tts-a');
    rmSync(dir, { recursive: true, force: true });
  });

  it('多成员 pick 中的才进计划，其余成员按 not-selected 排除', () => {
    const dir = pack(TWO_MEMBERS('pick:\n  voice: tts-b'));
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const { plan } = planFor(ctx);
    expect(plan).toBeDefined();
    expect(plan!.excluded).toEqual([
      { resource: 'tts-a', alternative: 'voice', reason: 'not-selected' },
    ]);
    const resources = installedIds(plan!.actions);
    expect(resources).toContain('tts-b');
    expect(resources).not.toContain('tts-a');
    rmSync(dir, { recursive: true, force: true });
  });

  it('换 pick 之后计划的哈希变化，且只动相关动作', () => {
    const a = pack(TWO_MEMBERS('pick:\n  voice: tts-a'));
    const b = pack(TWO_MEMBERS('pick:\n  voice: tts-b'));
    const pa = planFor(loadPack(a)).plan!;
    const pb = planFor(loadPack(b)).plan!;
    expect(pa.planHash).not.toBe(pb.planHash);
    expect(pa.actions).toHaveLength(pb.actions.length);
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });

  it('多成员没有 pick → alternative-unpicked', () => {
    const dir = pack(TWO_MEMBERS(''));
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    const issue = issues.find((i) => i.code === 'alternative-unpicked');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('2 个成员');
    rmSync(dir, { recursive: true, force: true });
  });

  it('pick 指向未声明的备选组 → alternative-unknown', () => {
    const dir = pack(TWO_MEMBERS('pick:\n  ghost: tts-a'));
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    expect(issues.map((i) => i.code)).toContain('alternative-unknown');
    rmSync(dir, { recursive: true, force: true });
  });

  it('pick 指向不存在的资源 → pick-unknown-resource', () => {
    const dir = pack(TWO_MEMBERS('pick:\n  voice: nope'));
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    const issue = issues.find((i) => i.code === 'pick-unknown-resource');
    expect(issue?.message).toContain('pick.voice');
    expect(issue?.message).toContain('nope');
    rmSync(dir, { recursive: true, force: true });
  });

  it('pick 指向存在但不属于这组的资源 → pick-not-in-alternatives', () => {
    const dir = pack(`apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/not-member, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
alternatives:
  voice: [tts-a]
resources:
  - id: tts-a
    type: mcp
    transport: stdio
    source: npm:tts-a@1.2.0
  - id: k
    type: knowledge
    source: ./resources/a.md
pick:
  voice: k
`);
    const { issues } = planFor(loadPack(dir));
    const issue = issues.find((i) => i.code === 'pick-not-in-alternatives');
    expect(issue?.message).toContain('k');
    expect(issue?.message).toContain('成员：tts-a');
    rmSync(dir, { recursive: true, force: true });
  });

  it('组里列了不存在的资源 → alternative-unknown-resource', () => {
    const dir = pack(`apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/missing-member, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
alternatives:
  voice: [tts-a, nope]
resources:
  - id: tts-a
    type: mcp
    transport: stdio
    source: npm:tts-a@1.2.0
`);
    const { issues } = planFor(loadPack(dir));
    const issue = issues.find((i) => i.code === 'alternative-unknown-resource');
    expect(issue?.message).toContain('nope');
    rmSync(dir, { recursive: true, force: true });
  });

  it('同一个资源只能进一个备选组 → resource-in-multiple-alternatives', () => {
    const dir = pack(`apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/two-groups, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
alternatives:
  voice: [tts-a]
  speech: [tts-a]
resources:
  - id: tts-a
    type: mcp
    transport: stdio
    source: npm:tts-a@1.2.0
`);
    const { issues } = planFor(loadPack(dir));
    const issue = issues.find((i) => i.code === 'resource-in-multiple-alternatives');
    expect(issue?.message).toContain('tts-a');
    expect(issue?.message).toContain('voice, speech');
    rmSync(dir, { recursive: true, force: true });
  });

  it('组里重复列同一个资源 → alternative-duplicate-member', () => {
    // 走 schema 时 uniqueItems 先把它拦成 schema 错，所以这里直接给 validateGraph 一份清单对象，
    // 保的是 kernel 自己的兜底（schema 被放宽或绕过时仍不静默）
    const manifest: Manifest = {
      apiVersion: 'packhub.dev/v0',
      kind: 'Pack',
      metadata: { name: 'demo/duplicate', version: '0.0.1' },
      requires: { packhub: '>=0.0.1 <0.1' },
      resources: [{ id: 'tts-a', type: 'mcp', transport: 'stdio', source: 'npm:tts-a@1.2.0' }],
      alternatives: { voice: ['tts-a', 'tts-a'] },
    };
    const issue = validateGraph(manifest).issues.find(
      (i) => i.code === 'alternative-duplicate-member',
    );
    expect(issue?.message).toContain('tts-a');
  });
});

describe('optional 与备选组', () => {
  it('被 pick 选中的 optional 成员不自动跳过', () => {
    const dir = pack(`apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/optional-picked, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
alternatives:
  search: [impl, other]
pick:
  search: impl
resources:
  - id: impl
    type: skill
    source: ./resources/a.md
    needs: [tool/missing@1]
    optional: true
  - id: other
    type: skill
    source: ./resources/b.md
`);
    const ctx = loadPack(dir);
    const { graph, issues } = validateGraph(ctx.manifest);
    expect(graph.resources.has('impl')).toBe(true);
    expect(issues.map((i) => i.code)).toContain('unmet-need');
    rmSync(dir, { recursive: true, force: true });
  });

  it('组内唯一成员（自动选中）的 optional 也不自动跳过', () => {
    const dir = pack(`apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/optional-single, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
alternatives:
  search: [impl]
resources:
  - id: impl
    type: skill
    source: ./resources/a.md
    needs: [tool/missing@1]
    optional: true
`);
    const ctx = loadPack(dir);
    const { graph, issues } = validateGraph(ctx.manifest);
    expect(graph.resources.has('impl')).toBe(true);
    expect(issues.map((i) => i.code)).toContain('unmet-need');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('local.yaml 的 pick 只改这次运行', () => {
  it('多成员没在清单里选，项目根的 .packhub/local.yaml 能定下来，清单不被改', () => {
    const dir = pack(TWO_MEMBERS(''));
    mkdirSync(join(dir, '.packhub'), { recursive: true });
    writeFileSync(join(dir, '.packhub/local.yaml'), 'pick:\n  voice: tts-a\n', 'utf8');

    const ctx = loadPack(dir);
    // local.yaml 的 pick 只进这次运行的 manifest；清单文件本身不动
    expect(ctx.manifest.pick).toEqual({ voice: 'tts-a' });
    const { plan } = planFor(ctx);
    expect(plan).toBeDefined();
    expect(installedIds(plan!.actions)).toContain('tts-a');
    expect(plan!.excluded).toEqual([
      { resource: 'tts-b', alternative: 'voice', reason: 'not-selected' },
    ]);
    expect(readFileSync(join(dir, 'packhub.yaml'), 'utf8')).not.toContain('pick:');
    rmSync(dir, { recursive: true, force: true });
  });
});
