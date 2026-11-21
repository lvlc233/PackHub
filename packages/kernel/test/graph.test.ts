import { describe, expect, it } from 'vitest';
import { describeComposition, parseManifest, validateGraph } from '../src/index.ts';
import type { Manifest } from '../src/index.ts';

const base = (patch: Partial<Manifest> = {}): string =>
  JSON.stringify({
    apiVersion: 'packhub.dev/v0',
    kind: 'Pack',
    metadata: { name: 'a/b', version: '0.0.1' },
    requires: { packhub: '>=0.0.1 <0.1' },
    resources: [
      { id: 'tool-a', type: 'mcp', source: 'npm:@x/y@1.0.0', transport: 'stdio', provides: ['tool/search@1'] },
      { id: 'skill-b', type: 'skill', source: './skills/b', needs: ['tool/search@1'], provides: ['skill/b@1'] },
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
    // 顺序不是白来的：needs 派生出 provider → consumer 的边
    expect(graph.edges).toEqual([
      { provider: 'tool-a', consumer: 'skill-b', capability: 'tool/search@1' },
    ]);
  });

  it('安装顺序只由 needs 派生，与清单书写顺序无关', () => {
    // consumer 写在前面：旧的按清单顺序排会先装 skill-b，现在必须把 tool-a 提到前面
    const manifest = load(
      base({
        resources: [
          { id: 'skill-b', type: 'skill', source: './skills/b', needs: ['tool/search@1'] },
          { id: 'tool-a', type: 'mcp', source: 'npm:@x/y@1.0.0', transport: 'stdio', provides: ['tool/search@1'] },
        ],
      }),
    );
    expect(validateGraph(manifest).graph.order).toEqual(['tool-a', 'skill-b']);
  });

  it('同一令牌有多个 provider：全部先于 consumer，彼此按清单顺序', () => {
    const manifest = load(
      base({
        resources: [
          { id: 'consumer', type: 'skill', source: './skills/c', needs: ['content/rules@1'] },
          { id: 'rules-b', type: 'knowledge', source: './rules-b.md', provides: ['content/rules@1'] },
          { id: 'rules-a', type: 'knowledge', source: './rules-a.md', provides: ['content/rules@1'] },
        ],
      }),
    );
    const { graph, issues } = validateGraph(manifest);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(graph.order.indexOf('rules-b')).toBeLessThan(graph.order.indexOf('consumer'));
    expect(graph.order.indexOf('rules-a')).toBeLessThan(graph.order.indexOf('consumer'));
    // 没有依赖的两个 provider 之间按清单顺序
    expect(graph.order.indexOf('rules-b')).toBeLessThan(graph.order.indexOf('rules-a'));
  });

  it('needs 无人提供时报错', () => {
    const manifest = load(base({ resources: [{ id: 'skill-b', type: 'skill', source: './s', needs: ['tool/none@1'] }] }));
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

  it('依赖成环报错（环由 provides / needs 表达）', () => {
    const manifest = load(
      base({
        resources: [
          {
            id: 'a',
            type: 'knowledge',
            source: './a.md',
            provides: ['content/a@1'],
            needs: ['content/b@1'],
          },
          {
            id: 'b',
            type: 'knowledge',
            source: './b.md',
            provides: ['content/b@1'],
            needs: ['content/a@1'],
          },
        ],
      }),
    );
    expect(validateGraph(manifest).issues.map((i) => i.code)).toContain('dependency-cycle');
  });
});

describe('describeComposition', () => {
  const manifest = (): Manifest =>
    load(`apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: a/b, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
slots:
  review:
    contract: [tool/lint@1]
    default: linter-a
resources:
  - id: linter-a
    type: mcp
    transport: stdio
    slot: review
    source: npm:linter-a@1.0.0
    provides: [tool/lint@1]
  - id: linter-b
    type: mcp
    transport: stdio
    slot: review
    source: npm:linter-b@1.0.0
    provides: [tool/lint@1]
  - id: reviewer
    type: skill
    source: ./reviewer
    needs: [tool/lint@1]
    provides: [skill/review@1]
`);

  it('能力按令牌排序、边按 needs、槽位给出 default 与落选原因', () => {
    const m = manifest();
    const { graph } = validateGraph(m);
    // 落选的槽位候选不进图（这次不装，也就不供能力），但会出现在 slots[].excluded 里
    expect(describeComposition({ manifest: m, graph })).toEqual({
      capabilities: {
        'skill/review@1': ['reviewer'],
        'tool/lint@1': ['linter-a'],
      },
      edges: [
        { provider: 'linter-a', consumer: 'reviewer', capability: 'tool/lint@1' },
      ],
      slots: [
        {
          name: 'review',
          contract: ['tool/lint@1'],
          default: 'linter-a',
          effective: 'linter-a',
          candidates: ['linter-a', 'linter-b'],
          excluded: [{ resource: 'linter-b', reason: 'unbound-slot' }],
        },
      ],
    });
  });

  it('bindings 覆盖 default：effective 是 bound，default 原样露出来给读者看', () => {
    const m = manifest();
    m.bindings = { review: 'linter-b' };
    const { graph } = validateGraph(m);
    const slot = describeComposition({ manifest: m, graph }).slots[0]!;
    expect(slot).toMatchObject({
      default: 'linter-a',
      bound: 'linter-b',
      effective: 'linter-b',
      excluded: [{ resource: 'linter-a', reason: 'unbound-slot' }],
    });
  });
});
