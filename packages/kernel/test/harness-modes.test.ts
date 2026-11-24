import { describe, expect, it } from 'vitest';
import {
  defaultLaunchMode,
  findLaunchMode,
  harnessIds,
  registerHarness,
  requireHarness,
  type HarnessSpec,
  type LaunchMode,
} from '../src/index.ts';

/**
 * 六宿主的启动模式表：cli 的 `--mode` 就选这里的 id，执行路径由 kind 决定。
 * 这里锁的是「每个宿主声明了什么」，launcher 的行为测试在 packages/launcher/test。
 */
const DEFAULTS: Record<string, string> = {
  dsh: 'web',
  'claude-code': 'tui',
  codex: 'tui',
  opencode: 'tui',
  workbody: 'tui',
  hermes: 'tui',
};

function modeOf(harness: string, id: string): LaunchMode {
  const mode = findLaunchMode(requireHarness(harness), id);
  expect(mode, `${harness} 应有 ${id} 模式`).toBeTruthy();
  return mode!;
}

describe('六宿主的启动模式表', () => {
  it('每个宿主都有模式表与默认模式；id 唯一、label 非空、kind 是三种之一', () => {
    for (const id of harnessIds()) {
      const spec = requireHarness(id);
      expect(spec.modes.length, `${id} 应有启动模式`).toBeGreaterThan(0);
      expect(spec.defaultMode ?? spec.modes[0]!.id).toBe(DEFAULTS[id] ?? spec.modes[0]!.id);
      expect(defaultLaunchMode(spec)).toBeTruthy();
      const ids = spec.modes.map((mode) => mode.id);
      expect(new Set(ids).size, `${id} 的模式 id 重复`).toBe(ids.length);
      for (const mode of spec.modes) {
        expect(mode.label.length, `${id}/${mode.id} 缺人读名字`).toBeGreaterThan(0);
        expect(['server', 'foreground', 'app']).toContain(mode.kind);
        // server 要能从输出里认地址；前台 / app 不认
        if (mode.kind === 'server') expect(mode.url, `${id}/${mode.id} 是 server 却没有 url`).toBeInstanceOf(RegExp);
        else expect(mode.url, `${id}/${mode.id} 不是 server 却有 url`).toBeUndefined();
        if (mode.kind === 'app') expect(mode.app, `${id}/${mode.id} 是 app 却没有 app 解析`).toBeTruthy();
      }
    }
  });

  it('默认模式：dsh=web，其余=tui（codex 默认 tui，不是 app）', () => {
    for (const [id, expected] of Object.entries(DEFAULTS)) {
      expect(requireHarness(id).defaultMode, `${id} 的默认模式`).toBe(expected);
    }
  });

  it('dsh：web 是 server（usesProfile，--profile web 缺省），app 是桌面窗口且只对 attached 开放', () => {
    const web = modeOf('dsh', 'web');
    expect(web).toMatchObject({ kind: 'server', usesProfile: true });
    expect(web.args!({ port: 51_234, root: '/tmp/x' })).toEqual(['--profile', 'web', '--no-open', '--port', '51234']);

    const app = modeOf('dsh', 'app');
    expect(app.kind).toBe('app');
    expect(app.usesProfile).toBeUndefined();
    expect(app.url).toBeUndefined();
    expect(app.app!.env).toBe('PAL_DSH_APP_BIN');
    expect(app.available!({ attached: true })).toBe(true);
    const reason = app.available!({ attached: false });
    expect(typeof reason).toBe('string');
    expect(reason).toContain('只支持 attached dsh');
    // managed 的现有文案仍在：不确认 DSH_HOME 就不开放 app
    expect(reason).toContain('managed 的 app 启动要先确认它能用 DSH_HOME 指到实例');
  });

  it('claude-code：只有 tui（前台 claude，不带参数）', () => {
    const spec = requireHarness('claude-code');
    expect(spec.modes.map((mode) => mode.id)).toEqual(['tui']);
    expect(modeOf('claude-code', 'tui')).toMatchObject({ kind: 'foreground', command: 'claude' });
    expect(modeOf('claude-code', 'tui').args!({ port: 1, root: '/tmp/x' })).toEqual([]);
  });

  it('codex：tui（前台 codex）+ app（只靠 PAL_CODEX_APP_BIN，没有候选路径）', () => {
    expect(requireHarness('codex').modes.map((mode) => mode.id)).toEqual(['tui', 'app']);
    expect(modeOf('codex', 'tui')).toMatchObject({ kind: 'foreground', command: 'codex' });
    const app = modeOf('codex', 'app');
    expect(app.kind).toBe('app');
    expect(app.app!.env).toBe('PAL_CODEX_APP_BIN');
    expect(app.app!.candidates('/home/x')).toEqual([]);
  });

  it('opencode：tui（前台）+ web（local serve，url 认 http）', () => {
    expect(requireHarness('opencode').modes.map((mode) => mode.id)).toEqual(['tui', 'web']);
    expect(modeOf('opencode', 'tui')).toMatchObject({ kind: 'foreground', command: 'opencode' });
    const web = modeOf('opencode', 'web');
    expect(web.kind).toBe('server');
    expect(web.command).toBe('opencode');
    expect(web.args!({ port: 4242, root: '/tmp/x' })).toEqual([
      'serve',
      '--port',
      '4242',
      '--hostname',
      '127.0.0.1',
    ]);
    expect('http://127.0.0.1:4242/'.match(web.url!)).toBeTruthy();
  });

  it('workbody / hermes：只有 tui，命令分别是 codebuddy / hermes', () => {
    for (const [id, command] of [
      ['workbody', 'codebuddy'],
      ['hermes', 'hermes'],
    ] as const) {
      const spec = requireHarness(id);
      expect(spec.modes.map((mode) => mode.id), `${id} 只有 tui`).toEqual(['tui']);
      expect(modeOf(id, 'tui')).toMatchObject({ kind: 'foreground', command });
    }
  });
});

describe('模式表的注册期校验', () => {
  function spec(id: string, over: Partial<HarnessSpec> = {}): HarnessSpec {
    return {
      id,
      label: id,
      destination: () => ({ path: '' }),
      modes: [{ id: 'tui', label: 'TUI', kind: 'foreground' }],
      probe: {
        executable: 'echo',
        args: (ctx) => [ctx.prompt],
        preview: () => 'echo "<prompt>"',
        answer: (stdout) => stdout.trim(),
      },
      ...over,
    };
  }

  it('重复的模式 id 在注册时抛错', () => {
    expect(() =>
      registerHarness(
        spec('temp-dup-mode', {
          modes: [
            { id: 'tui', label: 'a', kind: 'foreground' },
            { id: 'tui', label: 'b', kind: 'foreground' },
          ],
        }),
      ),
    ).toThrow(/启动模式重复：tui/);
  });

  it('defaultMode 指向不存在的模式在注册时抛错', () => {
    expect(() => registerHarness(spec('temp-bad-default', { defaultMode: 'nope' }))).toThrow(
      /默认模式不存在：nope/,
    );
  });

  it('findLaunchMode：没写 id / 不存在都返回 undefined；defaultLaunchMode 缺省第一条', () => {
    registerHarness(spec('temp-modes'));
    const registered = requireHarness('temp-modes');
    expect(defaultLaunchMode(registered)?.id).toBe('tui');
    expect(findLaunchMode(registered, 'tui')?.kind).toBe('foreground');
    expect(findLaunchMode(registered, undefined)).toBeUndefined();
    expect(findLaunchMode(registered, 'nope')).toBeUndefined();
  });
});
