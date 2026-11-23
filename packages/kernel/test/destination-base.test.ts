import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ISSUE_CODES,
  loadPack,
  planFor,
  registerHarness,
  type HarnessSpec,
} from '../src/index.ts';

/**
 * 路径基准的边界：
 * - 适配器声明 `base: 'absolute'` 时，path 必须是绝对路径，否则计划期报 issue；
 * - `base: 'home'` 需要这个安装范围有 home 段；
 * - 动作上的 toBase 与 destination 的 base 同源（默认 root 不写字段，旧计划逐字节不变）。
 */
const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/base, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`;

function packDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-base-'));
  writeFileSync(join(dir, 'packhub.yaml'), MANIFEST, 'utf8');
  writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
  return dir;
}

function host(id: string, destination: HarnessSpec['destination']): void {
  registerHarness({
    id,
    label: id,
    destination,
    attached: true,
    probe: {
      executable: 'echo',
      args: (ctx) => [ctx.prompt],
      preview: () => 'echo "<prompt>"',
      answer: (stdout) => stdout.trim(),
    },
  });
}

describe('Destination.base 的校验与派生', () => {
  it('base: absolute 但路径不是绝对路径 → bad-destination-base', () => {
    host('temp-abs-bad', (kind) =>
      kind === 'knowledge' ? { path: 'relative/rules.md', base: 'absolute' } : { path: `.packhub/${kind}` },
    );
    const dir = packDir();
    const { plan, issues } = planFor(loadPack(dir), { harness: 'temp-abs-bad', platform: 'linux-x64' });
    expect(plan).toBeUndefined();
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: ISSUE_CODES.badDestinationBase,
        severity: 'error',
        path: 'destination.knowledge',
      }),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('base: absolute + 绝对路径：动作带 toBase，默认 root 不写字段', () => {
    const abs = join(tmpdir(), 'packhub-abs-knowledge');
    host('temp-abs-ok', (kind) =>
      kind === 'knowledge' ? { path: abs, base: 'absolute' } : { path: `.packhub/${kind}` },
    );
    const dir = packDir();
    const { plan, issues } = planFor(loadPack(dir), { harness: 'temp-abs-ok', platform: 'linux-x64' });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(plan).toBeDefined();
    const write = plan!.actions.find((a) => a.op === 'write')!;
    expect(write).toMatchObject({ to: `${abs}/rules.md`, toBase: 'absolute' });

    // 同为 write，root 基准的动作不带 toBase（旧 JSON 逐字节不变）
    const project = planFor(loadPack(dir), { platform: 'linux-x64' }).plan!;
    const plain = project.actions.find((a) => a.op === 'write')!;
    expect('toBase' in plain).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('base: home 但没有 home 段 → issue；有 home 时动作带 toBase: home', () => {
    host('temp-home', (kind) =>
      kind === 'knowledge' ? { path: 'knowledge', base: 'home' } : { path: `.packhub/${kind}` },
    );
    const dir = packDir();
    const missing = planFor(loadPack(dir), { harness: 'temp-home', platform: 'linux-x64' });
    expect(missing.plan).toBeUndefined();
    expect(missing.issues.some((i) => i.code === ISSUE_CODES.badDestinationBase)).toBe(true);

    const home = join(tmpdir(), 'packhub-temp-home');
    const withHome = planFor(loadPack(dir), {
      harness: 'temp-home',
      scope: 'home',
      root: '/inst',
      home,
      platform: 'linux-x64',
    });
    const write = withHome.plan!.actions.find((a) => a.op === 'write')!;
    expect(write).toMatchObject({ to: 'knowledge/rules.md', toBase: 'home' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('现有宿主的计划不带基准字段：默认 root 不写进 JSON（旧计划逐字节不变）', () => {
    const fixture = fileURLToPath(
      new URL('../../../test/fixtures/packs/doc-review', import.meta.url),
    );
    const ctx = loadPack(fixture);
    const assertNoBase = (label: string, actions: unknown[]): void => {
      const json = JSON.stringify(actions);
      for (const field of ['toBase', 'destBase', 'entryBase', 'moduleBase', '"base"']) {
        expect(json.includes(field), `${label} 不该出现 ${field}`).toBe(false);
      }
    };

    // 六个宿主的 project / managed
    for (const harness of ['dsh', 'claude-code', 'codex', 'opencode', 'workbody', 'hermes']) {
      for (const scope of ['project', 'home'] as const) {
        const { plan } = planFor(ctx, {
          harness,
          scope,
          root: '/inst',
          home: '/inst/home/x',
          platform: 'linux-x64',
        });
        expect(plan, `${harness}/${scope} 生成不了计划`).toBeDefined();
        assertNoBase(`${harness}/${scope}`, plan!.actions);
      }
    }

    // 现有的三个 attached 宿主（claude-code / codex 的 attached 是新加的，会带基准）
    for (const harness of ['opencode', 'workbody', 'hermes']) {
      const { plan } = planFor(ctx, {
        harness,
        scope: 'attached',
        root: '/tmp/attached-home',
        home: '/tmp/attached-home',
        platform: 'linux-x64',
      });
      expect(plan, `${harness}/attached 生成不了计划`).toBeDefined();
      assertNoBase(`${harness}/attached`, plan!.actions);
    }
  });

  it('${layout.*} 按 base 给：home 下是相对路径，absolute 原样', () => {
    const abs = join(tmpdir(), 'packhub-layout-abs.json');
    host('temp-layout', (kind) => {
      if (kind === 'knowledge') return { path: 'knowledge', base: 'home' };
      if (kind === 'mcp') return { path: abs, base: 'absolute' };
      return { path: `.packhub/${kind}` };
    });
    const dir = mkdtempSync(join(tmpdir(), 'packhub-layout-base-'));
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `${MANIFEST}install:
  exec:
    - command: node
      args: ["\${layout.knowledgeDir}", "\${layout.configFile}"]
`,
      'utf8',
    );
    writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
    const { plan } = planFor(loadPack(dir), {
      harness: 'temp-layout',
      scope: 'home',
      root: '/inst',
      home: join(tmpdir(), 'packhub-layout-home'),
      platform: 'linux-x64',
    });
    const exec = plan!.actions.find((a) => a.op === 'exec')!;
    expect(exec && 'args' in exec ? exec.args : []).toEqual(['knowledge', abs]);
    rmSync(dir, { recursive: true, force: true });
  });
});
