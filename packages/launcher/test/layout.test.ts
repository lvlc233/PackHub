import { describe, expect, it } from 'vitest';
import {
  harnessIds,
  isHarnessId,
  registerHarness,
  requireHarness,
  type DestinationKind,
  type HarnessSpec,
} from '@packhub/kernel';
import {
  adapterFor,
  destinationContext,
  instanceKinds,
  isInstanceKind,
  parseStartUrl,
  requireAdapter,
  supportsAttached,
} from '../src/layout.ts';

const CTX = { port: 51_234, root: 'G:/tmp/pal-instance' };

/** 注册表用例用的最小宿主。 */
function spec(id: string, over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    id,
    label: id,
    destination: (kind: DestinationKind) => ({ path: kind === 'instruction' ? 'TEMP.md' : `.${id}/${kind}` }),
    home: { dir: `home/${id}`, env: `${id.toUpperCase()}_HOME` },
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

  it('实例形态 = dir + 六个宿主；未知形态没有适配器', () => {
    expect(instanceKinds()).toEqual([
      'dir',
      'dsh',
      'claude-code',
      'codex',
      'opencode',
      'workbody',
      'hermes',
    ]);
    expect(instanceKinds()).toEqual(['dir', ...harnessIds()]);
    for (const kind of instanceKinds()) {
      expect(isInstanceKind(kind)).toBe(true);
      expect(adapterFor(kind)).toBeTruthy();
      expect(requireAdapter(kind)).toBeTruthy();
    }
    expect(isInstanceKind('nope')).toBe(false);
    expect(adapterFor('nope' as never)).toBeUndefined();
    expect(() => requireAdapter('nope' as never)).toThrow(/未知实例形态：nope/);
  });

  it('六个宿主都有启动模板：dsh 是 server，其余是 foreground；dir 给能力说明', () => {
    expect(requireHarness('dsh').start?.mode ?? 'server').toBe('server');
    for (const id of ['claude-code', 'codex', 'opencode', 'workbody', 'hermes']) {
      expect(requireHarness(id).start?.mode, `${id} 应是前台启动`).toBe('foreground');
      expect(adapterFor(id)?.start, `${id} 应有启动模板`).toBeTruthy();
      expect(adapterFor(id)?.noStartReason).toBeUndefined();
    }
    expect(adapterFor('dir')?.start).toBeUndefined();
    expect(adapterFor('dir')?.noStartReason).toContain('dir 实例');
  });

  it('opencode：managed 的 home 段是 XDG 那一层，adapter 仍按注册表派生', () => {
    const adapter = adapterFor('opencode')!;
    expect(adapter.homeDir).toBe('home/opencode');
    expect(adapter.homeEnv).toBe('XDG_CONFIG_HOME');
    expect(adapter.label).toBe('opencode');
  });

  it('workbody / hermes 的 home 段与能力说明来自注册表', () => {
    const workbody = adapterFor('workbody')!;
    expect(workbody.homeDir).toBe('home/codebuddy');
    expect(workbody.homeEnv).toBe('CODEBUDDY_CONFIG_DIR');
    expect(workbody.label).toContain('WorkBuddy');
    const hermes = adapterFor('hermes')!;
    expect(hermes.homeDir).toBe('home/hermes');
    expect(hermes.homeEnv).toBe('HERMES_HOME');
    expect(hermes.label).toBe('Hermes Agent');
  });
});

describe('落点上下文（PAL 只回答范围，落点由宿主回答）', () => {
  it('managed：root 是实例根，home 是 root 下的 home 段', () => {
    expect(destinationContext('dsh', { root: 'G:/tmp/pal-instance' })).toEqual({
      root: 'G:/tmp/pal-instance',
      home: 'G:/tmp/pal-instance/home/dsh',
      scope: 'home',
    });
    expect(destinationContext('opencode', { root: '/tmp/inst' })).toMatchObject({
      scope: 'home',
      home: '/tmp/inst/home/opencode',
    });
  });

  it('attached：root 就是宿主全局目录，home 与 root 同值', () => {
    expect(destinationContext('opencode', { attachedHome: '/home/u/.config/opencode' })).toEqual({
      root: '/home/u/.config/opencode',
      home: '/home/u/.config/opencode',
      scope: 'attached',
    });
  });

  it('dir 不是宿主：没有落点上下文', () => {
    expect(destinationContext('dir', { root: '/tmp/x' })).toBeUndefined();
  });

  it('attached 只对已验证全局落点的宿主开放', () => {
    for (const id of ['opencode', 'hermes', 'workbody', 'claude-code', 'codex']) {
      expect(supportsAttached(id), `${id} 应支持 attached`).toBe(true);
    }
    for (const id of ['dir', 'dsh']) {
      expect(supportsAttached(id), `${id} 不该支持 attached`).toBe(false);
    }
  });

  it('落点由宿主回答：managed 范围的值不必经过 PAL', () => {
    const ctx = destinationContext('opencode', { root: '/tmp/inst' })!;
    const spec = requireHarness('opencode');
    expect(spec.destination('skill', ctx).path).toBe('home/opencode/opencode/skills');
    expect(spec.destination('mcp', ctx).path).toBe('home/opencode/opencode/opencode.json');
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
    expect(destinationContext('temp-host', { root: '/tmp/x' })).toMatchObject({
      scope: 'home',
      home: '/tmp/x/home/temp-host',
    });
    // adapterFor 每次按注册表现派生（返回等价对象，不是同一个引用）
    expect(requireAdapter('temp-host')).toEqual(adapter);
  });
});
