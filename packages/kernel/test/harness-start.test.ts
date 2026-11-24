import { describe, expect, it } from 'vitest';
import { requireHarness, type StartContext } from '../src/index.ts';

/**
 * 启动模板的参数拼法：dsh 的 `--profile` 取 `StartContext.profile`，没给 / 给 `all` 时落回默认 web。
 *
 * 这条规则在 kernel 里，launcher 只负责把「命令行 > 记录 > 默认」解析出来传进来；
 * 别的宿主没有 profile 子空间，同一个字段不影响它们的参数。
 */
const CTX: StartContext = { port: 51_234, root: 'G:/tmp/pal-instance' };

describe('dsh 启动参数里的 profile', () => {
  it('profile=desktop：argv 带 --profile desktop（在子命令参数之前）', () => {
    const args = requireHarness('dsh').start!.args({ ...CTX, profile: 'desktop' });
    expect(args).toEqual(['--profile', 'desktop', '--no-open', '--port', '51234']);
  });

  it('不给 profile：默认 web（managed 行为不变）', () => {
    expect(requireHarness('dsh').start!.args(CTX)).toEqual(['--profile', 'web', '--no-open', '--port', '51234']);
  });

  it("profile='all'（安装范围，不是可启动的 profile）：也落回 web", () => {
    expect(requireHarness('dsh').start!.args({ ...CTX, profile: 'all' })).toEqual([
      '--profile',
      'web',
      '--no-open',
      '--port',
      '51234',
    ]);
    // 空串同理
    expect(requireHarness('dsh').start!.args({ ...CTX, profile: '  ' })).toEqual([
      '--profile',
      'web',
      '--no-open',
      '--port',
      '51234',
    ]);
  });

  it('patch 层仍在 profile 之后：--profile desktop --patch <file> --no-open --port', () => {
    expect(requireHarness('dsh').start!.args({ ...CTX, profile: 'desktop', patchFile: 'p.yml' })).toEqual([
      '--profile',
      'desktop',
      '--patch',
      'p.yml',
      '--no-open',
      '--port',
      '51234',
    ]);
  });

  it('其它宿主忽略 profile：参数里不会凭空多出 --profile', () => {
    const args = requireHarness('claude-code').start!.args({ ...CTX, profile: 'desktop' });
    expect(args).toEqual([]);
    expect(args).not.toContain('--profile');
  });
});
