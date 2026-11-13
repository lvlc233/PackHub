import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addResource, inferId, setBinding } from '../src/authoring.ts';
import { loadPack, planFor } from '../src/index.ts';

const MANIFEST = `# 注释要被保留
apiVersion: packhub.dev/v0
kind: Pack

metadata:
  name: demo/authoring
  version: 0.0.1
  targets: [dir]

requires:
  packhub: ">=0.0.1 <0.1"

resources:
  - id: style-guide
    type: knowledge
    source: ./resources/style-guide.md

verify:
  - type: file-exists
    path: .packhub/knowledge/style-guide.md
`;

function fixture(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-author-'));
  const file = join(dir, 'packhub.yaml');
  writeFileSync(file, MANIFEST, 'utf8');
  return { dir, file };
}

describe('inferId', () => {
  it('npm / github / https / 本地各取尾段', () => {
    expect(inferId('npm:@scope/server-everything@0.6.2')).toBe('server-everything');
    expect(inferId('github:o/r/skills/code-review@abc')).toBe('code-review');
    expect(inferId('https://example.com/docs/style.md')).toBe('style');
    expect(inferId('./resources/team-rules.yaml')).toBe('team-rules');
  });

  it('重名自动加序号', () => {
    expect(inferId('npm:x', ['x'])).toBe('x-2');
  });
});

describe('addResource', () => {
  it('追加资源且保留注释', () => {
    const { dir, file } = fixture();
    const { id } = addResource(file, { type: 'mcp', source: 'npm:@modelcontextprotocol/server-filesystem@1.0.0' });
    expect(id).toBe('server-filesystem');

    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# 注释要被保留');
    expect(text).toContain('server-filesystem');

    const ctx = loadPack(dir);
    const errors = ctx.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    const { plan } = planFor(ctx);
    expect(plan?.actions.some((a) => a.op === 'register.mcp')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('显式 id 与重名都按预期处理', () => {
    const { dir, file } = fixture();
    expect(() => addResource(file, { type: 'knowledge', source: './a.md', id: 'style-guide' })).toThrow(
      /id 已存在/,
    );
    const { id } = addResource(file, { type: 'knowledge', source: './a.md', id: 'extra' });
    expect(id).toBe('extra');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('setBinding（换实现）', () => {
  const withSlots = `# 头部注释
apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/slots, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
slots:
  voice: { contract: [audio:speak] }
resources:
  - id: tts-a
    type: mcp
    transport: stdio
    slot: voice
    source: npm:tts-a@1.2.0
    provides: [audio:speak]
  - id: tts-b
    type: mcp
    transport: stdio
    slot: voice
    source: npm:tts-b@0.4.0
    provides: [audio:speak]
bindings:
  voice: tts-a
`;

  function fixture(): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-bind-'));
    const file = join(dir, 'packhub.yaml');
    writeFileSync(file, withSlots, 'utf8');
    return { dir, file };
  }

  it('只改 bindings 那一个键，注释与结构保留', () => {
    const { file } = fixture();
    const { id } = setBinding(file, 'voice', 'tts-b');
    expect(id).toBe('tts-b');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# 头部注释');
    expect(text).toMatch(/bindings:\s*\n\s*voice: tts-b/);
    expect(text).toContain('tts-a');
  });

  it('槽位不存在、资源不存在、资源不占该槽都要报错', () => {
    const { file } = fixture();
    expect(() => setBinding(file, 'nope', 'tts-a')).toThrow(/没有声明槽位/);
    expect(() => setBinding(file, 'voice', 'nope')).toThrow(/没有这个资源/);
    expect(() => setBinding(file, 'voice', 'x')).toThrow();
  });
});
