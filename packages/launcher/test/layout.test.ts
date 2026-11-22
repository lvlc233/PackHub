import { describe, expect, it } from 'vitest';
import {
  harnessIds,
  isHarnessId,
  registerHarness,
  requireHarness,
  type HarnessSpec,
} from '@packhub/kernel';
import {
  adapterFor,
  instanceKinds,
  isInstanceKind,
  layoutVarsFor,
  parseStartUrl,
  requireAdapter,
} from '../src/layout.ts';

const CTX = { port: 51_234, root: 'G:/tmp/pal-instance' };

/** 注册表用例用的最小宿主。 */
function spec(id: string, over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    id,
    label: id,
    layout: { instructionFile: 'TEMP.md', skillsDir: `.${id}/skills` },
    home: { dir: `home/${id}`, env: `${id.toUpperCase()}_HOME` },
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

describe('宿主适配（从注册表派生）', () => {
  it('dsh 的资源落进实例自己的 home', () => {
    expect(layoutVarsFor('dsh')).toMatchObject({
      skillsDir: 'home/dsh/skills',
      knowledgeDir: 'home/dsh/knowledge',
    });
    expect(layoutVarsFor('dir')).toBeUndefined();
  });

  it('从启动输出里取地址与端口', () => {
    expect(parseStartUrl('dsh web: http://127.0.0.1:55860/?token=x', 'dsh')).toEqual({
      url: 'http://127.0.0.1:55860/?token=x',
      port: 55860,
    });
    expect(parseStartUrl('nothing here', 'dsh')).toBeUndefined();
  });

  it('dsh 的启动参数来自注册表：--profile web → --patch → --no-open → --port', () => {
    const start = requireHarness('dsh').start!;
    expect(start.args({ ...CTX, patchFile: 'patch.yml' })).toEqual([
      '--profile',
      'web',
      '--patch',
      'patch.yml',
      '--no-open',
      '--port',
      '51234',
    ]);
    // 没有 patch 时不带空参数
    expect(start.args(CTX)).toEqual(['--profile', 'web', '--no-open', '--port', '51234']);
    // 适配器拿到的就是同一份模板
    expect(adapterFor('dsh')?.start).toBe(start);
  });

  it('实例形态 = dir + 注册表里的宿主；未知形态没有适配器', () => {
    expect(instanceKinds()).toEqual(['dir', ...harnessIds()]);
    for (const kind of instanceKinds()) {
      expect(isInstanceKind(kind)).toBe(true);
      expect(adapterFor(kind)).toBeTruthy();
      expect(requireAdapter(kind)).toBeTruthy();
    }
    expect(isInstanceKind('opencode')).toBe(false);
    expect(adapterFor('opencode' as never)).toBeUndefined();
    expect(() => requireAdapter('opencode' as never)).toThrow(/未知实例形态：opencode/);
  });

  it('只有能托管的宿主有启动模板；其余给能力说明而不是空模板', () => {
    expect(requireHarness('dsh').start).toBeTruthy();
    expect(requireHarness('claude-code').start).toBeUndefined();
    expect(requireHarness('codex').start).toBeUndefined();
    expect(adapterFor('claude-code')?.noStartReason).toContain('Claude Code');
    expect(adapterFor('codex')?.noStartReason).toContain('Codex');
    expect(adapterFor('dir')?.start).toBeUndefined();
    expect(adapterFor('dir')?.noStartReason).toContain('dir 实例');
  });
});

describe('临时注册宿主', () => {
  it('registerHarness 之后 adapterFor / instanceKinds 立刻生效', () => {
    registerHarness(spec('temp-host'));

    expect(harnessIds()).toContain('temp-host');
    expect(isHarnessId('temp-host')).toBe(true);
    expect(instanceKinds()).toContain('temp-host');
    expect(isInstanceKind('temp-host')).toBe(true);

    const adapter = adapterFor('temp-host')!;
    expect(adapter.label).toBe('temp-host');
    expect(adapter.homeDir).toBe('home/temp-host');
    expect(adapter.homeEnv).toBe('TEMP-HOST_HOME');
    expect(layoutVarsFor('temp-host')).toMatchObject({
      skillsDir: 'home/temp-host/skills',
    });
    // adapterFor 每次按注册表现派生（返回等价对象，不是同一个引用）
    expect(requireAdapter('temp-host')).toEqual(adapter);
  });
});
