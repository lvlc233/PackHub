import { describe, expect, it } from 'vitest';
import { parseCatalog, searchResources } from '../src/index.ts';

const entry = {
  id: 'mcp/filesystem',
  type: 'mcp',
  source: 'npm:@modelcontextprotocol/server-filesystem@0.6.2',
  title: 'MCP Filesystem',
  description: '把目录暴露给 agent',
  keywords: ['mcp', 'files'],
  provides: ['tool:repo_search'],
};

describe('资源目录', () => {
  it('校验结构：坏类型、重复 id、缺字段都报错', () => {
    const bad = parseCatalog({
      apiVersion: 'packhub.dev/resources/v0',
      resources: [
        { id: 'demo/a', type: 'nope', source: 'npm:x@1.0.0' },
        { id: 'demo/b', type: 'mcp' },
        { id: 'demo/c', type: 'mcp', source: 'npm:y@1.0.0' },
        { id: 'demo/c', type: 'mcp', source: 'npm:z@1.0.0' },
      ],
    });
    const messages = bad.issues.map((i) => i.message).join('\n');
    expect(messages).toContain('type 不合法');
    expect(messages).toContain('缺少 source');
    expect(messages).toContain('id 重复');
  });

  it('搜索按字段加权，多个词要求同时命中', () => {
    const { catalog } = parseCatalog({
      apiVersion: 'packhub.dev/resources/v0',
      resources: [
        entry,
        { id: 'skill/review', type: 'skill', source: 'github:o/r/skills/review@abc1234', title: '审查', description: 'code review' },
      ],
    });
    expect(catalog).toBeTruthy();
    const byId = searchResources(catalog!.resources, 'filesystem');
    expect(byId[0]?.entry.id).toBe('mcp/filesystem');
    expect(byId[0]?.matched).toContain('id');

    const both = searchResources(catalog!.resources, 'review code');
    expect(both.map((h) => h.entry.id)).toEqual(['skill/review']);

    expect(searchResources(catalog!.resources, 'missing-term')).toEqual([]);
  });
});
