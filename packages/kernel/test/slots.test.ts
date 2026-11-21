import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor } from '../src/index.ts';

function pack(manifest: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-slot-'));
  mkdirSync(join(dir, 'resources'), { recursive: true });
  writeFileSync(join(dir, 'packhub.yaml'), manifest, 'utf8');
  writeFileSync(join(dir, 'resources/a.md'), '# a\n', 'utf8');
  writeFileSync(join(dir, 'resources/b.md'), '# b\n', 'utf8');
  return dir;
}

/** 两个占用 voice 槽的候选；slotLines 往槽位里加行（例如 default），binding 决定 bindings。 */
const TWO_CANDIDATES = (binding: string, slotLines = ''): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/slots
  version: 0.0.1
requires:
  packhub: ">=0.0.1 <0.1"
slots:
  voice:
    contract: [tool/speak@1]
${slotLines}resources:
  - id: tts-a
    type: mcp
    transport: stdio
    slot: voice
    source: npm:tts-a@1.2.0
    provides: [tool/speak@1]
  - id: tts-b
    type: mcp
    transport: stdio
    slot: voice
    source: npm:tts-b@0.4.0
    provides: [tool/speak@1]
${binding}
`;

describe('槽位与绑定', () => {
  it('只装被绑定的实现，未绑定的候选进 excluded', () => {
    const dir = pack(TWO_CANDIDATES('bindings:\n  voice: tts-b'));
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const { plan } = planFor(ctx);
    expect(plan).toBeDefined();
    expect(plan!.excluded).toEqual([{ resource: 'tts-a', slot: 'voice', reason: 'unbound-slot' }]);
    const resources = plan!.actions.map((a) => ('resource' in a ? a.resource : undefined));
    expect(resources).toContain('tts-b');
    expect(resources).not.toContain('tts-a');
    rmSync(dir, { recursive: true, force: true });
  });

  it('换绑之后计划的哈希变化，且只动相关动作', () => {
    const a = pack(TWO_CANDIDATES('bindings:\n  voice: tts-a'));
    const b = pack(TWO_CANDIDATES('bindings:\n  voice: tts-b'));
    const pa = planFor(loadPack(a)).plan!;
    const pb = planFor(loadPack(b)).plan!;
    expect(pa.planHash).not.toBe(pb.planHash);
    expect(pa.actions).toHaveLength(pb.actions.length);
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });

  it('有候选但没绑定 → slot-unbound', () => {
    const dir = pack(TWO_CANDIDATES(''));
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    expect(issues.map((i) => i.code)).toContain('slot-unbound');
    rmSync(dir, { recursive: true, force: true });
  });

  it('绑定不满足契约 → slot-contract-unmet', () => {
    const dir = pack(`apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/contract, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
slots:
  voice:
    contract: [tool/speak@1, tool/stream@1]
resources:
  - id: tts-a
    type: mcp
    transport: stdio
    slot: voice
    source: npm:tts-a@1.2.0
    provides: [tool/speak@1]
bindings:
  voice: tts-a
`);
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    expect(issues.map((i) => i.code)).toContain('slot-contract-unmet');
    rmSync(dir, { recursive: true, force: true });
  });

  it('绑定到不占该槽的资源 → binding-wrong-slot', () => {
    const dir = pack(`apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/wrong, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
slots:
  voice: { contract: [tool/speak@1] }
resources:
  - id: tts-a
    type: mcp
    transport: stdio
    slot: voice
    source: npm:tts-a@1.2.0
    provides: [tool/speak@1]
  - id: k
    type: knowledge
    source: ./resources/a.md
bindings:
  voice: k
`);
    const { issues } = planFor(loadPack(dir));
    expect(issues.map((i) => i.code)).toContain('binding-wrong-slot');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('槽位默认实现（slots.default）', () => {
  it('不写 bindings 时用 default 兜底：default 生效，另一个候选 excluded', () => {
    const dir = pack(TWO_CANDIDATES('', '    default: tts-a\n'));
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const { plan } = planFor(ctx);
    expect(plan).toBeDefined();
    expect(plan!.excluded).toEqual([{ resource: 'tts-b', slot: 'voice', reason: 'unbound-slot' }]);
    const resources = plan!.actions.map((a) => ('resource' in a ? a.resource : undefined));
    expect(resources).toContain('tts-a');
    expect(resources).not.toContain('tts-b');
    rmSync(dir, { recursive: true, force: true });
  });

  it('bindings 覆盖 default：装绑定的那个，default 只兜底', () => {
    const dir = pack(TWO_CANDIDATES('bindings:\n  voice: tts-b', '    default: tts-a\n'));
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const { plan } = planFor(ctx);
    expect(plan).toBeDefined();
    expect(plan!.excluded).toEqual([{ resource: 'tts-a', slot: 'voice', reason: 'unbound-slot' }]);
    const resources = plan!.actions.map((a) => ('resource' in a ? a.resource : undefined));
    expect(resources).toContain('tts-b');
    expect(resources).not.toContain('tts-a');
    rmSync(dir, { recursive: true, force: true });
  });

  it('default 不满足契约 → slot-contract-unmet，文案点明来源是 default', () => {
    const dir = pack(`apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/contract-default, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
slots:
  voice:
    contract: [tool/speak@1, tool/stream@1]
    default: tts-a
resources:
  - id: tts-a
    type: mcp
    transport: stdio
    slot: voice
    source: npm:tts-a@1.2.0
    provides: [tool/speak@1]
`);
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    const issue = issues.find((i) => i.code === 'slot-contract-unmet');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('default tts-a');
    expect(issue?.message).toContain('tool/stream@1');
    rmSync(dir, { recursive: true, force: true });
  });

  it('default 指向不存在的资源 → binding-unknown-resource', () => {
    const dir = pack(TWO_CANDIDATES('', '    default: nope\n'));
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    const issue = issues.find((i) => i.code === 'binding-unknown-resource');
    expect(issue?.message).toContain('default');
    rmSync(dir, { recursive: true, force: true });
  });
});


