import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packArchive } from '@packhub/runtime';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'packages/launcher/src/bin.ts');
const FIXTURE = join(ROOT, 'test/fixtures/packs/team-conventions');

/** 隔离的 PAL 数据目录：不读也不写用户自己的实例记录 / 审计 / 信任列表。 */
const HOME = mkdtempSync(join(tmpdir(), 'pal-dir-home-'));
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

interface PalResult {
  status: number | null;
  out: string;
}

/** 每个用例自己一份 HOME / INSTANCES，互不串；不读用户的 registry 配置。 */
function pal(args: string[], env: Record<string, string> = {}): PalResult {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  delete merged.PACKHUB_INDEX;
  const res = spawnSync(process.execPath, ['--experimental-strip-types', BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...merged,
      PACKHUB_HOME: join(HOME, 'home'),
      PACKHUB_INSTANCES: join(HOME, 'instances'),
      ...env,
    },
  });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 造一个本地 registry：索引 + 每个版本一个 .phub（安装/更新的消费来源）。 */
async function makeRegistry(
  base: string,
  versions: { version: string; body: string }[],
): Promise<string> {
  const reg = join(base, 'reg');
  mkdirSync(join(reg, 'packs/demo/upd'), { recursive: true });
  for (const { version, body } of versions) {
    const src = join(base, `src-${version}`);
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/upd, version: ${version} }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`,
      'utf8',
    );
    writeFileSync(join(src, 'rules.md'), body, 'utf8');
    await packArchive(src, { vendored: true, out: join(reg, `packs/demo/upd/${version}.phub`) });
  }
  writeFileSync(
    join(reg, 'index.json'),
    JSON.stringify({
      apiVersion: 'packhub.dev/index/v0',
      packs: [
        {
          name: 'demo/upd',
          latest: versions[versions.length - 1]!.version,
          versions: versions.map((v) => v.version),
        },
      ],
    }),
    'utf8',
  );
  return join(reg, 'index.json');
}

describe('pal 目录对象：install', () => {
  it('--host 必填；dir 不是宿主（那是内部形态）', () => {
    const base = tmp('pal-dir-args-');
    const pack = join(base, 'pack');
    cpSync(FIXTURE, pack, { recursive: true });

    const missing = pal(['install', pack, '--project', join(base, 'p1')]);
    expect(missing.status).toBe(2);
    expect(missing.out).toContain('install 需要 --host');

    const dirValue = pal(['install', pack, '--project', join(base, 'p2'), '--host', 'dir']);
    expect(dirValue.status).toBe(2);
    expect(dirValue.out).toContain('未知宿主：dir');
    rmSync(base, { recursive: true, force: true });
  });

  it('--dry-run 只算计划，不落任何文件', () => {
    const base = tmp('pal-dir-dry-');
    const pack = join(base, 'pack');
    const project = join(base, 'project');
    cpSync(FIXTURE, pack, { recursive: true });

    const dry = pal(['install', pack, '--project', project, '--host', 'dsh', '--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.out).toContain('（dry-run：没有落盘）');
    expect(dry.out).toContain('planHash');
    expect(existsSync(join(project, '.packhub'))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  it('本地目录真装：文件与 state 落盘，装完自动复核通过', () => {
    const base = tmp('pal-dir-install-');
    const pack = join(base, 'pack');
    const project = join(base, 'project');
    cpSync(FIXTURE, pack, { recursive: true });

    const installed = pal(['install', pack, '--project', project, '--host', 'dsh']);
    expect(installed.status).toBe(0);
    expect(installed.out).toContain('harness=dsh');
    expect(installed.out).toContain('校验 lvlc233/team-conventions@0.0.2：通过');
    // 宿主形态：指令接进 AGENTS.md，资源仍在 .packhub 下
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(project, '.packhub/knowledge/style-guide.md'))).toBe(true);
    expect(existsSync(join(project, '.packhub/state.json'))).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('从 registry 名称安装：取到包、按宿主装、锁与签名走消费流', async () => {
    const base = tmp('pal-dir-registry-');
    const index = await makeRegistry(base, [{ version: '0.1.0', body: '# v1\n' }]);
    const project = join(base, 'project');

    const installed = pal(['install', 'demo/upd@0.1.0', '--project', project, '--host', 'dsh', '--index', index]);
    expect(installed.status).toBe(0);
    expect(installed.out).toContain('demo/upd@0.1.0');
    expect(installed.out).toContain('校验 demo/upd@0.1.0：通过');
    expect(readFileSync(join(project, '.packhub/knowledge/rules.md'), 'utf8')).toBe('# v1\n');
    rmSync(base, { recursive: true, force: true });
  });
});

describe('pal 目录对象：verify / uninstall', () => {
  it('verify 打漂移+检查；删掉已装文件后退出 1；uninstall 摘干净', () => {
    const base = tmp('pal-dir-verify-');
    const pack = join(base, 'pack');
    const project = join(base, 'project');
    cpSync(FIXTURE, pack, { recursive: true });
    expect(pal(['install', pack, '--project', project, '--host', 'dsh']).status).toBe(0);

    const ok = pal(['verify', '--project', project]);
    expect(ok.status).toBe(0);
    expect(ok.out).toContain('漂移：已装记录 vs 磁盘');
    expect(ok.out).toContain('✓ 1 个包全部在位');
    expect(ok.out).toContain('检查：清单 verify 项 + 从计划派生的项');
    expect(ok.out).toContain('1 个包：0 项失败 / 0 项跳过');

    rmSync(join(project, '.packhub/knowledge/style-guide.md'), { force: true });
    const broken = pal(['verify', '--project', project]);
    expect(broken.status).toBe(1);
    expect(broken.out).toContain('文件不见了：.packhub/knowledge/style-guide.md');

    const removed = pal(['uninstall', '--project', project]);
    expect(removed.status).toBe(0);
    expect(removed.out).toContain('移除');
    expect(existsSync(join(project, '.packhub/knowledge/style-guide.md'))).toBe(false);
    expect(existsSync(join(project, '.packhub/state.json'))).toBe(false);

    // 再卸一次：没有安装记录是前置条件错
    const again = pal(['uninstall', '--project', project]);
    expect(again.status).toBe(2);
    expect(again.out).toContain('这个目录没有安装记录');
    rmSync(base, { recursive: true, force: true });
  });

  it('对没有安装记录的目录：verify / uninstall 都是前置条件错', () => {
    const empty = tmp('pal-dir-empty-');
    const verified = pal(['verify', '--project', empty]);
    expect(verified.status).toBe(2);
    expect(verified.out).toContain('这个目录没有安装记录');

    const removed = pal(['uninstall', '--project', empty]);
    expect(removed.status).toBe(2);
    expect(removed.out).toContain('这个目录没有安装记录');
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('pal 目录对象：update / rollback', () => {
  it('先装旧版，再用 pal update --project 更到新版；rollback 回到旧版', async () => {
    const base = tmp('pal-dir-update-');
    const index = await makeRegistry(base, [
      { version: '0.1.0', body: '# v1\n' },
      { version: '0.2.0', body: '# v2\n' },
    ]);
    const project = join(base, 'project');

    expect(pal(['install', 'demo/upd@0.1.0', '--project', project, '--host', 'dsh', '--index', index]).status).toBe(0);
    expect(readFileSync(join(project, '.packhub/knowledge/rules.md'), 'utf8')).toBe('# v1\n');

    const updated = pal(['update', '--project', project, '--index', index]);
    expect(updated.status).toBe(0);
    expect(updated.out).toContain('demo/upd@0.1.0 → demo/upd@0.2.0');
    expect(readFileSync(join(project, '.packhub/knowledge/rules.md'), 'utf8')).toBe('# v2\n');

    const rolled = pal(['rollback', '--project', project]);
    expect(rolled.status).toBe(0);
    expect(rolled.out).toContain('回退');
    expect(rolled.out).toContain('↩ .packhub/knowledge/rules.md');
    expect(readFileSync(join(project, '.packhub/knowledge/rules.md'), 'utf8')).toBe('# v1\n');
    rmSync(base, { recursive: true, force: true });
  });

  it('update 只认 --project / --home：旧的 --dir 会被当成没有 target', () => {
    const base = tmp('pal-dir-update-nodir-');
    const pack = join(base, 'pack');
    const project = join(base, 'project');
    cpSync(FIXTURE, pack, { recursive: true });
    expect(pal(['install', pack, '--project', project, '--host', 'dsh']).status).toBe(0);

    const res = pal(['update', '--dir', project]);
    expect(res.status).toBe(2);
    expect(res.out).toContain('要指定 target 才能继续');
    expect(res.out).toContain('--project');
    expect(res.out).toContain('--home');
    rmSync(base, { recursive: true, force: true });
  });

  it('目录 update 没有索引：前置条件错，指出要 --index', () => {
    const base = tmp('pal-dir-update-noidx-');
    const pack = join(base, 'pack');
    const project = join(base, 'project');
    cpSync(FIXTURE, pack, { recursive: true });
    expect(pal(['install', pack, '--project', project, '--host', 'dsh']).status).toBe(0);

    const res = pal(['update', '--project', project]);
    expect(res.status).toBe(2);
    expect(res.out).toContain('按目录更新需要一个 registry 索引');
    rmSync(base, { recursive: true, force: true });
  });
});
