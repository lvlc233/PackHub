import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import {
  fetchPack,
  installPack,
  loadPack,
  packArchive,
  planFor,
  unpackArchive,
} from '../src/index.ts';

/** 造一个带单层前缀的 tar.gz：解包 strip: 1 之后内容直接落在目标目录里。 */
async function makeTarGz(out: string, prefix: string, files: Record<string, string>): Promise<string> {
  const src = mkdtempSync(join(tmpdir(), 'packhub-archive-src-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(src, prefix, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  mkdirSync(join(out, '..'), { recursive: true });
  await tar.c({ gzip: true, file: out, cwd: src, portable: true }, [prefix]);
  rmSync(src, { recursive: true, force: true });
  return out;
}

function integrityOf(file: string): string {
  return `sha256-${createHash('sha256').update(readFileSync(file)).digest('base64')}`;
}

let server: Server;
let base = '';
let fixture = '';
let skillTar = '';
let kitTar = '';

const SKILL_MD = `---\nname: hello\ndescription: demo skill\n---\n\n# hello\n`;
const TOOL_JS = `export default async function main() {\n  return 'kit';\n}\n`;

beforeAll(async () => {
  fixture = mkdtempSync(join(tmpdir(), 'packhub-remote-fixture-'));
  const archives = join(fixture, 'archives');
  skillTar = await makeTarGz(join(archives, 'hello.tar.gz'), 'myskill', { 'SKILL.md': SKILL_MD });
  kitTar = await makeTarGz(join(archives, 'kit.tar.gz'), 'mytool', { 'index.mjs': TOOL_JS });

  const files = new Map([
    ['/hello.tar.gz', skillTar],
    ['/kit.tar.gz', kitTar],
  ]);
  server = createServer((req, res) => {
    const file = files.get((req.url ?? '').split('?')[0] ?? '');
    if (!file || !existsSync(file)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', 'application/octet-stream');
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

/** 造 Pack 目录：远程 skill + 远程 tool2，全部自包含在 localhost fixture 里。 */
function makePack(): string {
  const dir = join(fixture, 'pack');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/remote, version: 0.1.0, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: hello
    type: skill
    source: ${base}/hello.tar.gz
    integrity: ${integrityOf(skillTar)}
  - id: kit
    type: tool2
    source: ${base}/kit.tar.gz
    integrity: ${integrityOf(kitTar)}
    commands:
      - name: kit-run
        exec: index.mjs
        runtime: node
        usage: kit-run <dir>
`,
    'utf8',
  );
  return dir;
}

function assertInstalled(project: string): void {
  expect(existsSync(join(project, '.packhub/skills/hello/SKILL.md'))).toBe(true);
  expect(existsSync(join(project, '.packhub/bin/kit-run'))).toBe(true);
  // 工具执行体来自解包后的安装根缓存，不是 Pack 目录
  expect(existsSync(join(project, '.packhub/cache/tools/kit/index.mjs'))).toBe(true);
  expect(existsSync(join(project, '.packhub/cache/hello.tar.gz'))).toBe(true);
}

describe('远程 skill / tool2：from 基准统一为安装根', () => {
  it('计划里 unpack / 远程 link.skill 的 from 标成 root', () => {
    const dir = makePack();
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const plan = planFor(ctx).plan!;
    const unpack = plan.actions.find((a) => a.op === 'unpack');
    expect(unpack && unpack.op === 'unpack' ? unpack.fromBase : undefined).toBe('root');
    const skill = plan.actions.find((a) => a.op === 'link.skill');
    expect(skill && skill.op === 'link.skill' ? skill.fromBase : undefined).toBe('root');
    // 本地 skill 才是 pack 基准
    mkdirSync(join(dir, 'local-skill'), { recursive: true });
    writeFileSync(join(dir, 'local-skill/SKILL.md'), SKILL_MD, 'utf8');
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `${readFileSync(join(dir, 'packhub.yaml'), 'utf8')}  - id: local
    type: skill
    source: ./local-skill
`,
      'utf8',
    );
    const localPlan = planFor(loadPack(dir)).plan!;
    const localSkill = localPlan.actions.find(
      (a) => a.op === 'link.skill' && a.resource === 'local',
    );
    expect(localSkill && localSkill.op === 'link.skill' ? localSkill.fromBase : undefined).toBe('pack');
    rmSync(dir, { recursive: true, force: true });
  });

  it('从 registry 取包后安装：skill 与 tool2 都真的落盘', async () => {
    const packDir = makePack();
    const registry = join(fixture, 'registry');
    const archive = join(registry, 'packs/demo/remote/0.1.0.phub');
    await packArchive(packDir, { out: archive });
    writeFileSync(
      join(registry, 'index.json'),
      JSON.stringify(
        {
          apiVersion: 'packhub.dev/index/v0',
          packs: [{ name: 'demo/remote', latest: '0.1.0', versions: ['0.1.0'] }],
        },
        null,
        2,
      ),
      'utf8',
    );

    const project = mkdtempSync(join(tmpdir(), 'packhub-remote-reg-'));
    const dest = join(project, '.packhub/packs/demo/remote');
    await fetchPack({ name: 'demo/remote', index: join(registry, 'index.json'), dest });
    const ctx = loadPack(dest);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const plan = planFor(ctx).plan!;
    // 关键：Pack 目录与安装根不是同一个目录
    expect(dest).not.toBe(project);
    const res = await installPack(ctx, plan, { root: project, packRoot: dest });
    expect(res.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    expect(res.outcomes.filter((o) => o.status === 'skipped')).toEqual([]);
    assertInstalled(project);
    rmSync(project, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  });

  it('从 .phub 归档安装：同一份字节换一种入口也能装上', async () => {
    const packDir = makePack();
    const phub = join(fixture, 'demo-remote.phub');
    await packArchive(packDir, { out: phub });

    const project = mkdtempSync(join(tmpdir(), 'packhub-remote-phub-'));
    const dest = join(project, '.packhub/packs/from-archive');
    await unpackArchive(phub, dest);
    const ctx = loadPack(dest);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const plan = planFor(ctx).plan!;
    const res = await installPack(ctx, plan, { root: project, packRoot: dest });
    expect(res.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    assertInstalled(project);
    rmSync(project, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  });
});
