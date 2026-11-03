import { describe, expect, it } from 'vitest';
import { parseManifest } from '@packhub/kernel';
import { validateGraph } from '@packhub/kernel';
import type { Manifest } from '@packhub/kernel';

const base = (patch: Partial<Manifest> = {}): string =>
  JSON.stringify({
    apiVersion: 'packhub.dev/v0',
    kind: 'Pack',
    metadata: { name: 'a/b', version: '0.0.1', targets: ['dir'] },
    requires: { packhub: '>=0.0.1 <0.1' },
    resources: [
      { id: 'tool-a', type: 'mcp', source: 'npm:@x/y@1.0.0', transport: 'stdio', provides: ['tool:search'] },
      { id: 'skill-b', type: 'skill', source: './skills/b', needs: ['tool:search'], provides: ['skill:b'] },
    ],
    ...patch,
  });

const load = (yamlOrJson: string): Manifest => {
  const res = parseManifest(yamlOrJson);
  if (!res.manifest) throw new Error(res.issues.map((i) => i.message).join('\n'));
  return res.manifest;
};

describe('validateGraph', () => {
  it('合法图无错误，且拓扑上先装 provider', () => {
    const { graph, issues } = validateGraph(load(base()));
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(graph.order.indexOf('tool-a')).toBeLessThan(graph.order.indexOf('skill-b'));
  });

  it('needs 无人提供时报错', () => {
    const manifest = load(base({ resources: [{ id: 'skill-b', type: 'skill', source: './s', needs: ['tool:none'] }] }));
    const { issues } = validateGraph(manifest);
    expect(issues.map((i) => i.code)).toContain('unmet-need');
  });

  it('同一 locator 不同 pin 时报冲突', () => {
    const manifest = load(
      base({
        resources: [
          { id: 'a', type: 'mcp', source: 'npm:left-pad@1.0.0', transport: 'stdio' },
          { id: 'b', type: 'mcp', source: 'npm:left-pad@2.0.0', transport: 'stdio' },
        ],
      }),
    );
    expect(validateGraph(manifest).issues.map((i) => i.code)).toContain('pin-conflict');
  });

  it('composition.order 与 dependsOn 矛盾时报错', () => {
    const manifest = load(
      base({
        resources: [
          { id: 'tool-a', type: 'mcp', source: 'npm:@x/y@1.0.0', transport: 'stdio', provides: ['tool:search'] },
          { id: 'skill-b', type: 'skill', source: './skills/b', dependsOn: ['tool-a'], needs: ['tool:search'] },
        ],
        composition: { order: ['skill-b', 'tool-a'] },
      }),
    );
    expect(validateGraph(manifest).issues.map((i) => i.code)).toContain('order-violates-dependency');
  });

  it('bind 指向未提供该能力的资源时报错', () => {
    const manifest = load(
      base({
        composition: { needs: [{ capability: 'tool:search', requires: ['skill:b'], bind: 'skill-b' }] },
      }),
    );
    expect(validateGraph(manifest).issues.map((i) => i.code)).toContain('bad-bind');
  });

  it('重复 id 报错', () => {
    const manifest = load(
      base({
        resources: [
          { id: 'a', type: 'mcp', source: 'npm:x@1.0.0', transport: 'stdio' },
          { id: 'a', type: 'mcp', source: 'npm:y@1.0.0', transport: 'stdio' },
        ],
      }),
    );
    expect(validateGraph(manifest).issues.map((i) => i.code)).toContain('duplicate-resource-id');
  });

  it('依赖成环报错', () => {
    const manifest = load(
      base({
        resources: [
          { id: 'a', type: 'knowledge', source: './a', dependsOn: ['b'], provides: [] },
          { id: 'b', type: 'knowledge', source: './b.md', dependsOn: ['a'], provides: [] },
        ],
      }),
    );
    expect(validateGraph(manifest).issues.map((i) => i.code)).toContain('dependency-cycle');
  });
});
