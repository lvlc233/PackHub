import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const hash = (s: string): string => `sha256-${createHash('sha256').update(s).digest('base64')}`;

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
    // 索引里的安装提示归 pal（安装不是 packhub 的事）
    const index = JSON.parse(readFileSync(join(registry, 'index.json'), 'utf8')) as {
      packs: { install?: string }[];
    };
    expect(index.packs[0]!.install).toBe('pal install me/e2e');

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

describe('cli 命令面：只做生产，安装归 pal', () => {
  it('--help 列 18 个命令，且没有 install / uninstall / update / rollback / diff', () => {
    const help = run(['--help']);
    expect(help.status).toBe(0);
    const usage = /USAGE ([^\r\n]+)/.exec(help.out)?.[1] ?? '';
    expect(usage.startsWith('packhub ')).toBe(true);
    const names = usage.replace(/^packhub\s+/, '').split('|');
    expect(names).toHaveLength(18);
    expect(new Set(names).size).toBe(18);
    expect(names).toContain('verify');
    expect(names).toContain('completion');
    for (const removed of ['install', 'uninstall', 'update', 'rollback', 'diff']) {
      expect(names, `packhub 不该再有 ${removed}`).not.toContain(removed);
    }
  });

  it('已删的安装类命令按未知命令拒绝', () => {
    for (const removed of ['install', 'uninstall', 'update', 'rollback', 'diff']) {
      const res = run([removed, '.']);
      expect(res.status, `${removed} 应该被 CITTY 当未知命令`).toBe(1);
      expect(res.out).toContain(`Unknown command ${removed}`);
    }
  });
});

describe('cli 端到端：plan', () => {
  it('落点只由命令行选：清单不声明安装形态', () => {
    const pack = mkdtempSync(join(tmpdir(), 'packhub-cli-harness-'));
    writeFileSync(
      join(pack, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/layout, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`,
      'utf8',
    );
    writeFileSync(join(pack, 'rules.md'), '# rules\n', 'utf8');
    // 清单里没有安装形态字段：不写 --harness 就是平铺目录，写了就按那个宿主的落点现算
    const flat = run(['plan', pack]);
    expect(flat.status).toBe(0);
    expect(flat.out).toContain('→ 平铺目录');

    const planned = run(['plan', pack, '--harness', 'claude-code']);
    expect(planned.status).toBe(0);
    expect(planned.out).toContain('harness=claude-code');
    rmSync(pack, { recursive: true, force: true });
  });

  it('plan 打接线：能力令牌 → provider、needs 边、同一令牌的多个 provider 全列出（--json 里是 wiring）', () => {
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
resources:
  - id: linter-a
    type: mcp
    transport: stdio
    source: npm:linter-a@1.0.0
    provides: [tool/lint@1]
  - id: linter-b
    type: mcp
    transport: stdio
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
      };
    };
    expect(body.planHash).toBeTruthy();
    // 能力：令牌是键，provider 按清单顺序；同一令牌的多个 provider 全部列出
    expect(body.wiring.capabilities).toEqual({
      'skill/review@1': ['reviewer'],
      'tool/lint@1': ['linter-a', 'linter-b'],
    });
    // 边由 needs 派生：两个 provider 都先装
    expect(body.wiring.edges).toEqual([
      { provider: 'linter-a', consumer: 'reviewer', capability: 'tool/lint@1' },
      { provider: 'linter-b', consumer: 'reviewer', capability: 'tool/lint@1' },
    ]);

    // 文本模式同一份接线；顺序是「provider 先装」的证据
    const printed = run(['plan', pack]);
    expect(printed.status).toBe(0);
    expect(printed.out).toContain('接线：');
    expect(printed.out).toContain('tool/lint@1 → linter-a, linter-b');
    expect(printed.out).toContain('linter-a → reviewer（tool/lint@1）');
    expect(printed.out).toContain('linter-b → reviewer（tool/lint@1）');
    // 接线只描述能力与依赖：没有选择语义，不该出现「未装（计划期排除）」那一段
    expect(printed.out).not.toContain('未装（计划期排除）');

    rmSync(base, { recursive: true, force: true });
  });

  it('两个提供者同一令牌：都进计划，没有谁被裁掉', () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-cli-multi-plan-'));
    const pack = join(base, 'pack');
    mkdirSync(pack, { recursive: true });
    writeFileSync(
      join(pack, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/multi-provider, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules-a
    type: knowledge
    source: ./a.md
    provides: [content/rules@1]
  - id: rules-b
    type: knowledge
    source: ./b.md
    provides: [content/rules@1]
  - id: consumer
    type: knowledge
    source: ./c.md
    needs: [content/rules@1]
`,
      'utf8',
    );
    writeFileSync(join(pack, 'a.md'), '# a\n', 'utf8');
    writeFileSync(join(pack, 'b.md'), '# b\n', 'utf8');
    writeFileSync(join(pack, 'c.md'), '# c\n', 'utf8');

    const planned = run(['plan', pack]);
    expect(planned.status).toBe(0);
    expect(planned.out).toContain('content/rules@1 → rules-a, rules-b');
    expect(planned.out).toContain('rules-a → consumer（content/rules@1）');
    expect(planned.out).toContain('rules-b → consumer（content/rules@1）');
    expect(planned.out).toContain('.packhub/knowledge/a.md');
    expect(planned.out).toContain('.packhub/knowledge/b.md');
    expect(planned.out).toContain('.packhub/knowledge/c.md');
    expect(planned.out).not.toContain('未装（计划期排除）');

    rmSync(base, { recursive: true, force: true });
  });
});

describe('cli 端到端：verify 只验 Pack 目录', () => {
  /** 一个 Pack 目录：verify 检查 rules.md 就在目录里（不涉及安装产物）。 */
  function pack(verifyPath = 'rules.md'): string {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-cli-verify-'));
    writeFileSync(
      join(dir, 'packhub.yaml'),
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
    path: ${verifyPath}
`,
      'utf8',
    );
    writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
    return dir;
  }

  it('--json 只有 checks 一段：mode / planHash / results，没有漂移或已装包', () => {
    const dir = pack();
    const res = run(['verify', dir, '--json']);
    expect(res.status).toBe(0);
    const body = JSON.parse(res.out.slice(res.out.indexOf('{'), res.out.lastIndexOf('}') + 1)) as {
      checks: { mode: string; planHash: string; results: { status: string }[]; failed: number };
    };
    expect(Object.keys(body).sort()).toEqual(['checks']);
    expect(body.checks.mode).toBe('pack');
    expect(body.checks.planHash).toMatch(/^sha256-/);
    expect(body.checks.failed).toBe(0);
    expect(body.checks.results.map((r) => r.status)).toEqual(['pass']);

    const text = run(['verify', dir]);
    expect(text.status).toBe(0);
    expect(text.out).toContain('检查：清单 verify 项 + 从计划派生的项');
    expect(text.out).toContain('1 项：1 通过 / 0 失败 / 0 跳过');
    // 漂移是已安装项目的事，Pack 目录模式不该出现
    expect(text.out).not.toContain('漂移');
    rmSync(dir, { recursive: true, force: true });
  });

  it('检查不过退出 1，逐项列出 fail', () => {
    const dir = pack('nope.md');
    const res = run(['verify', dir]);
    expect(res.status).toBe(1);
    expect(res.out).toContain('fail');
    expect(res.out).toContain('1 项：0 通过 / 1 失败 / 0 跳过');
    rmSync(dir, { recursive: true, force: true });
  });

  it('对已安装项目（只有 state 没有清单）：退出 2，指向 pal', () => {
    const project = mkdtempSync(join(tmpdir(), 'packhub-cli-verifyproj-'));
    mkdirSync(join(project, '.packhub'), { recursive: true });
    writeFileSync(
      join(project, '.packhub/state.json'),
      JSON.stringify({ apiVersion: 'packhub.dev/state/v0', packs: {} }, null, 2),
      'utf8',
    );
    const res = run(['verify', project]);
    expect(res.status).toBe(2);
    expect(res.out).toContain('verify 只验 Pack 目录');
    expect(res.out).toContain('已安装项目的检查归 pal');
    rmSync(project, { recursive: true, force: true });
  });

  it('--pack 不再是 verify 的参数（已装包的过滤归 pal）', () => {
    const dir = pack();
    const res = run(['verify', dir, '--pack', 'demo/verify@0.0.1']);
    expect(res.status).toBe(2);
    expect(res.out).toContain('未知参数 --pack');
    rmSync(dir, { recursive: true, force: true });
  });

  it('integrity 派生项：产物在位 pass，被改过 fail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-cli-derived-'));
    const content = '# rules\n';
    // 作者只声明 integrity，不写任何 verify 项：检查由计划里的 write.integrity 派生
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/derived, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
    integrity: ${hash(content)}
`,
      'utf8',
    );
    writeFileSync(join(dir, 'rules.md'), content, 'utf8');
    mkdirSync(join(dir, '.packhub/knowledge'), { recursive: true });
    writeFileSync(join(dir, '.packhub/knowledge/rules.md'), content, 'utf8');

    const ok = run(['verify', dir]);
    expect(ok.status).toBe(0);
    expect(ok.out).toContain('knowledge-integrity');
    expect(ok.out).toContain('1 项：1 通过 / 0 失败 / 0 跳过');

    writeFileSync(join(dir, '.packhub/knowledge/rules.md'), '# tampered\n', 'utf8');
    const bad = run(['verify', dir]);
    expect(bad.status).toBe(1);
    expect(bad.out).toContain('knowledge-integrity');
    expect(bad.out).toContain('1 项：0 通过 / 1 失败 / 0 跳过');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('cli 端到端：search / trust / init / discover', () => {
  it('search 能读索引并按关键词过滤', () => {
    const index = join(ROOT, 'registry/index.json');
    const res = run(['search', 'conventions', '--index', index]);
    expect(res.status).toBe(0);
    expect(res.out).toContain('lvlc233/team-conventions');
  });

  it('trust require on/off 切强制签名，不用手改 trust.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'packhub-cli-trustreq-'));
    const env = { PACKHUB_HOME: home };

    const on = run(['trust', 'require', 'on'], env);
    expect(on.status).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'trust.json'), 'utf8')).requireSignature).toBe(true);

    const off = run(['trust', 'require', 'off'], env);
    expect(off.status).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'trust.json'), 'utf8')).requireSignature).toBe(false);

    const bad = run(['trust', 'require', 'maybe'], env);
    expect(bad.status).toBe(2);
    expect(bad.out).toContain('只认 on 或 off');

    rmSync(home, { recursive: true, force: true });
  });

  it('未知参数退出 2；init 的私有包发布前被拦且不留半套', () => {
    const badFlag = run(['plan', '.', '--nonsense']);
    expect(badFlag.status).toBe(2);
    expect(badFlag.out).toContain('未知参数');

    // 位置参数不接受 --dir：以前会被静默忽略，命令跑在 cwd 上
    const positionalAsFlag = run(['verify', '--dir', '.']);
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
    // init 产出的清单自己也要能被 verify 当成 Pack 目录检查
    expect(run(['verify', pack]).status).toBe(0);

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

  it('缺清单/坏参数是 2：plan 报 manifest-missing 并提示可执行', () => {
    const missing = run(['plan', join(tmpdir(), 'packhub-no-such-pack')]);
    expect(missing.status).toBe(2);
    expect(missing.out).toContain('manifest-missing');
    expect(missing.out).toContain('packhub init');
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
