import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import packhubSchema from '../../../schema/packhub.v0.schema.json' with { type: 'json' };
import {
  HARNESS_ID_PATTERN,
  harness,
  harnessIds,
  isHarnessId,
  registerHarness,
  requireHarness,
  type DestinationContext,
  type DestinationKind,
  type HarnessSpec,
} from '../src/harness/index.ts';
import { loadPack, planFor } from '../src/index.ts';

/** 落点上下文：项目 / managed / attached 只差 scope（与 root / home）。 */
function ctx(scope: DestinationContext['scope'], root = '.'): DestinationContext {
  return { root, scope, ...(scope === 'project' ? {} : { home: `${root}/home/x` }) };
}

const KINDS: DestinationKind[] = ['skill', 'knowledge', 'prompt', 'mcp', 'instruction', 'bin', 'config', 'cache'];

/** 注册表用例用的最小宿主：形状够、行为不参与。 */
function spec(id: string, over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    id,
    label: id,
    destination: (kind) => ({ path: kind === 'instruction' ? 'TEMP.md' : `.${id}/${kind}` }),
    probe: {
      executable: 'echo',
      args: (ctx) => [ctx.prompt],
      preview: () => 'echo "<prompt>"',
      answer: (stdout) => stdout.trim(),
    },
    ...over,
  };
}

/**
 * 宿主是运行期注册表：`harness/index.ts` import 一遍各宿主模块就算注册。
 *
 * 落点不再是一张内核持有的覆盖表，而是宿主自己的回答：`spec.destination(kind, ctx)`。
 * 这里断言的是「注册表内容」与「六个宿主对每类资源给出的答案」。
 */
describe('宿主注册表', () => {
  it('注册了六个宿主，id 都符合 HARNESS_ID_PATTERN', () => {
    // 顺序 = harness/index.ts 的 import 顺序（CLI 帮助按它列）
    expect(harnessIds()).toEqual([
      'dsh',
      'claude-code',
      'codex',
      'opencode',
      'workbody',
      'hermes',
    ]);
    for (const id of harnessIds()) {
      expect(HARNESS_ID_PATTERN.test(id), `${id} 应该匹配 id 规则`).toBe(true);
      expect(isHarnessId(id)).toBe(true);
      expect(requireHarness(id).id).toBe(id);
      expect(harness(id)?.id).toBe(id);
    }
  });

  it('opencode 现在是宿主；dir 仍然不是（不选宿主 = 平铺目录）', () => {
    expect(isHarnessId('opencode')).toBe(true);
    expect(harness('opencode')?.id).toBe('opencode');
    expect(harnessIds()).toContain('opencode');
    expect(harnessIds()).not.toContain('dir');
  });

  it('schema 的 scenario.harness 是 string + pattern，不是静态 enum', () => {
    const node = (packhubSchema as unknown as {
      definitions: {
        check: { properties: { harness: { type?: string; pattern?: string; enum?: unknown[] } } };
      };
    }).definitions.check.properties.harness;
    expect(node.type).toBe('string');
    expect(node.enum).toBeUndefined();
    expect(node.pattern).toBe(HARNESS_ID_PATTERN.source);
    // 六个已注册的宿主都过这条 pattern
    for (const id of harnessIds()) expect(new RegExp(node.pattern!).test(id)).toBe(true);
    expect(new RegExp(node.pattern!).test('Opencode')).toBe(false);
  });

  it('metadata 不声明 targets（安装形态不在内容层）', () => {
    const metadata = (packhubSchema as unknown as {
      properties: { metadata: { properties: Record<string, unknown> } };
    }).properties.metadata;
    expect(Object.keys(metadata.properties)).not.toContain('targets');
  });
});

describe('落点归宿主：每个宿主回答每类资源落在哪', () => {
  it('项目范围：技能 / MCP / 指令落在宿主认的位置，其余落在包自己的 .packhub', () => {
    const project: Record<string, Partial<Record<DestinationKind, string>>> = {
      dsh: { skill: '.packhub/skills', mcp: '.packhub/config.json', instruction: 'AGENTS.md' },
      'claude-code': { skill: '.claude/skills', mcp: '.mcp.json', instruction: 'CLAUDE.md' },
      codex: { skill: '.codex/skills', mcp: '.packhub/config.json', instruction: 'AGENTS.md' },
      opencode: { skill: '.opencode/skills', mcp: 'opencode.json', instruction: 'AGENTS.md' },
      workbody: { skill: '.codebuddy/skills', mcp: '.mcp.json', instruction: 'CODEBUDDY.md' },
      hermes: { skill: '.packhub/skills', mcp: 'config.yaml', instruction: 'AGENTS.md' },
    };
    for (const [id, expected] of Object.entries(project)) {
      const specOfId = requireHarness(id);
      for (const [kind, path] of Object.entries(expected)) {
        expect(specOfId.destination(kind as DestinationKind, ctx('project')).path, `${id}/${kind}`).toBe(path);
      }
      // 包自己的产物不碰宿主：项目范围也一样是 .packhub
      expect(specOfId.destination('cache', ctx('project')).path).toBe('.packhub/cache');
      expect(specOfId.destination('bin', ctx('project')).path).toBe('.packhub/bin');
      expect(specOfId.destination('config', ctx('project')).path).toBe('.packhub/config');
    }
  });

  it('managed 范围：技能 / 知识 / 提示词进实例 home 段（opencode 多一层 XDG）', () => {
    const home: Record<string, Partial<Record<DestinationKind, string>>> = {
      dsh: {
        skill: 'home/dsh/skills',
        knowledge: 'home/dsh/knowledge',
        prompt: 'home/dsh/prompts',
        mcp: '.packhub/config.json',
      },
      'claude-code': {
        skill: 'home/claude/skills',
        knowledge: 'home/claude/knowledge',
        prompt: 'home/claude/prompts',
        mcp: '.mcp.json',
      },
      codex: {
        skill: 'home/codex/skills',
        knowledge: 'home/codex/knowledge',
        prompt: 'home/codex/prompts',
        mcp: '.packhub/config.json',
      },
      opencode: {
        skill: 'home/opencode/opencode/skills',
        knowledge: 'home/opencode/opencode/knowledge',
        prompt: 'home/opencode/opencode/prompts',
        mcp: 'home/opencode/opencode/opencode.json',
      },
      workbody: {
        skill: 'home/codebuddy/skills',
        knowledge: 'home/codebuddy/knowledge',
        prompt: 'home/codebuddy/prompts',
        mcp: 'home/codebuddy/mcp.json',
      },
      hermes: {
        skill: 'home/hermes/skills',
        knowledge: 'home/hermes/knowledge',
        prompt: 'home/hermes/prompts',
        mcp: 'home/hermes/config.yaml',
      },
    };
    for (const [id, expected] of Object.entries(home)) {
      const specOfId = requireHarness(id);
      for (const [kind, path] of Object.entries(expected)) {
        expect(specOfId.destination(kind as DestinationKind, ctx('home')).path, `${id}/${kind}`).toBe(path);
      }
      // managed 的 bin / config / cache 仍在实例自己的 .packhub
      expect(specOfId.destination('cache', ctx('home')).path).toBe('.packhub/cache');
    }
  });

  it('attached 范围只对已验证全局落点的宿主开放，值相对那个 home', () => {
    // 绝对 home 才能推出 claude 的 `~/.claude.json`：attached 的 root/home 由 PAL 传绝对路径
    const attachedCtx = (root: string): DestinationContext => ({
      root,
      home: root,
      scope: 'attached',
    });
    const home = join(tmpdir(), 'packhub-attached-home');
    expect(requireHarness('opencode').destination('skill', ctx('attached')).path).toBe('skills');
    expect(requireHarness('opencode').destination('mcp', ctx('attached')).path).toBe('opencode.json');
    expect(requireHarness('hermes').destination('skill', ctx('attached')).path).toBe('skills');
    expect(requireHarness('hermes').destination('mcp', ctx('attached')).path).toBe('config.yaml');
    expect(requireHarness('workbody').destination('skill', ctx('attached')).path).toBe('skills');
    expect(requireHarness('workbody').destination('mcp', ctx('attached')).path).toBe('mcp.json');

    // claude-code：技能 / 知识 / 提示词 / 指令相对 home；MCP 是 home 旁边的 ~/.claude.json（绝对）
    const claude = requireHarness('claude-code');
    expect(claude.destination('skill', attachedCtx(home))).toMatchObject({ path: 'skills', base: 'home' });
    expect(claude.destination('knowledge', attachedCtx(home))).toMatchObject({
      path: 'knowledge',
      base: 'home',
    });
    expect(claude.destination('prompt', attachedCtx(home))).toMatchObject({ path: 'prompts', base: 'home' });
    expect(claude.destination('instruction', attachedCtx(home))).toMatchObject({
      path: 'CLAUDE.md',
      base: 'home',
    });
    const claudeMcp = claude.destination('mcp', attachedCtx(home));
    expect(claudeMcp.base).toBe('absolute');
    expect(claudeMcp.path).toBe(join(dirname(home), '.claude.json').replaceAll('\\', '/'));

    // codex：技能 / 知识 / 提示词 / 指令 / config.toml 都在 home 里
    const codex = requireHarness('codex');
    expect(codex.destination('skill', attachedCtx(home))).toMatchObject({ path: 'skills', base: 'home' });
    expect(codex.destination('instruction', attachedCtx(home))).toMatchObject({
      path: 'AGENTS.md',
      base: 'home',
    });
    expect(codex.destination('mcp', attachedCtx(home))).toMatchObject({
      path: 'config.toml',
      base: 'home',
    });

    // dsh：技能 / 知识 / 提示词 / 指令相对 home；MCP 是每个已有 profile 的 patch 文件
    const dsh = requireHarness('dsh');
    expect(dsh.destination('skill', attachedCtx(home))).toMatchObject({ path: 'skills', base: 'home' });
    expect(dsh.destination('knowledge', attachedCtx(home))).toMatchObject({ path: 'knowledge', base: 'home' });
    expect(dsh.destination('prompt', attachedCtx(home))).toMatchObject({ path: 'prompts', base: 'home' });
    expect(dsh.destination('instruction', attachedCtx(home))).toMatchObject({
      path: 'AGENTS.md',
      base: 'home',
    });
    const dshMcp = dsh.destination('mcp', attachedCtx(home));
    // 一个 profile 都没有时退回 web：让安装把它建出来；只有一个文件时不写 paths
    expect(dshMcp).toMatchObject({ path: 'profiles/web/cordis.patch.yml', base: 'home' });
    expect(dshMcp.paths).toBeUndefined();
    expect(dshMcp.mcp).toMatchObject({
      format: 'yaml',
      list: { field: 'insert', ownerPrefix: 'pal-mcp-' },
    });

    // 已有多个 profile：paths 是完整列表（字典序，第一个当主文件）
    const multi = join(tmpdir(), 'packhub-attached-dsh');
    mkdirSync(join(multi, 'profiles', 'web'), { recursive: true });
    mkdirSync(join(multi, 'profiles', 'desktop'), { recursive: true });
    writeFileSync(join(multi, 'profiles', 'web', 'cordis.patch.yml'), '[]\n', 'utf8');
    writeFileSync(join(multi, 'profiles', 'desktop', 'cordis.patch.yml'), '[]\n', 'utf8');
    const dshMulti = dsh.destination('mcp', attachedCtx(multi));
    expect(dshMulti.path).toBe('profiles/desktop/cordis.patch.yml');
    expect(dshMulti.paths).toEqual([
      { path: 'profiles/desktop/cordis.patch.yml', base: 'home' },
      { path: 'profiles/web/cordis.patch.yml', base: 'home' },
    ]);
    rmSync(multi, { recursive: true, force: true });

    // 六个宿主都验证过全局落点（dsh 的 MCP 按 profile 走多文件，见上）
    for (const id of ['opencode', 'hermes', 'workbody', 'claude-code', 'codex', 'dsh']) {
      expect(requireHarness(id).attached, `${id} 应标 attached`).toBe(true);
    }
  });

  it('结构：每个注册宿主都实现 destination，路径类落点都是字符串', () => {
    for (const id of harnessIds()) {
      const specOfId = requireHarness(id);
      expect(typeof specOfId.destination, `${id} 应实现 destination`).toBe('function');
      for (const scope of ['project', 'home', 'attached'] as const) {
        // 没有 declared attached 能力的宿主：attached 直接抛错，不许回落
        if (scope === 'attached' && specOfId.attached !== true) {
          expect(() => specOfId.destination('skill', ctx(scope)), `${id}/attached 应拒绝`).toThrow(/attached/);
          continue;
        }
        for (const kind of ['skill', 'knowledge', 'prompt', 'bin', 'config', 'cache'] as const) {
          const { path } = specOfId.destination(kind, ctx(scope));
          expect(typeof path, `${id}/${scope}/${kind}`).toBe('string');
          expect(path.length, `${id}/${scope}/${kind} 不该是空的`).toBeGreaterThan(0);
        }
        // mcp 是文件落点：要么是宿主的配置文件，要么是 .packhub 里的登记文件
        expect(typeof specOfId.destination('mcp', ctx(scope)).path).toBe('string');
        // 指令文件：六个宿主都有项目指令面
        expect(specOfId.destination('instruction', ctx('project')).path).toMatch(/\.md$/);
      }
    }
  });

  it('MCP 方言随落点一起给：opencode 是 mcp.servers + local/remote 条目', () => {
    const mcp = requireHarness('opencode').destination('mcp', ctx('project'));
    expect(mcp.path).toBe('opencode.json');
    expect(mcp.mcp?.path).toEqual(['mcp', 'servers']);
    expect(mcp.mcp?.file).toBeUndefined(); // 文件名由落点回答
    expect(mcp.mcp?.format).toBeUndefined(); // 默认 JSON

    // 本地条目：{ type: 'local', command: [exe, ...args] }
    expect(
      mcp.mcp!.entry!({ transport: 'stdio', command: 'npx', args: ['-y', '@scope/x@1.0.0'] }, { resource: 'x' }),
    ).toEqual({ type: 'local', command: ['npx', '-y', '@scope/x@1.0.0'] });
    // 远程条目：{ type: 'remote', url }
    expect(mcp.mcp!.entry!({ transport: 'http', url: 'https://mcp.example.com' }, { resource: 'r' })).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com',
    });
    // env 变成 environment
    expect(
      mcp.mcp!.entry!({ command: 'npx', args: ['pkg'], env: { TOKEN: 'x' } }, { resource: 'e' }),
    ).toMatchObject({
      type: 'local',
      environment: { TOKEN: 'x' },
    });
  });

  it('workbody：项目 MCP 是 .mcp.json、用默认方言（JSON mcpServers）', () => {
    const specOfId = requireHarness('workbody');
    expect(specOfId.destination('mcp', ctx('project')).path).toBe('.mcp.json');
    // 不写方言 = 默认方言：JSON + mcpServers.<name> + spec 原样
    expect(specOfId.destination('mcp', ctx('project')).mcp).toBeUndefined();
    expect(specOfId.home).toEqual({ dir: 'home/codebuddy', env: 'CODEBUDDY_CONFIG_DIR' });
    expect(specOfId.project).toBeUndefined(); // 默认 full
  });

  it('hermes：只有全局目录（project=false），MCP 是 YAML 的 mcp_servers', () => {
    const specOfId = requireHarness('hermes');
    expect(specOfId.project).toBe(false);
    expect(specOfId.home).toEqual({ dir: 'home/hermes', env: 'HERMES_HOME' });

    const mcp = specOfId.destination('mcp', ctx('home')).mcp!;
    expect(mcp.path).toEqual(['mcp_servers']);
    expect(mcp.format).toBe('yaml');
    expect(mcp.entry!({ command: 'npx', args: ['-y', 'pkg'], env: { K: 'V' } }, { resource: 'h' })).toEqual({
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { K: 'V' },
    });
    expect(mcp.entry!({ url: 'https://mcp.example.com' }, { resource: 'h2' })).toEqual({
      url: 'https://mcp.example.com',
    });
  });

  it('宿主 project 三态：dsh pointer、hermes false、其余不写（full）', () => {
    // dsh 的技能是全局的：项目里只写指路块
    expect(requireHarness('dsh').project).toBe('pointer');
    // hermes 只有全局目录：没有项目级落点
    expect(requireHarness('hermes').project).toBe(false);
    // 其余不写 = full：项目里照常落技能/知识
    for (const id of ['claude-code', 'codex', 'opencode', 'workbody']) {
      expect(requireHarness(id).project, `${id} 应有完整项目级落点`).toBeUndefined();
    }
  });
});

describe('临时注册', () => {
  it('registerHarness 之后 harnessIds / isHarnessId / destination 立刻生效', () => {
    const temp = spec('temp-host');
    registerHarness(temp);

    expect(harnessIds()).toContain('temp-host');
    expect(isHarnessId('temp-host')).toBe(true);
    expect(harness('temp-host')).toBe(temp);
    expect(requireHarness('temp-host').label).toBe('temp-host');
    expect(requireHarness('temp-host').destination('skill', ctx('project')).path).toBe('.temp-host/skill');
    expect(requireHarness('temp-host').destination('instruction', ctx('project')).path).toBe('TEMP.md');
    // 没覆盖的落点仍然由宿主回答（这里是它自己的回答，不是内核的默认表）
    expect(requireHarness('temp-host').destination('cache', ctx('home')).path).toBe('.temp-host/cache');
    for (const kind of KINDS) {
      expect(typeof requireHarness('temp-host').destination(kind, ctx('project')).path).toBe('string');
    }
  });

  it('非法 id 抛错，且不会进注册表', () => {
    expect(() => registerHarness(spec('Bad_Id'))).toThrow(/宿主 id 不合法/);
    expect(isHarnessId('Bad_Id')).toBe(false);
  });

  it('重复 id 抛错（模块被 import 两次或 id 抄错）', () => {
    expect(() => registerHarness(spec('dsh'))).toThrow(/宿主重复注册：dsh/);
  });
});

describe('${layout.*} 是落点的派生视图', () => {
  /** 一个只用插值的清单：exec 的参数是目录落点，verify 的路径是指令文件。 */
  function interpPack(): string {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-layout-'));
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/layout, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: cfg
    type: config
    source: ./cfg.yaml
install:
  exec:
    - command: node
      args:
        - "\${layout.skillsDir}"
        - "\${layout.configFile}"
        - "\${layout.root}"
verify:
  - type: file-exists
    path: "\${layout.instructionFile}"
`,
      'utf8',
    );
    writeFileSync(join(dir, 'cfg.yaml'), 'app:\n  flavor: a\n', 'utf8');
    return dir;
  }

  it('插值取到宿主 destination 的回答，不另存一份落点表', () => {
    const dir = interpPack();
    const ctxOfPack = loadPack(dir);
    const planOf = (opts: Parameters<typeof planFor>[1]) => planFor(ctxOfPack, opts).plan!;

    // 项目范围：技能 / MCP 在宿主认的位置，root 仍是包自己的 .packhub
    const project = planOf({ harness: 'opencode' });
    const projectExec = project.actions.find((a) => a.op === 'exec');
    expect(projectExec && 'args' in projectExec ? projectExec.args : []).toEqual([
      '.opencode/skills',
      'opencode.json',
      '.packhub',
    ]);
    expect(project.verify).toEqual([{ type: 'file-exists', path: 'AGENTS.md' }]);

    // managed 范围：同一个宿主的回答按 scope 分叉（XDG 多一层），插值跟着变
    const managed = planOf({ harness: 'opencode', scope: 'home', root: '/inst', home: '/inst/home/opencode' });
    const managedExec = managed.actions.find((a) => a.op === 'exec');
    expect(managedExec && 'args' in managedExec ? managedExec.args : []).toEqual([
      'home/opencode/opencode/skills',
      'home/opencode/opencode/opencode.json',
      '.packhub',
    ]);
    expect(managed.verify).toEqual([{ type: 'file-exists', path: 'AGENTS.md' }]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('没有指令面的形态（平铺目录）不给 instructionFile：写了报未定义变量', () => {
    const dir = interpPack();
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    expect(issues.some((i) => i.code === 'undefined-variable')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
