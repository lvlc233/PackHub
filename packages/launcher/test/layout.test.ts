import { describe, expect, it } from 'vitest';
import { parseStartUrl, targetVarsFor } from '../src/layout.ts';

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
});
