import { describe, expect, it } from 'vitest';
import { HARNESSES } from '@packhub/kernel';
import { ADAPTERS, parseStartUrl, layoutVarsFor } from '../src/layout.ts';

const CTX = { port: 51_234, root: 'G:/tmp/pal-instance' };

describe('宿主适配', () => {
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

  it('dsh 的启动参数来自宿主表：--profile web → --patch → --no-open → --port', () => {
    // 启动模板只有一份（kernel 的 HARNESSES）；PAL 的适配器原样透传
    const start = HARNESSES.dsh.start!;
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
    expect(ADAPTERS.dsh.start).toBe(start);
  });

  it('只有能托管的宿主有启动模板；其余给能力说明而不是空模板', () => {
    expect(HARNESSES.dsh.start).toBeTruthy();
    expect(HARNESSES['claude-code'].start).toBeUndefined();
    expect(HARNESSES.codex.start).toBeUndefined();
    expect(HARNESSES['claude-code'].noStartReason).toContain('Claude Code');
    expect(HARNESSES.codex.noStartReason).toContain('Codex');
    expect(ADAPTERS['claude-code'].start).toBeUndefined();
    expect(ADAPTERS.codex.noStartReason).toBeTruthy();
  });
});
