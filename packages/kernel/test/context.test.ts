import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadPack, planFor } from '../src/index.ts';

function pack(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-context-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

const base = (contextLine: string): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/ctx, version: 0.0.1, targets: [dir, dsh] }
requires: { packhub: ">=0.0.1 <0.1" }
${contextLine}
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`;

describe('整合包的上下文', () => {
  it('内联文本排在说明块最前面，资源清单在后面', () => {
    const dir = pack({
      'packhub.yaml': base(`context: |
  这个环境是给文档审阅用的。
  默认只检查、不改文件。`),
      'rules.md': '# 规则\n',
    });
    const { plan, issues } = planFor(loadPack(dir), { target: 'dsh' });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    const inst = plan!.actions.find((a) => a.op === 'instruction');
    const content = inst && inst.op === 'instruction' ? inst.content : '';
    expect(content.startsWith('这个环境是给文档审阅用的。')).toBe(true);
    expect(content.indexOf('默认只检查、不改文件。')).toBeLessThan(content.indexOf('可用的能力'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('写成 ./ 路径时读包里的文件', () => {
    const dir = pack({
      'packhub.yaml': base('context: ./CONTEXT.md'),
      'CONTEXT.md': '这是文件里的开场。\n',
      'rules.md': '# 规则\n',
    });
    const { plan } = planFor(loadPack(dir), { target: 'dsh' });
    const inst = plan!.actions.find((a) => a.op === 'instruction');
    const content = inst && inst.op === 'instruction' ? inst.content : '';
    expect(content.startsWith('这是文件里的开场。')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('文件不存在 → context-file-missing', () => {
    const dir = pack({
      'packhub.yaml': base('context: ./NOPE.md'),
      'rules.md': '# 规则\n',
    });
    const { plan, issues } = planFor(loadPack(dir), { target: 'dsh' });
    expect(issues.map((i) => i.code)).toContain('context-file-missing');
    expect(plan).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('指向包目录之外 → context-outside-pack', () => {
    const dir = pack({
      'packhub.yaml': base('context: ../outside.md'),
      'rules.md': '# 规则\n',
    });
    const { issues } = planFor(loadPack(dir), { target: 'dsh' });
    expect(issues.map((i) => i.code)).toContain('context-outside-pack');
    rmSync(dir, { recursive: true, force: true });
  });
});
