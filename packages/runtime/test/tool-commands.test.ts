import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPack, planFor } from '../src/index.ts';

function pack(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-tool-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

const manifest = (resource: string): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/tool
  version: 0.0.1
  targets: [dir]
requires:
  packhub: ">=0.0.1 <0.1"
resources:
${resource}
`;

const KIT = `export function scan(dir) { return \`scanned \${dir}\`; }
export function fix(dir) { return \`fixed \${dir}\`; }
`;

describe('工具：目录 + 多条命令', () => {
  it('wrap 与 route 各建一个入口，未列出的文件照样复制', () => {
    const dir = pack({
      'packhub.yaml': manifest(`  - id: kit
    type: tool
    source: ./tools/kit
    commands:
      - name: kit-scan
        exec: index.mjs
        runtime: node
        shim: route
        call: scan
        usage: kit-scan <dir>
      - name: kit-run
        exec: index.mjs
        runtime: node
        usage: kit-run <dir>
`),
      'tools/kit/index.mjs': KIT,
      'tools/kit/support.mjs': 'export const hidden = true;\n',
    });

    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const { plan, issues } = planFor(ctx);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    const ops = plan!.actions.map((a) => a.op);
    expect(ops).toContain('copy');
    expect(ops).toContain('write');
    expect(ops.filter((o) => o === 'link.exec')).toHaveLength(2);

    const execs = plan!.actions.filter((a) => a.op === 'link.exec');
    const route = execs.find((a) => a.op === 'link.exec' && a.to.endsWith('kit-scan'));
    expect(route && route.op === 'link.exec' ? route.module : '').toContain('tools/kit/index.mjs');
    expect(route && route.op === 'link.exec' ? route.args : []).toEqual(['scan']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('装完之后执行体整份在；入口始终有，.cmd 只在 Windows 生成', async () => {
    const dir = pack({
      'packhub.yaml': manifest(`  - id: kit
    type: tool
    source: ./tools/kit
    commands:
      - name: kit-run
        exec: index.mjs
        runtime: node
        usage: kit-run <dir>
`),
      'tools/kit/index.mjs': KIT,
      'tools/kit/support.mjs': 'export const hidden = true;\n',
    });
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    const result = await installPack(ctx, plan!, {});
    expect(result.outcomes.filter((o) => o.status === 'failed')).toEqual([]);

    const root = join(dir, '.packhub');
    expect(readFileSync(join(root, 'cache/tools/kit/support.mjs'), 'utf8')).toContain('hidden');
    expect(readFileSync(join(root, 'bin/kit-run'), 'utf8')).toContain('index.mjs');
    if (process.platform === 'win32') {
      expect(readFileSync(join(root, 'bin/kit-run.cmd'), 'utf8')).toContain('index.mjs');
    } else {
      expect(existsSync(join(root, 'bin/kit-run.cmd'))).toBe(false);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('route 会生成一份通用 shim', () => {
    const dir = pack({
      'packhub.yaml': manifest(`  - id: kit
    type: tool
    source: ./tools/kit
    shim: route
    commands:
      - name: kit-scan
        exec: index.mjs
        runtime: node
        call: scan
        usage: kit-scan <dir>
      - name: kit-fix
        exec: index.mjs
        runtime: node
        call: fix
        usage: kit-fix <dir>
`),
      'tools/kit/index.mjs': KIT,
    });
    const { plan } = planFor(loadPack(dir));
    const shims = plan!.actions.filter((a) => a.op === 'write' && a.to.includes('/shim/route.'));
    expect(shims).toHaveLength(1);
    const content = shims[0] && shims[0].op === 'write' ? shims[0].content : '';
    expect(content).toContain("process.argv.slice(2)");
    rmSync(dir, { recursive: true, force: true });
  });
  it('modify 能改工具执行体（本地来源读得到正文）', async () => {
    const dir = pack({
      'packhub.yaml': `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/tool, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: kit
    type: tool
    source: ./tools/kit
    commands:
      - name: kit-run
        exec: index.mjs
        runtime: node
        usage: kit-run <dir>
modify:
  - resource: kit
    file: index.mjs
    at: "const TIMEOUT = 10;"
    with: "const TIMEOUT = 30;"
`,
      'tools/kit/index.mjs': `const TIMEOUT = 10;\n${KIT}`,
    });
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const { plan } = planFor(ctx);
    await installPack(ctx, plan!, {});
    const installed = readFileSync(join(dir, '.packhub/cache/tools/kit/index.mjs'), 'utf8');
    expect(installed).toContain('const TIMEOUT = 30;');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('工具：平台', () => {
  it('平台不匹配的命令跳过并警告，其余照建', () => {
    const dir = pack({
      'packhub.yaml': manifest(`  - id: kit
    type: tool
    source: ./tools/kit
    commands:
      - name: kit-scan
        exec: index.mjs
        runtime: node
        platforms: [nowhere-x]
        usage: kit-scan <dir>
      - name: kit-run
        exec: index.mjs
        runtime: node
        usage: kit-run <dir>
`),
      'tools/kit/index.mjs': KIT,
    });
    const { plan, issues } = planFor(loadPack(dir));
    expect(issues.map((i) => i.code)).toContain('tool-command-skipped-platform');
    const execs = plan!.actions.filter((a) => a.op === 'link.exec');
    expect(execs.map((a) => (a.op === 'link.exec' ? a.to : ''))).toEqual(['.packhub/bin/kit-run']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('binary 没写 platforms 给警告', () => {
    const dir = pack({
      'packhub.yaml': manifest(`  - id: kit
    type: tool
    source: ./tools/kit
    commands:
      - name: kit-run
        exec: bin/kit
        runtime: binary
        usage: kit-run <dir>
`),
      'tools/kit/bin/kit': 'x',
    });
    const { issues } = planFor(loadPack(dir));
    expect(issues.map((i) => i.code)).toContain('tool-binary-without-platforms');
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'win32')('Windows 上 runtime: shell 直接拒绝', () => {
    const dir = pack({
      'packhub.yaml': manifest(`  - id: kit
    type: tool
    source: ./tools/kit
    commands:
      - name: kit-run
        exec: run.sh
        runtime: shell
        usage: kit-run <dir>
`),
      'tools/kit/run.sh': 'echo hi\n',
    });
    const { issues } = planFor(loadPack(dir));
    expect(issues.map((i) => i.code)).toContain('tool-shell-unsupported');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('工具：契约错误', () => {
  const cases: { name: string; resource: string; code: string }[] = [
    {
      name: 'route 没写 call',
      code: 'tool-route-needs-call',
      resource: `  - id: kit
    type: tool
    source: ./tools/kit
    commands:
      - name: kit-scan
        exec: index.mjs
        runtime: node
        shim: route
        usage: kit-scan <dir>
`,
    },
    {
      name: '目录来源没写 exec',
      code: 'tool-command-invalid',
      resource: `  - id: kit
    type: tool
    source: ./tools/kit
    commands:
      - name: kit-scan
        runtime: node
        usage: kit-scan <dir>
`,
    },
    {
      name: '命令名重复',
      code: 'duplicate-command-name',
      resource: `  - id: kit
    type: tool
    source: ./tools/kit
    commands:
      - name: kit-scan
        exec: index.mjs
        runtime: node
        usage: a
      - name: kit-scan
        exec: index.mjs
        runtime: node
        usage: b
`,
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.code}`, () => {
      const dir = pack({
        'packhub.yaml': manifest(c.resource),
        'tools/kit/index.mjs': KIT,
      });
      const { issues } = planFor(loadPack(dir));
      expect(issues.map((i) => i.code)).toContain(c.code);
      rmSync(dir, { recursive: true, force: true });
    });
  }
});
