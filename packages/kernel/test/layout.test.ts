import { describe, expect, it } from 'vitest';
import packhubSchema from '../../../schema/packhub.v0.schema.json' with { type: 'json' };
import {
  HARNESS_ID_PATTERN,
  harness,
  harnessIds,
  isHarnessId,
  layoutFor,
  registerHarness,
  requireHarness,
  type HarnessSpec,
} from '../src/harness/index.ts';
import { DIR_LAYOUT_VARS, layoutVarsWith } from '../src/layout.ts';

/** 注册表用例用的最小宿主：形状够、行为不参与。 */
function spec(id: string, over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    id,
    label: id,
    layout: { instructionFile: 'TEMP.md' },
    instructionFile: 'TEMP.md',
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
 * 落点表不再是「一张覆盖所有宿主的常量表」，而是 `layoutFor(id)` 现查注册表、
 * 把模块里的 `layout` 差量叠到平铺约定上；所以这里断言的是「注册表内容」与「派生结果」。
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

  it('layoutFor：平铺不碰宿主的落点；每个宿主的差量来自它模块里的 layout', () => {
    expect(layoutFor()).toBe(DIR_LAYOUT_VARS);
    expect(DIR_LAYOUT_VARS.instructionFile).toBeUndefined();

    for (const id of harnessIds()) {
      const specOfId = requireHarness(id);
      expect(layoutFor(id)).toEqual(layoutVarsWith(specOfId.layout));
      expect(layoutFor(id)).toMatchObject(specOfId.layout);
      expect(layoutFor(id).instructionFile).toBeTruthy();
    }
    // 未知宿主：不猜，直接抛
    expect(() => layoutFor('nope')).toThrow(/未知宿主：nope/);
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

describe('新宿主的静态知识与 MCP 方言', () => {
  it('opencode：XDG 落点多一层 opencode/，MCP 是 mcp.servers + local/remote 条目', () => {
    const spec = requireHarness('opencode');
    expect(spec.layout).toMatchObject({ skillsDir: '.opencode/skills', configFile: 'opencode.json' });
    expect(spec.home).toEqual({ dir: 'home/opencode', env: 'XDG_CONFIG_HOME' });
    expect(spec.instanceLayout?.('home/opencode')).toEqual({
      skillsDir: 'home/opencode/opencode/skills',
      knowledgeDir: 'home/opencode/opencode/knowledge',
      promptsDir: 'home/opencode/opencode/prompts',
      configFile: 'home/opencode/opencode/opencode.json',
    });

    const mcp = spec.mcp!;
    expect(mcp.path).toEqual(['mcp', 'servers']);
    expect(mcp.file).toBeUndefined(); // 用 layout.configFile
    expect(mcp.format).toBeUndefined(); // 默认 JSON

    // 本地条目：{ type: 'local', command: [exe, ...args] }
    expect(
      mcp.entry!({ transport: 'stdio', command: 'npx', args: ['-y', '@scope/x@1.0.0'] }),
    ).toEqual({ type: 'local', command: ['npx', '-y', '@scope/x@1.0.0'] });
    // 远程条目：{ type: 'remote', url }
    expect(mcp.entry!({ transport: 'http', url: 'https://mcp.example.com' })).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com',
    });
    // env 变成 environment
    expect(
      mcp.entry!({ command: 'npx', args: ['pkg'], env: { TOKEN: 'x' } }),
    ).toMatchObject({ type: 'local', environment: { TOKEN: 'x' } });
  });

  it('workbody：项目落点是 .mcp.json，MCP 用默认方言（mcpServers）', () => {
    const spec = requireHarness('workbody');
    expect(spec.layout).toMatchObject({
      skillsDir: '.codebuddy/skills',
      configFile: '.mcp.json',
      instructionFile: 'CODEBUDDY.md',
    });
    expect(spec.home).toEqual({ dir: 'home/codebuddy', env: 'CODEBUDDY_CONFIG_DIR' });
    expect(spec.instanceLayout?.('home/codebuddy')).toMatchObject({
      skillsDir: 'home/codebuddy/skills',
      configFile: 'home/codebuddy/mcp.json',
    });
    // 不写 mcp = 默认方言：JSON + mcpServers.<name> + spec 原样
    expect(spec.mcp).toBeUndefined();
    expect(spec.project).toBeUndefined(); // 默认 true
  });

  it('hermes：只有全局目录（project=false），MCP 是 YAML 的 mcp_servers', () => {
    const spec = requireHarness('hermes');
    expect(spec.project).toBe(false);
    expect(spec.home).toEqual({ dir: 'home/hermes', env: 'HERMES_HOME' });
    expect(spec.instanceLayout?.('home/hermes')).toMatchObject({
      skillsDir: 'home/hermes/skills',
      configFile: 'home/hermes/config.yaml',
    });

    const mcp = spec.mcp!;
    expect(mcp.path).toEqual(['mcp_servers']);
    expect(mcp.format).toBe('yaml');
    expect(mcp.entry!({ command: 'npx', args: ['-y', 'pkg'], env: { K: 'V' } })).toEqual({
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { K: 'V' },
    });
    expect(mcp.entry!({ url: 'https://mcp.example.com' })).toEqual({
      url: 'https://mcp.example.com',
    });
  });

  it('其它宿主默认都有项目级落点（project 不写 = true）', () => {
    for (const id of ['dsh', 'claude-code', 'codex', 'opencode', 'workbody']) {
      expect(requireHarness(id).project, `${id} 应有项目级落点`).toBeUndefined();
    }
  });
});

describe('临时注册', () => {
  it('registerHarness 之后 harnessIds / isHarnessId / layoutFor 立刻生效', () => {
    const temp = spec('temp-host', {
      layout: { instructionFile: 'TEMP.md', skillsDir: '.temp/skills' },
    });
    registerHarness(temp);

    expect(harnessIds()).toContain('temp-host');
    expect(isHarnessId('temp-host')).toBe(true);
    expect(harness('temp-host')).toBe(temp);
    expect(requireHarness('temp-host').label).toBe('temp-host');
    expect(layoutFor('temp-host').skillsDir).toBe('.temp/skills');
    expect(layoutFor('temp-host').instructionFile).toBe('TEMP.md');
    // 注册项只叠自己的差量：其余仍是平铺
    expect(layoutFor('temp-host').knowledgeDir).toBe(DIR_LAYOUT_VARS.knowledgeDir);
  });

  it('非法 id 抛错，且不会进注册表', () => {
    expect(() => registerHarness(spec('Bad_Id'))).toThrow(/宿主 id 不合法/);
    expect(isHarnessId('Bad_Id')).toBe(false);
  });

  it('重复 id 抛错（模块被 import 两次或 id 抄错）', () => {
    expect(() => registerHarness(spec('dsh'))).toThrow(/宿主重复注册：dsh/);
  });
});
