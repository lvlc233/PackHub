import { describe, expect, it } from 'vitest';
import { parseManifest, validateGraph } from '../src/index.ts';
import type { Manifest } from '../src/index.ts';

const base = (patch: Partial<Manifest> = {}): Manifest => {
  const res = parseManifest(
    JSON.stringify({
      apiVersion: 'packhub.dev/v0',
      kind: 'Pack',
      metadata: { name: 'a/b', version: '0.0.1', targets: ['dir'] },
      requires: { packhub: '>=0.0.1 <0.1' },
      resources: [{ id: 'plain', type: 'knowledge', source: './a.md' }],
      ...patch,
    }),
  );
  if (!res.manifest) throw new Error(res.issues.map((i) => i.message).join('\n'));
  return res.manifest;
};

describe('optional 资源', () => {
  it('needs 无人提供时自动跳过，不进错误', () => {
    const manifest = base({
      resources: [
        {
          id: 'optional-skill',
          type: 'skill',
          source: './skills/x',
          needs: ['tool:missing'],
          optional: true,
        },
        { id: 'plain', type: 'knowledge', source: './a.md' },
      ],
    });
    const { graph, issues } = validateGraph(manifest);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(graph.resources.has('optional-skill')).toBe(false);
    expect(graph.excluded).toContainEqual({
      resource: 'optional-skill',
      slot: '',
      reason: 'optional-unmet',
    });
    expect(graph.order).toEqual(['plain']);
  });

  it('级联跳过：provider 被跳过后依赖它的 optional 也跳过', () => {
    const manifest = base({
      resources: [
        {
          id: 'provider',
          type: 'skill',
          source: './skills/p',
          needs: ['tool:missing'],
          optional: true,
          provides: ['skill:p'],
        },
        {
          id: 'consumer',
          type: 'skill',
          source: './skills/c',
          needs: ['skill:p'],
          optional: true,
        },
      ],
    });
    const { graph, issues } = validateGraph(manifest);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(graph.excluded.map((e) => e.resource).sort()).toEqual(['consumer', 'provider']);
  });

  it('非 optional 资源缺能力仍然报错', () => {
    const manifest = base({
      resources: [{ id: 'x', type: 'skill', source: './skills/x', needs: ['tool:missing'] }],
    });
    expect(validateGraph(manifest).issues.map((i) => i.code)).toContain('unmet-need');
  });

  it('显式绑定到槽位的 optional 不自动跳过', () => {
    const manifest = base({
      resources: [
        {
          id: 'impl',
          type: 'skill',
          source: './skills/x',
          slot: 'search',
          needs: ['tool:missing'],
          optional: true,
        },
      ],
      slots: { search: { contract: ['tool:search'] } },
      bindings: { search: 'impl' },
    });
    const { graph, issues } = validateGraph(manifest);
    expect(graph.resources.has('impl')).toBe(true);
    expect(issues.map((i) => i.code)).toContain('unmet-need');
  });
});

describe('requires.agent', () => {
  it('已知 harness 不报警告', () => {
    const manifest = base({ requires: { packhub: '>=0.0.1 <0.1', agent: 'dsh' } });
    expect(validateGraph(manifest).issues.map((i) => i.code)).not.toContain('unknown-agent');
  });

  it('未知 harness 只警告，不阻断', () => {
    const manifest = base({ requires: { packhub: '>=0.0.1 <0.1', agent: 'future-agent' } });
    const { issues } = validateGraph(manifest);
    expect(issues.find((i) => i.code === 'unknown-agent')?.severity).toBe('warning');
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('requires.agent 不在 targets 里时警告', () => {
    const manifest = base({
      metadata: { name: 'a/b', version: '0.0.1', targets: ['dir'] },
      requires: { packhub: '>=0.0.1 <0.1', agent: 'dsh' },
    });
    expect(validateGraph(manifest).issues.map((i) => i.code)).toContain('agent-target-mismatch');
  });
});
