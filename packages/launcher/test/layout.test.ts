import { describe, expect, it } from 'vitest';
import { ADAPTERS, dshStartArgs, parseStartUrl, targetVarsFor, type HarnessAdapter } from '../src/layout.ts';

const CTX = { port: 51_234, root: 'G:/tmp/pal-instance' };

describe('宿主适配', () => {
  it('dsh 的资源落进实例自己的 home', () => {
    expect(targetVarsFor('dsh')).toMatchObject({
      skillsDir: 'home/dsh/skills',
      knowledgeDir: 'home/dsh/knowledge',
    });
    expect(targetVarsFor('dir')).toBeUndefined();
  });

  it('从启动输出里取地址与端口', () => {
    expect(parseStartUrl('dsh web: http://127.0.0.1:55860/?token=x', 'dsh')).toEqual({
      url: 'http://127.0.0.1:55860/?token=x',
      port: 55860,
    });
    expect(parseStartUrl('nothing here', 'dsh')).toBeUndefined();
  });

  it('dsh 的启动参数用适配表的 startProfile 拼出 --profile web', () => {
    // 生产代码（start.ts）走的就是 adapter.start.args
    const args = ADAPTERS.dsh.start!.args(CTX);
    expect(args).toEqual(['--profile', 'web', '--no-open', '--port', '51234']);
  });

  it('适配器没有 startProfile 时就不带 --profile', () => {
    // 临时适配器只改 startProfile，不真起进程
    const bare: HarnessAdapter = { label: 'dsh', startProfile: undefined };
    const args = dshStartArgs(CTX, bare);
    expect(args).not.toContain('--profile');
    expect(args).toEqual(['--no-open', '--port', '51234']);
  });
});
