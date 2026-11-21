import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLock, loadPack } from '@packhub/kernel';
import { packArchive } from '@packhub/runtime';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'apps/local/src/bin.ts');

function run(args: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
  const res = spawnSync(process.execPath, ['--experimental-strip-types', BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PACKHUB_HOME: join(tmpdir(), 'packhub-cli-home'), ...env },
  });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

describe('cli 端到端：pack / publish', () => {
  const makePack = (dir: string, name = 'me/e2e', version = '0.1.0'): void => {
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: ${name}
  version: ${version}
  title: E2E
  visibility: public
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
verify:
  - type: file-exists
    path: "\${target.knowledgeDir}/rules.md"
`,
      'utf8',
    );
    writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
  };

  it('pack 输出结构化结果，publish 写版本目录与索引', () => {
    const packDir = mkdtempSync(join(tmpdir(), 'packhub-cli-pack-'));
    makePack(packDir);
    const packed = run(['pack', packDir, '--json']);
    expect(packed.status).toBe(0);
    const packedBody = JSON.parse(packed.out.slice(packed.out.indexOf('{'), packed.out.lastIndexOf('}') + 1)) as {
      file: string;
      bytes: number;
      entries: string[];
      mode: string;
    };
    expect(existsSync(packedBody.file)).toBe(true);
    expect(packedBody.entries).toContain('packhub.yaml');
    // 默认自包含：本地来源随包走，不用 --vendored
    expect(packedBody.entries).toContain('rules.md');
    expect(packedBody.mode).toBe('vendored');

    const registry = mkdtempSync(join(tmpdir(), 'packhub-cli-reg-'));
    const published = run(['publish', packDir, '--registry', registry, '--json']);
    expect(published.status).toBe(0);
    const body = JSON.parse(published.out.slice(published.out.indexOf('{'), published.out.lastIndexOf('}') + 1)) as {
      ok: boolean;
      name: string;
      version: string;
      indexed: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.indexed).toBe(true);
    expect(existsSync(join(registry, 'packs/me/e2e/0.1.0/packhub.yaml'))).toBe(true);
    expect(existsSync(join(registry, 'index.json'))).toBe(true);

    rmSync(packDir, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  });

  it('索引门禁失败时撤回刚写入的版本目录', () => {
    const packDir = mkdtempSync(join(tmpdir(), 'packhub-cli-pubfail-'));
    makePack(packDir);
    const registry = mkdtempSync(join(tmpdir(), 'packhub-cli-regbad-'));
    // 放一个坏包让 writeIndex 必然报错；发布新包时索引门禁会失败
    const bad = join(registry, 'packs/bad/pkg/1.0.0');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'packhub.yaml'), 'apiVersion: packhub.dev/v0\nkind: Pack\n', 'utf8');

    const published = run(['publish', packDir, '--registry', registry]);
    expect(published.status).toBe(1);
    expect(published.out).toContain('已撤回');
    expect(existsSync(join(registry, 'packs/me/e2e/0.1.0'))).toBe(false);
    expect(existsSync(join(registry, 'packs/me/e2e/0.1.0.phub'))).toBe(false);

    rmSync(packDir, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  });

});

describe('cli 端到端：install → verify → uninstall', () => {
  it('没有索引时明确报错；配了 PACKHUB_INDEX 就能装、能验、能卸', () => {
    const project = mkdtempSync(join(tmpdir(), 'packhub-cli-'));
    mkdirSync(project, { recursive: true });

    const noIndex = run(['install', 'lvlc233/team-conventions', '--dir', project]);
    expect(noIndex.status).toBe(2);
    expect(noIndex.out).toContain('需要一个索引');

    const index = join(ROOT, 'registry/index.json');
    const added = run(['install', 'lvlc233/team-conventions', '--dir', project], { PACKHUB_INDEX: index });
    expect(added.status).toBe(0);
    expect(added.out).toContain('装上');
    expect(existsSync(join(project, '.packhub/knowledge/style-guide.md'))).toBe(true);

    const jsonProject = mkdtempSync(join(tmpdir(), 'packhub-cli-addjson-'));
    const addedJson = run(
      ['install', 'lvlc233/team-conventions', '--dir', jsonProject, '--json'],
      { PACKHUB_INDEX: index },
    );
    expect(addedJson.status).toBe(0);
    const addedBody = JSON.parse(
      addedJson.out.slice(addedJson.out.indexOf('{'), addedJson.out.lastIndexOf('}') + 1),
    ) as { installed: boolean; label: string; verification?: unknown[] };
    expect(addedBody.installed).toBe(true);
    expect(addedBody.label).toContain('lvlc233/team-conventions');
    expect(addedBody.verification?.length).toBe(1);
    rmSync(jsonProject, { recursive: true, force: true });

    const verified = run(['verify', project]);
    expect(verified.status).toBe(0);
    expect(verified.out).toContain('1 个包');
    expect(verified.out).toContain('0 项失败');

    const verifiedJson = run(['verify', project, '--json']);
    expect(verifiedJson.status).toBe(0);
    const parsed = JSON.parse(
      verifiedJson.out.slice(verifiedJson.out.indexOf('{'), verifiedJson.out.lastIndexOf('}') + 1),
    ) as { checks: { installed: { pack: string }[] } };
    expect(parsed.checks.installed[0]?.pack).toContain('lvlc233/team-conventions');

    expect(existsSync(join(project, '.packhub/packs/lvlc233/team-conventions/packhub.yaml'))).toBe(true);
    const removed = run(['uninstall', project]);
    expect(removed.status).toBe(0);
    expect(existsSync(join(project, '.packhub/knowledge/style-guide.md'))).toBe(false);
    expect(existsSync(join(project, '.packhub/packs/lvlc233/team-conventions'))).toBe(false);

    rmSync(project, { recursive: true, force: true });
  });

  it('配置了信任列表后无签名包默认被拒，--allow-unsigned 才能装', () => {
    const home = mkdtempSync(join(tmpdir(), 'packhub-cli-trust-'));
    writeFileSync(
      join(home, 'trust.json'),
      JSON.stringify({ apiVersion: 'packhub.dev/trust/v0', keys: [{ key: 'abc', addedAt: new Date().toISOString() }] }),
      'utf8',
    );
    const project = mkdtempSync(join(tmpdir(), 'packhub-cli-trust-proj-'));
    const denied = run(['install', 'lvlc233/team-conventions', '--dir', project], {
      PACKHUB_INDEX: join(ROOT, 'registry/index.json'),
      PACKHUB_HOME: home,
    });
    expect(denied.status).toBe(2);
    expect(denied.out).toMatch(/信任列表|签名/);

    const allowed = run(['install', 'lvlc233/team-conventions', '--dir', project, '--allow-unsigned'], {
      PACKHUB_INDEX: join(ROOT, 'registry/index.json'),
      PACKHUB_HOME: home,
    });
    expect(allowed.status).toBe(0);
    expect(existsSync(join(project, '.packhub/knowledge/style-guide.md'))).toBe(true);
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('trust require on/off 切强制签名，不用手改 trust.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'packhub-cli-trustreq-'));
    const project = mkdtempSync(join(tmpdir(), 'packhub-cli-trustreq-proj-'));
    const env = { PACKHUB_INDEX: join(ROOT, 'registry/index.json'), PACKHUB_HOME: home };

    const on = run(['trust', 'require', 'on'], env);
    expect(on.status).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'trust.json'), 'utf8')).requireSignature).toBe(true);

    const denied = run(['install', 'lvlc233/team-conventions', '--dir', project], env);
    expect(denied.status).toBe(2);
    expect(denied.out).toMatch(/签名/);

    const off = run(['trust', 'require', 'off'], env);
    expect(off.status).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'trust.json'), 'utf8')).requireSignature).toBe(false);

    const allowed = run(['install', 'lvlc233/team-conventions', '--dir', project], env);
    expect(allowed.status).toBe(0);
    expect(existsSync(join(project, '.packhub/knowledge/style-guide.md'))).toBe(true);

    const bad = run(['trust', 'require', 'maybe'], env);
    expect(bad.status).toBe(2);
    expect(bad.out).toContain('只认 on 或 off');

    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('search 能读索引并按关键词过滤', () => {
    const index = join(ROOT, 'registry/index.json');
    const res = run(['search', 'conventions', '--index', index]);
    expect(res.status).toBe(0);
    expect(res.out).toContain('lvlc233/team-conventions');
  });

  it('install --dry-run 不往项目里写任何东西', () => {
    const project = mkdtempSync(join(tmpdir(), 'packhub-cli-dry-'));
    const res = run(['install', 'lvlc233/team-conventions', '--dir', project, '--dry-run'], {
      PACKHUB_INDEX: join(ROOT, 'registry/index.json'),
    });
    expect(res.status).toBe(0);
    expect(res.out).toContain('planHash');
    expect(existsSync(join(project, '.packhub'))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it('target 只由命令行选：清单不声明 target', () => {
    const pack = mkdtempSync(join(tmpdir(), 'packhub-cli-target-'));
    writeFileSync(
      join(pack, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/target, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`,
      'utf8',
    );
    writeFileSync(join(pack, 'rules.md'), '# rules\n', 'utf8');
    // 清单里没有 target 字段：落点按命令行 --target 现算，换 target 就是换一份计划
    const planned = run(['plan', pack, '--target', 'claude-code']);
    expect(planned.status).toBe(0);
    expect(planned.out).toContain('target=claude-code');
    rmSync(pack, { recursive: true, force: true });
  });

  it('plan 打接线：能力令牌 → provider、needs 边、槽位解析（--json 里是 wiring）', () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-cli-wiring-'));
    const pack = join(base, 'pack');
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, 'skill.md'), '# skill\n', 'utf8');
    writeFileSync(
      join(pack, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/wiring, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
slots:
  review:
    contract: [tool/lint@1]
    default: linter-a
resources:
  - id: linter-a
    type: mcp
    transport: stdio
    slot: review
    source: npm:linter-a@1.0.0
    provides: [tool/lint@1]
  - id: linter-b
    type: mcp
    transport: stdio
    slot: review
    source: npm:linter-b@1.0.0
    provides: [tool/lint@1]
  - id: reviewer
    type: skill
    source: ./skill.md
    needs: [tool/lint@1]
    provides: [skill/review@1]
`,
      'utf8',
    );

    const planned = run(['plan', pack, '--json']);
    expect(planned.status).toBe(0);
    const body = JSON.parse(planned.out.slice(planned.out.indexOf('{'), planned.out.lastIndexOf('}') + 1)) as {
      planHash: string;
      wiring: {
        capabilities: Record<string, string[]>;
        edges: { provider: string; consumer: string; capability: string }[];
        slots: {
          name: string;
          contract: string[];
          default?: string;
          bound?: string;
          effective?: string;
          candidates: string[];
          excluded: { resource: string; reason: string }[];
        }[];
      };
    };
    expect(body.planHash).toBeTruthy();
    // 能力：令牌是键，provider 按清单顺序；落选的槽位候选不进图（它这次不装）
    expect(body.wiring.capabilities).toEqual({
      'skill/review@1': ['reviewer'],
      'tool/lint@1': ['linter-a'],
    });
    // 边由 needs 派生：provider 先装
    expect(body.wiring.edges).toEqual([
      { provider: 'linter-a', consumer: 'reviewer', capability: 'tool/lint@1' },
    ]);
    // 槽位：default 生效，未选中的候选带原因
    expect(body.wiring.slots).toEqual([
      {
        name: 'review',
        contract: ['tool/lint@1'],
        default: 'linter-a',
        effective: 'linter-a',
        candidates: ['linter-a', 'linter-b'],
        excluded: [{ resource: 'linter-b', reason: 'unbound-slot' }],
      },
    ]);

    // 文本模式同一份接线；顺序是「provider 先装」的证据
    const printed = run(['plan', pack]);
    expect(printed.status).toBe(0);
    expect(printed.out).toContain('接线：');
    expect(printed.out).toContain('tool/lint@1 → linter-a');
    expect(printed.out).toContain('linter-a → reviewer（tool/lint@1）');
    expect(printed.out).toContain('effective linter-a（default）');

    rmSync(base, { recursive: true, force: true });
  });

  it('退出码：缺清单/坏参数是 2，校验失败是 1，提示可执行', () => {
    const missing = run(['plan', join(tmpdir(), 'packhub-no-such-pack')]);
    expect(missing.status).toBe(2);
    expect(missing.out).toContain('manifest-missing');
    expect(missing.out).toContain('packhub init');

    const pack = mkdtempSync(join(tmpdir(), 'packhub-cli-exit-'));
    writeFileSync(
      join(pack, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/exit, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
verify:
  - type: file-exists
    path: "\${target.knowledgeDir}/rules.md"
`,
      'utf8',
    );
    writeFileSync(join(pack, 'rules.md'), '# rules\n', 'utf8');
    const failed = run(['verify', pack]);
    expect(failed.status).toBe(1);
    expect(failed.out).toContain('fail');
    rmSync(pack, { recursive: true, force: true });
  });


  it('未知参数退出 2；init 的私有包发布前被拦且不留半套', () => {
    const badFlag = run(['plan', '.', '--nonsense']);
    expect(badFlag.status).toBe(2);
    expect(badFlag.out).toContain('未知参数');

    // 位置参数不接受 --dir：以前会被静默忽略，命令跑在 cwd 上
    const positionalAsFlag = run(['uninstall', '--dir', '.']);
    expect(positionalAsFlag.status).toBe(2);
    expect(positionalAsFlag.out).toContain('未知参数 --dir');

    const base = mkdtempSync(join(tmpdir(), 'packhub-cli-init-'));
    const pack = join(base, 'pack');
    const reg = join(base, 'reg');
    const init = run(['init', pack, '--name', 'demo/init-flow']);
    expect(init.status).toBe(0);
    expect(readFileSync(join(pack, 'packhub.yaml'), 'utf8')).toContain('visibility: private');

    const published = run(['publish', pack, '--registry', reg]);
    expect(published.status).toBe(1);
    expect(published.out).toMatch(/visibility=private/);
    expect(existsSync(join(reg, 'packs', 'demo', 'init-flow'))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  it('init 只收 owner/name：裸名字当场拒，产出的清单能过自己的 schema', () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-cli-init-name-'));

    const bare = join(base, 'bare');
    const rejected = run(['init', bare, '--name', 'demo']);
    expect(rejected.status).toBe(2);
    expect(rejected.out).toContain('owner/name');
    expect(existsSync(join(bare, 'packhub.yaml'))).toBe(false);

    const pack = join(base, 'ok');
    expect(run(['init', pack, '--name', 'demo/first-mile']).status).toBe(0);
    const planned = run(['plan', pack]);
    expect(planned.status).toBe(0);
    expect(planned.out).toContain('demo/first-mile@0.0.1');

    rmSync(base, { recursive: true, force: true });
  });
  it('discover 能按关键词列候选并写进清单', () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-cli-discover-'));
    const pack = join(base, 'pack');
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, 'rules.md'), '# rules\n', 'utf8');
    writeFileSync(
      join(pack, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/discover, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`,
      'utf8',
    );
    const catalog = join(base, 'resources.json');
    writeFileSync(
      catalog,
      JSON.stringify({
        apiVersion: 'packhub.dev/resources/v0',
        resources: [
          {
            id: 'cli/markdownlint',
            type: 'tool2',
            source: 'npm:markdownlint-cli2@0.14.0',
            title: 'markdownlint-cli2',
            description: 'Markdown lint',
            keywords: ['markdown', 'lint'],
          },
          {
            id: 'skill/review',
            type: 'skill',
            source: 'github:o/r/skills/review@abc1234',
            title: '审查',
            description: 'code review',
          },
        ],
      }),
      'utf8',
    );

    const listed = run(['discover', 'markdown', '--catalog', catalog, '--json']);
    expect(listed.status).toBe(0);
    const parsed = JSON.parse(
      listed.out.slice(listed.out.indexOf('{'), listed.out.lastIndexOf('}') + 1),
    ) as {
      resources: { id: string }[];
    };
    expect(parsed.resources.map((r) => r.id)).toContain('cli/markdownlint');

    const added = run(['discover', 'markdown', '--catalog', catalog, '--add', '1', '--dir', pack]);
    expect(added.status).toBe(0);
    const manifest = readFileSync(join(pack, 'packhub.yaml'), 'utf8');
    expect(manifest).toContain('npm:markdownlint-cli2@0.14.0');

    rmSync(base, { recursive: true, force: true });
  });

  it('清单在锁定后被改过的 .phub 会被拒绝安装', async () => {
    const src = mkdtempSync(join(tmpdir(), 'packhub-cli-lock-'));
    writeFileSync(join(src, 'rules.md'), '# one\n', 'utf8');
    writeFileSync(
      join(src, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/locked, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`,
      'utf8',
    );
    const ctx = loadPack(src);
    writeFileSync(
      join(src, 'packhub.lock.json'),
      JSON.stringify(buildLock(ctx.manifest!), null, 2),
      'utf8',
    );
    // 锁生成后再往清单里加一个资源：锁与计划就对不上了
    writeFileSync(join(src, 'more.md'), '# more\n', 'utf8');
    writeFileSync(
      join(src, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/locked, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
  - id: more
    type: knowledge
    source: ./more.md
`,
      'utf8',
    );
    const archive = join(src, 'pack.phub');
    await packArchive(src, { vendored: true, out: archive });

    const project = mkdtempSync(join(tmpdir(), 'packhub-cli-lock-proj-'));
    const res = run(['install', archive, '--dir', project]);
    expect(res.status).toBe(2);
    expect(res.out).toContain('lock-mismatch');
    expect(existsSync(join(project, '.packhub/knowledge/rules.md'))).toBe(false);

    rmSync(src, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
});

describe('cli 端到端：install', () => {
  it('--dry-run 一个文件都不写，真装才落盘', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-cli-dry-'));
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/dry, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
verify:
  - type: file-exists
    path: "\${target.knowledgeDir}/rules.md"
`,
      'utf8',
    );
    writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');

    const dry = run(['install', dir, '--dir', dir, '--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.out).toContain('done');
    // 计划里写的东西一个都不该出现：没有 .packhub，包目录也没多出文件
    expect(existsSync(join(dir, '.packhub'))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(['packhub.yaml', 'rules.md']);

    const real = run(['install', dir, '--dir', dir]);
    expect(real.status).toBe(0);
    expect(readFileSync(join(dir, '.packhub/knowledge/rules.md'), 'utf8')).toBe('# rules\n');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('cli 端到端：verify 的两种模式', () => {
  const parseJson = (out: string): Record<string, unknown> =>
    JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as Record<string, unknown>;

  it('--json 给两段：漂移 drift + 检查 checks（项目模式 installed/，Pack 模式 planHash）', () => {
    // 项目模式：install 装进来的包没有 packhub.yaml，结果按包分组
    const project = mkdtempSync(join(tmpdir(), 'packhub-cli-verifyproj-'));
    const env = { PACKHUB_INDEX: join(ROOT, 'registry/index.json') };
    expect(run(['install', 'lvlc233/team-conventions', '--dir', project], env).status).toBe(0);
    const installed = run(['verify', project, '--json']);
    expect(installed.status).toBe(0);
    const installedBody = parseJson(installed.out);
    expect(Object.keys(installedBody).sort()).toEqual(['checks', 'drift']);
    expect((installedBody.drift as { ok: boolean }).ok).toBe(true);
    const installedChecks = installedBody.checks as Record<string, unknown>;
    expect(installedChecks.mode).toBe('installed');
    expect(installedChecks.failed).toBe(0);
    expect(installedChecks.skipped).toBe(0);
    expect(Array.isArray(installedChecks.installed)).toBe(true);

    // Pack 模式：原地装一遍再验，planHash 是计划的那一份
    const packDir = mkdtempSync(join(tmpdir(), 'packhub-cli-verifypack-'));
    writeFileSync(
      join(packDir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/verify, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
verify:
  - type: file-exists
    path: "\${target.knowledgeDir}/rules.md"
`,
      'utf8',
    );
    writeFileSync(join(packDir, 'rules.md'), '# rules\n', 'utf8');
    expect(run(['install', packDir, '--dir', packDir]).status).toBe(0);
    const packed = run(['verify', packDir, '--json']);
    expect(packed.status).toBe(0);
    const packedBody = parseJson(packed.out);
    expect(Object.keys(packedBody).sort()).toEqual(['checks', 'drift']);
    const packedChecks = packedBody.checks as Record<string, unknown>;
    expect(packedChecks.mode).toBe('pack');
    expect(typeof packedChecks.planHash).toBe('string');
    expect(packedChecks.failed).toBe(0);
    expect(packedChecks.skipped).toBe(0);

    rmSync(project, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  });

  it('项目模式下已装文件被删：退出 1，失败计数含整包一条', () => {
    const project = mkdtempSync(join(tmpdir(), 'packhub-cli-verifyfail-'));
    const env = { PACKHUB_INDEX: join(ROOT, 'registry/index.json') };
    expect(run(['install', 'lvlc233/team-conventions', '--dir', project], env).status).toBe(0);
    rmSync(join(project, '.packhub/knowledge/style-guide.md'), { force: true });

    const res = run(['verify', project]);
    expect(res.status).toBe(1);
    // 1 项 fail + 这个包 ok=false 的 1 条：与旧命令层的计数逐字一致
    expect(res.out).toContain('1 个包：2 项失败 / 0 项跳过');

    rmSync(project, { recursive: true, force: true });
  });

  it('既没清单也没已装包：退出 2，报 manifest-missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'packhub-cli-verifyempty-'));
    const res = run(['verify', empty]);
    expect(res.status).toBe(2);
    expect(res.out).toContain('manifest-missing');
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('cli 端到端：签名', () => {
  const MANIFEST = (extra: string): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/sign, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
${extra}`;

  it('锁过期时 sign 先拒，重锁后才签得上；签完 verify-sig 通过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-cli-sign-'));
    const keys = mkdtempSync(join(tmpdir(), 'packhub-cli-sign-keys-'));
    writeFileSync(join(dir, 'packhub.yaml'), MANIFEST(''), 'utf8');
    writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');

    expect(run(['lock', dir]).status).toBe(0);
    const key = join(keys, 'test.key');
    expect(run(['keygen', '--out', key]).status).toBe(0);

    // 锁之后再改清单：锁里的快照和当前计划对不上
    writeFileSync(join(dir, 'extra.md'), '# extra\n', 'utf8');
    writeFileSync(
      join(dir, 'packhub.yaml'),
      MANIFEST('  - id: extra\n    type: knowledge\n    source: ./extra.md\n'),
      'utf8',
    );
    const stale = run(['sign', dir, '--key', key]);
    expect(stale.status).toBe(2);
    expect(stale.out).toContain('先跑 packhub lock');

    expect(run(['lock', dir]).status).toBe(0);
    expect(run(['sign', dir, '--key', key]).status).toBe(0);
    const verified = run(['verify-sig', dir]);
    expect(verified.status).toBe(0);
    expect(verified.out).toContain('1/1 个签名通过');

    rmSync(dir, { recursive: true, force: true });
    rmSync(keys, { recursive: true, force: true });
  });
});
