import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseManifest, readLocalOverrides } from '../src/index.ts';

const MANIFEST = (extra = ''): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/hint, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
${extra}`;

describe('已删除的字段点名报错', () => {
  it('清单里写了 alternatives / pick → removed-field，两个键都点名', () => {
    const res = parseManifest(MANIFEST('alternatives:\n  lint: [a]\npick:\n  lint: a\n'));
    expect(res.manifest).toBeUndefined();
    const removed = res.issues.filter((i) => i.code === 'removed-field');
    expect(removed).toHaveLength(2);
    expect(removed.every((i) => i.severity === 'error')).toBe(true);
    const messages = removed.map((i) => i.message).join('\n');
    expect(messages).toContain('alternatives：');
    expect(messages).toContain('pick：');
    expect(messages).toContain('已删除');
    // 不再落到笼统的 schema 错：作者看得出该删哪个键
    expect(res.issues.map((i) => i.code)).not.toContain('schema');
    expect(removed.map((i) => i.path).sort()).toEqual(['/alternatives', '/pick']);
  });

  it('不写已删字段的清单照常解析，不会误报', () => {
    const res = parseManifest(MANIFEST());
    expect(res.manifest).toBeDefined();
    expect(res.issues).toEqual([]);
  });
});

describe('.packhub/local.yaml 的未知键', () => {
  function fixture(localYaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-local-hint-'));
    writeFileSync(join(dir, 'packhub.yaml'), MANIFEST(), 'utf8');
    writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
    mkdirSync(join(dir, '.packhub'), { recursive: true });
    writeFileSync(join(dir, '.packhub/local.yaml'), localYaml, 'utf8');
    return dir;
  }

  it('写了已删的 pick → local-unknown-key 警告，键本身不被消费', () => {
    const dir = fixture('pick:\n  lint: rules\nvars:\n  foo: bar\n');
    const res = readLocalOverrides(dir);
    const warnings = res.issues.filter((i) => i.code === 'local-unknown-key');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('warning');
    expect(warnings[0]!.message).toContain('未识别的键：pick');
    expect(warnings[0]!.message).toContain('只接受 modify / vars');
    // 解析出的对象还在（是否有未知键由上面那条警告负责），已知键照常可用
    expect(Object.keys(res.file ?? {}).sort()).toEqual(['pick', 'vars']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('只写已知键（modify / vars）不告警', () => {
    const dir = fixture('vars:\n  foo: bar\n');
    expect(readLocalOverrides(dir).issues).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('没有 local.yaml 时既没有文件也没有问题', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-local-none-'));
    const res = readLocalOverrides(dir);
    expect(res.file).toBeUndefined();
    expect(res.issues).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
