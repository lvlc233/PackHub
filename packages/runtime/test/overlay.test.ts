import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPack, planFor, verifyPack } from '../src/index.ts';

function pack(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-overlay-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

const BASE = (
  extra: string,
  overlays = `
overlays:
  - from: ./overrides
    note: 把上游的示例知识换成本项目的规范
`,
): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/overlay
  version: 0.0.1
  targets: [dir]
requires:
  packhub: ">=0.0.1 <0.1"
resources:
${extra}
${overlays}
`;

describe('overlays：mod 的 mod', () => {
  it('覆盖层盖住生成的文件，且验证看得到结果', async () => {
    const dir = pack({
      'packhub.yaml': BASE(`  - id: rules
    type: knowledge
    source: ./resources/rules.md`),
      'resources/rules.md': '# 上游原文\n',
      'overrides/.packhub/knowledge/rules.md': '# 本项目改过的规范\n',
    });

    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const { plan } = planFor(ctx);
    const writes = plan!.actions.filter((a) => a.op === 'write');
    expect(writes.map((w) => w.op === 'write' && w.to)).toContain('.packhub/knowledge/rules.md');
    // 覆盖层排在资源之后，才盖得住
    expect(writes.at(-1)?.op === 'write' && writes.at(-1)?.to).toBe('.packhub/knowledge/rules.md');

    const result = await installPack(ctx, plan!, {});
    expect(result.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    expect(readFileSync(join(dir, '.packhub/knowledge/rules.md'), 'utf8')).toBe('# 本项目改过的规范\n');

    const checks = await verifyPack(dir, plan!);
    expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('两个覆盖层改同一个文件 → overlay-conflict', () => {
    const dir = pack({
      'packhub.yaml': `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/two-overlays
  version: 0.0.1
  targets: [dir]
requires:
  packhub: ">=0.0.1 <0.1"
resources:
  - id: rules
    type: knowledge
    source: ./resources/rules.md
overlays:
  - from: ./a
  - from: ./b
`,
      'resources/rules.md': '# 原文\n',
      'a/x.md': 'A\n',
      'b/x.md': 'B\n',
    });
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    expect(issues.map((i) => i.code)).toContain('overlay-conflict');
    rmSync(dir, { recursive: true, force: true });
  });

  it('覆盖层盖住生成文件时给出警告而不是报错', () => {
    const dir = pack({
      'packhub.yaml': BASE(`  - id: rules
    type: knowledge
    source: ./resources/rules.md`),
      'resources/rules.md': '# 上游\n',
      'overrides/.packhub/knowledge/rules.md': '# 改过\n',
    });
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeDefined();
    expect(issues.map((i) => i.code)).toContain('overlay-shadows');
    rmSync(dir, { recursive: true, force: true });
  });

  it('两个 config 资源改同一个键 → config-key-conflict', () => {
    const dir = pack({
      'packhub.yaml': `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/key-conflict
  version: 0.0.1
  targets: [dir]
requires:
  packhub: ">=0.0.1 <0.1"
resources:
  - id: cfg-a
    type: config
    source: ./fragments/a.yaml
  - id: cfg-b
    type: config
    source: ./fragments/b.yaml
`,
      'fragments/a.yaml': 'review:\n  strict: true\n',
      'fragments/b.yaml': 'review:\n  strict: false\n',
    });
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    expect(issues.map((i) => i.code)).toContain('config-key-conflict');
    rmSync(dir, { recursive: true, force: true });
  });

  it('overrides 指向不存在的资源 → override-unknown-resource', () => {
    const dir = pack({
      'packhub.yaml': `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/bad-override
  version: 0.0.1
  targets: [dir]
requires:
  packhub: ">=0.0.1 <0.1"
resources:
  - id: rules
    type: knowledge
    source: ./resources/rules.md
overrides:
  - resource: nope
    source: npm:x@1.0.0
`,
      'resources/rules.md': '# x\n',
    });
    const { issues } = planFor(loadPack(dir));
    expect(issues.map((i) => i.code)).toContain('override-unknown-resource');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('overrides：资源级覆盖', () => {
  it('覆盖 source 后，计划用新 pin 重算', () => {
    const dir = pack({
      'packhub.yaml': `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/pin-override
  version: 0.0.1
  targets: [dir]
requires:
  packhub: ">=0.0.1 <0.1"
resources:
  - id: fs
    type: mcp
    source: npm:@modelcontextprotocol/server-filesystem@1.0.0
    transport: stdio
overrides:
  - resource: fs
    source: npm:@modelcontextprotocol/server-filesystem@1.2.0
`,
    });
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    expect(plan).toBeDefined();
    const spec = plan!.actions.find((a) => a.op === 'register.mcp');
    const args = spec && 'spec' in spec ? (spec.spec as { args?: string[] }).args : [];
    expect(args?.[1]).toContain('1.2.0');
    rmSync(dir, { recursive: true, force: true });
  });

  it('覆盖 config 时与原有配置深合并', () => {
    const dir = pack({
      'packhub.yaml': `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/cfg-override
  version: 0.0.1
  targets: [dir]
requires:
  packhub: ">=0.0.1 <0.1"
resources:
  - id: fs
    type: mcp
    source: npm:@modelcontextprotocol/server-filesystem@1.0.0
    transport: stdio
    config:
      command: npx
      env:
        A: keep
overrides:
  - resource: fs
    config:
      env:
        B: added
`,
    });
    const { plan } = planFor(loadPack(dir));
    const spec = plan!.actions.find((a) => a.op === 'register.mcp');
    const env = spec && 'spec' in spec ? (spec.spec as { env?: Record<string, string> }).env : {};
    expect(env).toEqual({ A: 'keep', B: 'added' });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('来源形态', () => {
  const manifest = (source: string): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/src
  version: 0.0.1
  targets: [dir]
requires:
  packhub: ">=0.0.1 <0.1"
resources:
  - id: rules
    type: skill
    source: ${source}
`;

  it('https 的 tar.gz 可以当 skill 来源（公司 GitLab/Gitea 的 archive 链接）', () => {
    const dir = pack({
      'packhub.yaml': manifest('https://gitlab.example.com/g/p/-/archive/abc123/p-abc123.tar.gz'),
    });
    // 没有 integrity 会先被 schema/ref 拦；这里补一个假哈希看计划形状
    writeFileSync(
      join(dir, 'packhub.yaml'),
      manifest('https://gitlab.example.com/g/p/-/archive/abc123/p-abc123.tar.gz').replace(
        '    source: https://gitlab.example.com/g/p/-/archive/abc123/p-abc123.tar.gz',
        '    source: https://gitlab.example.com/g/p/-/archive/abc123/p-abc123.tar.gz\n    integrity: sha256-AAAA',
      ),
      'utf8',
    );
    const { plan } = planFor(loadPack(dir));
    const ops = plan?.actions.map((a) => a.op) ?? [];
    expect(ops).toEqual(['fetch', 'unpack', 'link.skill']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('https 的单文件不能当 skill 来源', () => {
    const dir = pack({
      'packhub.yaml': manifest(
        'https://example.com/docs/note.md\n    integrity: sha256-AAAA',
      ),
    });
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    expect(issues.map((i) => i.code)).toContain('source-not-archive');
    rmSync(dir, { recursive: true, force: true });
  });
});
