import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { withMcpEntry, withoutMcpEntry, type McpLayout } from '../src/mcp-file.ts';

/**
 * dsh profile patch 的文本级编辑：写入 / 删除只动 `pal-mcp-*` 自己的那几行，
 * 用户的行、注释、空行与缩进逐字节不变；结构不是预期的顶层块数组时退回整份重写并报提示。
 */

const LAYOUT: McpLayout = {
  configPath: [],
  format: 'yaml',
  list: { field: 'insert', ownerPrefix: 'pal-mcp-' },
};

const KEY = 'pal-mcp-markdownlint';

const SPEC = {
  id: KEY,
  name: '@deepseek-ai/dsh-mcp-client',
  config: {
    serverName: 'markdownlint',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'markdownlint-mcp'],
  },
};

/** 用户自己的 patch 层：注释 + 一条 loader，缩进与引号都是用户自己的写法。 */
const USER_PATCH = [
  '# 用户自己的 patch 层（这段注释不该丢）',
  '- id: ui-settings-general',
  '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
  '  config:',
  '    welcomeNoticeVersion: 2026-09-28.1',
  '',
].join('\n');

function entryIds(text: string): string[] {
  // 用解析结果取条目 id：文本级写法与回退整份重写的排版不同，判断「写了哪些条目」不该看行
  const parsed: unknown = parse(text);
  if (!Array.isArray(parsed)) return [];
  const ids: string[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id === 'string') ids.push(record.id);
    const rows = record.insert;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const id = (row as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

describe('dsh patch 文本级编辑：写入', () => {
  it('空文件：写成一个顶层块数组，能读回条目', () => {
    const out = withMcpEntry('', LAYOUT, KEY, SPEC);
    expect(out).toContain('- insert:');
    expect(out).toContain(`- id: ${KEY}`);
    expect(out).toContain('serverName: markdownlint');
    expect(entryIds(out)).toEqual([KEY]);
  });

  it('`[]`（dsh 的空 patch）：把空数组记号换掉，不留流式写法', () => {
    const out = withMcpEntry('[]\n', LAYOUT, KEY, SPEC);
    expect(out.startsWith('- insert:')).toBe(true);
    expect(out).not.toContain('[]');
    expect(entryIds(out)).toEqual([KEY]);
  });

  it('用户内容原样保留（逐字节）：追加的块接在文件末尾', () => {
    const out = withMcpEntry(USER_PATCH, LAYOUT, KEY, SPEC);
    expect(out.startsWith(USER_PATCH)).toBe(true);
    expect(out).toContain(`- id: ${KEY}`);
    // 用户那条仍在，且没被重排
    expect(out).toContain('  name: "@deepseek-ai/dsh-client-ui-settings-general"');
    expect(entryIds(out)).toEqual(['ui-settings-general', KEY]);
  });

  it('已有条目：只换那一行块，用户部分逐字节不变', () => {
    const first = withMcpEntry(USER_PATCH, LAYOUT, KEY, SPEC);
    const next = withMcpEntry(
      first,
      LAYOUT,
      KEY,
      { ...SPEC, config: { ...SPEC.config, args: ['-y', 'markdownlint-mcp@2'] } },
    );
    expect(next.startsWith(USER_PATCH)).toBe(true);
    expect(next).toContain('markdownlint-mcp@2');
    // 只留一条，不重复追加
    expect(entryIds(next)).toEqual(['ui-settings-general', KEY]);
    expect(next.match(/insert:/g)).toHaveLength(1);
  });

  it('同一份内容重复写入不改字节（noop 判断靠它）', () => {
    const once = withMcpEntry(USER_PATCH, LAYOUT, KEY, SPEC);
    expect(withMcpEntry(once, LAYOUT, KEY, SPEC)).toBe(once);
  });
});

describe('dsh patch 文本级编辑：删除', () => {
  it('写入再删除：文件回到原文（用户部分逐字节不变）', () => {
    const written = withMcpEntry(USER_PATCH, LAYOUT, KEY, SPEC);
    expect(withoutMcpEntry(written, LAYOUT, KEY)).toBe(USER_PATCH);
  });

  it('CRLF 文件：追加与摘除都跟着原文件的换行符', () => {
    const crlf = USER_PATCH.replace(/\n/g, '\r\n');
    const written = withMcpEntry(crlf, LAYOUT, KEY, SPEC);
    expect(written.startsWith(crlf)).toBe(true);
    expect(written).not.toMatch(/[^\r]\n/); // 追加的块也是 CRLF
    expect(withoutMcpEntry(written, LAYOUT, KEY)).toBe(crlf);
  });

  it('空壳项（只剩我们一条 insert）摘完后返回空串，调用方据此删文件', () => {
    expect(withoutMcpEntry(withMcpEntry('', LAYOUT, KEY, SPEC), LAYOUT, KEY)).toBe('');
    expect(withoutMcpEntry(withMcpEntry('[]\n', LAYOUT, KEY, SPEC), LAYOUT, KEY)).toBe('');
  });

  it('我们那条在文件中间：只摘自己的块，后面的用户条目留着', () => {
    const middle = [
      '- id: first-user',
      '  name: "@deepseek-ai/dsh-client-first"',
      '',
      '- insert:',
      `    - id: ${KEY}`,
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '      config:',
      '        serverName: markdownlint',
      '        transport: stdio',
      '        command: npx',
      '',
      '# 后面的用户条目',
      '- id: last-user',
      '  name: "@deepseek-ai/dsh-client-last"',
      '',
    ].join('\n');
    const out = withoutMcpEntry(middle, LAYOUT, KEY);
    expect(out).not.toContain(KEY);
    expect(out).toContain('- id: first-user');
    expect(out).toContain('# 后面的用户条目');
    expect(out).toContain('- id: last-user');
    // 摘完仍是合法顶层数组
    expect(out.startsWith('- id: first-user')).toBe(true);
  });
});

describe('dsh patch：结构不符合预期时回退整份重写并报提示', () => {
  it('顶层是流式数组（非空）：回退重写，条目写入、用户条目保留、有提示', () => {
    const flow = '[ { id: first-user, name: "@deepseek-ai/dsh-client-first" } ]\n';
    const notes: string[] = [];
    const out = withMcpEntry(flow, LAYOUT, KEY, SPEC, (line) => notes.push(line));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('整份重写');
    expect(entryIds(out)).toEqual(['first-user', KEY]);
  });

  it('文件里有锚点：回退重写并报提示，条目照样写入', () => {
    const anchored = [
      '- id: first-user',
      '  name: &client "@deepseek-ai/dsh-client-first"',
      '- id: second-user',
      '  name: *client',
      '',
    ].join('\n');
    const notes: string[] = [];
    const out = withMcpEntry(anchored, LAYOUT, KEY, SPEC, (note) => notes.push(note));
    expect(notes).toHaveLength(1);
    expect(out).toContain(`- id: ${KEY}`);
    expect(out).toContain('first-user');
  });

  it('删除遇到锚点：回退重写，也只摘自己的条目', () => {
    const annotated = [
      '- insert:',
      `    - id: ${KEY}`,
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '- id: first-user',
      '  name: &client "@deepseek-ai/dsh-client-first"',
      '',
    ].join('\n');
    const notes: string[] = [];
    const out = withoutMcpEntry(annotated, LAYOUT, KEY, (note) => notes.push(note));
    expect(notes).toHaveLength(1);
    expect(out).not.toContain(KEY);
    expect(out).toContain('first-user');
  });
});
