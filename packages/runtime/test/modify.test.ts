import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPack, packArchive, planFor, verifyPack } from '../src/index.ts';

function pack(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-modify-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

const manifest = (resources: string, modify = ''): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/modify
  version: 0.0.1
  targets: [dir]
requires:
  packhub: ">=0.0.1 <0.1"
resources:
${resources}
${modify}
`;

const SKILL = `# 技能

## 用法

把配置放在 \`G:\\work\\cfg.md\`。

## 边界

不做别的。
`;

const SKILL_RESOURCE = `  - id: rule
    type: skill
    source: ./skills/rule`;

describe('modify：按资源改文件', () => {
  it('整文件替换：装出来的是我的那份', async () => {
    const dir = pack({
      'packhub.yaml': manifest(
        `  - id: rules
    type: knowledge
    source: ./resources/rules.md`,
        `modify:
  - resource: rules
    with: ./patches/rules.md
`,
      ),
      'resources/rules.md': '# 上游\n',
      'patches/rules.md': '# 我改过的\n',
    });

    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const { plan } = planFor(ctx);
    const result = await installPack(ctx, plan!, {});
    expect(result.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    expect(readFileSync(join(dir, '.packhub/knowledge/rules.md'), 'utf8')).toBe('# 我改过的\n');
    rmSync(dir, { recursive: true, force: true });
  });

  it('行替换：只换那一行，其余不动', async () => {
    const dir = pack({
      'packhub.yaml': manifest(
        SKILL_RESOURCE,
        `modify:
  - resource: rule
    file: SKILL.md
    at: '把配置放在 \`G:\\work\\cfg.md\`。'
    with: '把配置放在 \`config.md\`。'
`,
      ),
      'skills/rule/SKILL.md': SKILL,
    });

    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const { plan } = planFor(ctx);
    await installPack(ctx, plan!, {});
    const installed = readFileSync(join(dir, '.packhub/skills/rule/SKILL.md'), 'utf8');
    expect(installed).toContain('把配置放在 `config.md`。');
    expect(installed).toContain('## 边界');
    expect(installed.split('\n').length).toBe(SKILL.split('\n').length);
    rmSync(dir, { recursive: true, force: true });
  });

  it('段替换：只换那一节', async () => {
    const dir = pack({
      'packhub.yaml': manifest(
        SKILL_RESOURCE,
        `modify:
  - resource: rule
    file: SKILL.md
    at: '## 用法'
    with: |
      ## 用法

      配置改成随包走。
`,
      ),
      'skills/rule/SKILL.md': SKILL,
    });
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    await installPack(ctx, plan!, {});
    const installed = readFileSync(join(dir, '.packhub/skills/rule/SKILL.md'), 'utf8');
    expect(installed).toContain('配置改成随包走。');
    expect(installed).not.toContain('G:\\work\\cfg.md');
    expect(installed).toContain('## 边界');
    rmSync(dir, { recursive: true, force: true });
  });

  it('where: after 是插入，不替换', async () => {
    const dir = pack({
      'packhub.yaml': manifest(
        SKILL_RESOURCE,
        `modify:
  - resource: rule
    file: SKILL.md
    at: '## 边界'
    where: after
    with: |
      ## 追加

      在这一节后面多了这一段。
`,
      ),
      'skills/rule/SKILL.md': SKILL,
    });
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    await installPack(ctx, plan!, {});
    const installed = readFileSync(join(dir, '.packhub/skills/rule/SKILL.md'), 'utf8');
    expect(installed).toContain('不做别的。');
    expect(installed).toContain('在这一节后面多了这一段。');
    rmSync(dir, { recursive: true, force: true });
  });

  it('with: null 删文件', async () => {
    const dir = pack({
      'packhub.yaml': manifest(
        SKILL_RESOURCE,
        `modify:
  - resource: rule
    file: extra.md
    with: null
`,
      ),
      'skills/rule/SKILL.md': SKILL,
      'skills/rule/extra.md': '# 上游带的\n',
    });
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    expect(plan!.actions.some((a) => a.op === 'delete')).toBe(true);
    await installPack(ctx, plan!, {});
    expect(() => readFileSync(join(dir, '.packhub/skills/rule/extra.md'))).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('with 是目录：叠上去，上游没有的文件算新增', async () => {
    const dir = pack({
      'packhub.yaml': manifest(
        SKILL_RESOURCE,
        `modify:
  - resource: rule
    with: ./additions
`,
      ),
      'skills/rule/SKILL.md': SKILL,
      'additions/notes.md': '# 我加的\n',
    });
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    await installPack(ctx, plan!, {});
    expect(readFileSync(join(dir, '.packhub/skills/rule/notes.md'), 'utf8')).toBe('# 我加的\n');
    expect(readFileSync(join(dir, '.packhub/skills/rule/SKILL.md'), 'utf8')).toBe(SKILL);
    rmSync(dir, { recursive: true, force: true });
  });

  it('参数补丁：和原参数深合并', () => {
    const dir = pack({
      'packhub.yaml': manifest(
        `  - id: fs
    type: mcp
    source: npm:@modelcontextprotocol/server-filesystem@1.0.0
    transport: stdio
    config:
      command: npx
      env:
        A: keep`,
        `modify:
  - resource: fs
    with:
      env:
        B: added
`,
      ),
    });
    const { plan } = planFor(loadPack(dir));
    const spec = plan!.actions.find((a) => a.op === 'register.mcp');
    const env = spec && 'spec' in spec ? (spec.spec as { env?: Record<string, string> }).env : {};
    expect(env).toEqual({ A: 'keep', B: 'added' });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('modify：改不了就报错', () => {
  const cases: { name: string; manifest: string; files: Record<string, string>; code: string; resources?: string }[] = [
    {
      name: '锚点找不到',
      code: 'modify-anchor-missing',
      manifest: `modify:
  - resource: rule
    file: SKILL.md
    at: '这一行不存在'
    with: 'x'
`,
      files: { 'skills/rule/SKILL.md': SKILL },
    },
    {
      name: '锚点命中多处',
      code: 'modify-anchor-ambiguous',
      manifest: `modify:
  - resource: rule
    file: SKILL.md
    at: '重复的一行'
    with: 'x'
`,
      files: { 'skills/rule/SKILL.md': '# a\n重复的一行\n# b\n重复的一行\n' },
    },
    {
      name: '要改的文件上游没有',
      code: 'modify-file-missing',
      manifest: `modify:
  - resource: rule
    file: nope.md
    at: '# a'
    with: 'x'
`,
      files: { 'skills/rule/SKILL.md': SKILL },
    },
    {
      name: '补丁指到包外',
      code: 'modify-outside-pack',
      manifest: `modify:
  - resource: rule
    with: ../outside.md
`,
      files: { 'skills/rule/SKILL.md': SKILL },
    },
    {
      name: '两条补丁改同一个文件',
      code: 'modify-conflict',
      manifest: `modify:
  - resource: rule
    file: SKILL.md
    with: ./a.md
  - resource: rule
    file: SKILL.md
    with: ./b.md
`,
      files: { 'skills/rule/SKILL.md': SKILL, 'a.md': 'A\n', 'b.md': 'B\n' },
    },
    {
      name: '不知道改哪个文件',
      code: 'modify-needs-file',
      manifest: `modify:
  - resource: rule
    with: ./a.md
`,
      files: { 'skills/rule/SKILL.md': SKILL, 'a.md': 'A\n' },
    },
    {
      name: '参数补丁带了 file',
      code: 'modify-invalid',
      manifest: `modify:
  - resource: fs
    file: x
    with:
      a: 1
`,
      files: {},
    },
    {
      name: '参数补丁打到 skill 上',
      code: 'modify-invalid',
      manifest: `modify:
  - resource: rule
    with:
      env:
        A: 1
`,
      files: { 'skills/rule/SKILL.md': SKILL },
    },
    {
      name: '文件补丁打到 mcp 上',
      code: 'modify-not-file',
      manifest: `modify:
  - resource: fs
    with: ./a.md
`,
      files: { 'a.md': 'A\n' },
      resources: `  - id: fs
    type: mcp
    source: npm:@modelcontextprotocol/server-filesystem@1.0.0
    transport: stdio`,
    },
    {
      name: '指向不存在的资源',
      code: 'modify-unknown-resource',
      manifest: `modify:
  - resource: nope
    with: ./a.md
`,
      files: { 'skills/rule/SKILL.md': SKILL, 'a.md': 'A\n' },
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.code}`, () => {
      const resources =
        c.name === '参数补丁带了 file'
          ? `  - id: fs
    type: mcp
    source: npm:@modelcontextprotocol/server-filesystem@1.0.0
    transport: stdio`
          : (c.resources ?? SKILL_RESOURCE);
      const dir = pack({ 'packhub.yaml': manifest(resources, c.manifest), ...c.files });
      const { issues } = planFor(loadPack(dir));
      expect(issues.map((i) => i.code)).toContain(c.code);
      rmSync(dir, { recursive: true, force: true });
    });
  }

  it('改完和原文一样 → 只警告，不出动作', () => {
    const dir = pack({
      'packhub.yaml': manifest(
        SKILL_RESOURCE,
        `modify:
  - resource: rule
    file: SKILL.md
    at: '## 边界'
    with: |
      ## 边界

      不做别的。
`,
      ),
      'skills/rule/SKILL.md': SKILL,
    });
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeDefined();
    expect(issues.map((i) => i.code)).toContain('modify-noop');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('重名标题：nth 指定第几个', () => {
  const DOC = `# 技能

## A

第一块。

## B

中间。

## A

第二块。
`;

  it('nth: 2 只改第二个', async () => {
    const dir = pack({
      'packhub.yaml': manifest(
        SKILL_RESOURCE,
        `modify:
  - resource: rule
    file: SKILL.md
    at: '## A'
    nth: 2
    with: |
      ## A

      第二块改过。
`,
      ),
      'skills/rule/SKILL.md': DOC,
    });
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const { plan } = planFor(ctx);
    await installPack(ctx, plan!, {});
    const installed = readFileSync(join(dir, '.packhub/skills/rule/SKILL.md'), 'utf8');
    expect(installed).toContain('第一块。');
    expect(installed).toContain('第二块改过。');
    expect(installed).not.toContain('第二块。');
    rmSync(dir, { recursive: true, force: true });
  });

  it('不给 nth 就报错，并把候选和写法列出来', () => {
    const dir = pack({
      'packhub.yaml': manifest(
        SKILL_RESOURCE,
        `modify:
  - resource: rule
    file: SKILL.md
    at: '## A'
    with: 'x'
`,
      ),
      'skills/rule/SKILL.md': DOC,
    });
    const { issues } = planFor(loadPack(dir));
    const issue = issues.find((i) => i.code === 'modify-anchor-ambiguous');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('命中 2 处');
    expect(issue!.message).toContain('第 3 行');
    expect(issue!.message).toContain('第 11 行');
    expect(issue!.message).toContain("at: '## A', nth: 1");
    rmSync(dir, { recursive: true, force: true });
  });

  it('nth 超出范围 → modify-nth-out-of-range', () => {
    const dir = pack({
      'packhub.yaml': manifest(
        SKILL_RESOURCE,
        `modify:
  - resource: rule
    file: SKILL.md
    at: '## A'
    nth: 3
    with: 'x'
`,
      ),
      'skills/rule/SKILL.md': DOC,
    });
    const { issues } = planFor(loadPack(dir));
    expect(issues.map((i) => i.code)).toContain('modify-nth-out-of-range');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('远程资源', () => {  it('远程资源按锚点改 → modify-remote-unsupported', () => {
    const dir = pack({
      'packhub.yaml': manifest(
        `  - id: rule
    type: skill
    source: github:owner/repo/skills/rule@abc1234
    integrity: sha256-AAAA`,
        `modify:
  - resource: rule
    file: SKILL.md
    at: '# a'
    with: 'x'
`,
      ),
    });
    const { issues } = planFor(loadPack(dir));
    expect(issues.map((i) => i.code)).toContain('modify-remote-unsupported');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('打包', () => {
  it('reference 模式也拒：context 指向包内文件时同样不在归档里', async () => {
    const dir = pack({
      'packhub.yaml': `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/ctx, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
context: ./CONTEXT.md
resources:
  - id: rules
    type: knowledge
    source: npm:something@1.0.0
`,
      'CONTEXT.md': '# 开场\n',
    });
    await expect(packArchive(dir, { vendored: false })).rejects.toThrow(/reference 模式打出来装不上/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reference 模式打不出去：补丁文件不在归档里', async () => {
    const dir = pack({
      'packhub.yaml': manifest(
        `  - id: rules
    type: knowledge
    source: npm:something@1.0.0`,
        `modify:
  - resource: rules
    with: ./patches/rules.md
`,
      ),
      'patches/rules.md': '# 我改过的\n',
    });
    await expect(packArchive(dir, { vendored: false })).rejects.toThrow(/reference 模式打出来装不上/);
    rmSync(dir, { recursive: true, force: true });
  });
});
