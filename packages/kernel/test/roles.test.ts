import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor, type PlanAction } from '../src/index.ts';

function pack(manifest: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-role-'));
  mkdirSync(join(dir, 'resources'), { recursive: true });
  writeFileSync(join(dir, 'packhub.yaml'), manifest, 'utf8');
  writeFileSync(join(dir, 'resources/a.md'), '# a\n', 'utf8');
  writeFileSync(join(dir, 'resources/b.md'), '# b\n', 'utf8');
  return dir;
}

/** 两个占 voice 角色的候选；roleLines 往角色里加行（例如 default），pickBlock 决定 pick。 */
const TWO_CANDIDATES = (pickBlock: string, roleLines = ''): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/roles
  version: 0.0.1
requires:
  packhub: ">=0.0.1 <0.1"
roles:
  voice:
    needs: [tool/speak@1]
${roleLines}resources:
  - id: tts-a
    type: mcp
    transport: stdio
    role: voice
    source: npm:tts-a@1.2.0
    provides: [tool/speak@1]
  - id: tts-b
    type: mcp
    transport: stdio
    role: voice
    source: npm:tts-b@0.4.0
    provides: [tool/speak@1]
${pickBlock}
`;

/** 只有一个候选的同一份清单：不写 pick / default 时应该自动选中它。 */
const ONE_CANDIDATE = (roleLines = ''): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/one-role
  version: 0.0.1
requires:
  packhub: ">=0.0.1 <0.1"
roles:
  voice:
    needs: [tool/speak@1]
${roleLines}resources:
  - id: tts-a
    type: mcp
    transport: stdio
    role: voice
    source: npm:tts-a@1.2.0
    provides: [tool/speak@1]
`;

/** 计划里被装了哪些资源 id（mcp 的 register.mcp 带 resource 字段）。 */
const installedIds = (actions: PlanAction[]): (string | undefined)[] =>
  actions.map((a) => ('resource' in a ? a.resource : undefined));

describe('角色与选用（pick）', () => {
  it('pick 选中的实现才进计划，未选中的候选按 not-selected 排除', () => {
    const dir = pack(TWO_CANDIDATES('pick:\n  voice: tts-b'));
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const { plan } = planFor(ctx);
    expect(plan).toBeDefined();
    expect(plan!.excluded).toEqual([{ resource: 'tts-a', role: 'voice', reason: 'not-selected' }]);
    const resources = installedIds(plan!.actions);
    expect(resources).toContain('tts-b');
    expect(resources).not.toContain('tts-a');
    rmSync(dir, { recursive: true, force: true });
  });

  it('换 pick 之后计划的哈希变化，且只动相关动作', () => {
    const a = pack(TWO_CANDIDATES('pick:\n  voice: tts-a'));
    const b = pack(TWO_CANDIDATES('pick:\n  voice: tts-b'));
    const pa = planFor(loadPack(a)).plan!;
    const pb = planFor(loadPack(b)).plan!;
    expect(pa.planHash).not.toBe(pb.planHash);
    expect(pa.actions).toHaveLength(pb.actions.length);
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });

  it('多候选既没 pick 也没 default → role-unfilled', () => {
    const dir = pack(TWO_CANDIDATES(''));
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    expect(issues.map((i) => i.code)).toContain('role-unfilled');
    rmSync(dir, { recursive: true, force: true });
  });

  it('pick 选中的实现不满足角色的 needs → role-needs-unmet', () => {
    const dir = pack(`apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/needs, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
roles:
  voice:
    needs: [tool/speak@1, tool/stream@1]
resources:
  - id: tts-a
    type: mcp
    transport: stdio
    role: voice
    source: npm:tts-a@1.2.0
    provides: [tool/speak@1]
pick:
  voice: tts-a
`);
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    const issue = issues.find((i) => i.code === 'role-needs-unmet');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('pick.voice');
    expect(issue?.message).toContain('tool/stream@1');
    rmSync(dir, { recursive: true, force: true });
  });

  it('pick 指向不占该角色的资源 → pick-wrong-role', () => {
    const dir = pack(`apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/wrong, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
roles:
  voice: { needs: [tool/speak@1] }
resources:
  - id: tts-a
    type: mcp
    transport: stdio
    role: voice
    source: npm:tts-a@1.2.0
    provides: [tool/speak@1]
  - id: k
    type: knowledge
    source: ./resources/a.md
pick:
  voice: k
`);
    const { issues } = planFor(loadPack(dir));
    expect(issues.map((i) => i.code)).toContain('pick-wrong-role');
    rmSync(dir, { recursive: true, force: true });
  });

  it('pick 指向未声明的角色 → pick-unknown-role', () => {
    const dir = pack(TWO_CANDIDATES('pick:\n  ghost: tts-a'));
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    expect(issues.map((i) => i.code)).toContain('pick-unknown-role');
    rmSync(dir, { recursive: true, force: true });
  });

  it('资源占未声明的角色 → unknown-role', () => {
    const dir = pack(`apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/ghost, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
roles:
  voice: { needs: [tool/speak@1] }
resources:
  - id: tts-a
    type: mcp
    transport: stdio
    role: ghost
    source: npm:tts-a@1.2.0
    provides: [tool/speak@1]
`);
    const { issues } = planFor(loadPack(dir));
    expect(issues.map((i) => i.code)).toContain('unknown-role');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('唯一候选自动选中（不写 pick / default）', () => {
  it('只有一个候选时直接选中它，没有 excluded', () => {
    const dir = pack(ONE_CANDIDATE());
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const { plan } = planFor(ctx);
    expect(plan).toBeDefined();
    expect(plan!.excluded).toEqual([]);
    expect(installedIds(plan!.actions)).toContain('tts-a');
    rmSync(dir, { recursive: true, force: true });
  });

  it('自动选中不等于免检：唯一候选缺 needs 仍报 role-needs-unmet', () => {
    const dir = pack(
      ONE_CANDIDATE().replace('needs: [tool/speak@1]', 'needs: [tool/speak@1, tool/stream@1]'),
    );
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    const issue = issues.find((i) => i.code === 'role-needs-unmet');
    expect(issue?.message).toContain('唯一候选');
    expect(issue?.message).toContain('tool/stream@1');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('角色的默认实现（roles[].default）', () => {
  it('不写 pick 时用 default 兜底：default 生效，另一个候选 excluded', () => {
    const dir = pack(TWO_CANDIDATES('', '    default: tts-a\n'));
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const { plan } = planFor(ctx);
    expect(plan).toBeDefined();
    expect(plan!.excluded).toEqual([{ resource: 'tts-b', role: 'voice', reason: 'not-selected' }]);
    const resources = installedIds(plan!.actions);
    expect(resources).toContain('tts-a');
    expect(resources).not.toContain('tts-b');
    rmSync(dir, { recursive: true, force: true });
  });

  it('pick 覆盖 default：装 pick 的那个，default 只兜底', () => {
    const dir = pack(TWO_CANDIDATES('pick:\n  voice: tts-b', '    default: tts-a\n'));
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const { plan } = planFor(ctx);
    expect(plan).toBeDefined();
    expect(plan!.excluded).toEqual([{ resource: 'tts-a', role: 'voice', reason: 'not-selected' }]);
    const resources = installedIds(plan!.actions);
    expect(resources).toContain('tts-b');
    expect(resources).not.toContain('tts-a');
    rmSync(dir, { recursive: true, force: true });
  });

  it('default 不满足 needs → role-needs-unmet，文案点明来源是 default', () => {
    const dir = pack(`apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/needs-default, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
roles:
  voice:
    needs: [tool/speak@1, tool/stream@1]
    default: tts-a
resources:
  - id: tts-a
    type: mcp
    transport: stdio
    role: voice
    source: npm:tts-a@1.2.0
    provides: [tool/speak@1]
`);
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    const issue = issues.find((i) => i.code === 'role-needs-unmet');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('default tts-a');
    expect(issue?.message).toContain('tool/stream@1');
    rmSync(dir, { recursive: true, force: true });
  });

  it('default 指向不存在的资源 → pick-unknown-resource', () => {
    const dir = pack(TWO_CANDIDATES('', '    default: nope\n'));
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    const issue = issues.find((i) => i.code === 'pick-unknown-resource');
    expect(issue?.message).toContain('default');
    rmSync(dir, { recursive: true, force: true });
  });

  it('default 被 pick 覆盖时也校验：坏 default 不能靠 pick 藏起来', () => {
    const dir = pack(TWO_CANDIDATES('pick:\n  voice: tts-b', '    default: nope\n'));
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    expect(issues.map((i) => i.code)).toContain('pick-unknown-resource');
    rmSync(dir, { recursive: true, force: true });
  });
});
