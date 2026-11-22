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

  it('同一令牌有多个 provider：全部进图，needs 任一满足，excluded 空', () => {
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
    // 能力叠加：两个 provider 都留下，不选边
    expect([...graph.resources.keys()]).toEqual(['consumer', 'rules-b', 'rules-a']);
    expect(graph.providers.get('content/rules@1')).toEqual(['rules-b', 'rules-a']);
    // consumer 的那条 needs 由两个 provider 都满足：两条边都派生
    expect(graph.edges).toEqual([
      { provider: 'rules-b', consumer: 'consumer', capability: 'content/rules@1' },
      { provider: 'rules-a', consumer: 'consumer', capability: 'content/rules@1' },
    ]);
    // 没有可选裁剪、没有宿主托管：excluded 是空的
    expect(graph.excluded).toEqual([]);
    // 顺序：两个 provider 都在 consumer 之前，彼此按清单顺序
    expect(graph.order).toEqual(['rules-b', 'rules-a', 'consumer']);
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
resources:
  - id: linter-a
    type: mcp
    transport: stdio
    source: npm:linter-a@1.0.0
    provides: [tool/lint@1]
  - id: linter-b
    type: mcp
    transport: stdio
    source: npm:linter-b@1.0.0
    provides: [tool/lint@1]
  - id: reviewer
    type: skill
    source: ./reviewer
    needs: [tool/lint@1]
    provides: [skill/review@1]
`);

  it('能力按令牌排序，同一令牌的多个 provider 全部列出，边按 needs 派生', () => {
    const m = manifest();
    const { graph } = validateGraph(m);
    expect(describeComposition({ manifest: m, graph })).toEqual({
      capabilities: {
        'skill/review@1': ['reviewer'],
        'tool/lint@1': ['linter-a', 'linter-b'],
      },
      edges: [
        { provider: 'linter-a', consumer: 'reviewer', capability: 'tool/lint@1' },
        { provider: 'linter-b', consumer: 'reviewer', capability: 'tool/lint@1' },
      ],
    });
    // 接线只是派生视图：全部资源都在图里，没有东西被排除
    expect(graph.excluded).toEqual([]);
    expect([...graph.resources.keys()]).toEqual(['linter-a', 'linter-b', 'reviewer']);
  });
});
