import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ISOLATION,
  ISOLATION_LAYERS,
  parseIsolation,
  type Isolation,
  type IsolationMode,
} from '../src/isolation.ts';

/** 五层都填同一个模式。 */
function uniform(mode: IsolationMode): Isolation {
  return {
    version: 1,
    layers: { assembly: mode, session: mode, credentials: mode, cache: mode, runtime: mode },
  };
}

describe('隔离策略', () => {
  it('五层按固定顺序列出，默认值：装配/会话/凭据每实例，缓存/运行时共享', () => {
    expect(ISOLATION_LAYERS).toEqual(['assembly', 'session', 'credentials', 'cache', 'runtime']);
    expect(DEFAULT_ISOLATION).toEqual({
      version: 1,
      layers: {
        assembly: 'instance',
        session: 'instance',
        credentials: 'instance',
        cache: 'shared',
        runtime: 'shared',
      },
    });
  });

  it('默认值就地改不动', () => {
    expect(Object.isFrozen(DEFAULT_ISOLATION)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ISOLATION.layers)).toBe(true);
  });

  it('合法策略照原样解析，非默认组合也认', () => {
    expect(parseIsolation(DEFAULT_ISOLATION)).toEqual(DEFAULT_ISOLATION);
    expect(parseIsolation(uniform('shared'))).toEqual(uniform('shared'));
    expect(parseIsolation(uniform('instance'))).toEqual(uniform('instance'));
  });

  it('版本不对、缺层、值不对、非对象一律返回 undefined', () => {
    expect(parseIsolation({ ...uniform('instance'), version: 2 })).toBeUndefined();
    expect(parseIsolation({ ...uniform('instance'), version: '1' })).toBeUndefined();
    expect(parseIsolation({ version: 1 })).toBeUndefined();
    expect(parseIsolation({ version: 1, layers: null })).toBeUndefined();
    expect(parseIsolation({ version: 1, layers: 'shared' })).toBeUndefined();

    // 缺一层就不算合法：五层必须齐全
    expect(
      parseIsolation({
        version: 1,
        layers: { assembly: 'instance', session: 'instance', credentials: 'instance', cache: 'shared' },
      }),
    ).toBeUndefined();

    // 值不对：拼错的模式、布尔、null 都不行
    expect(parseIsolation({ version: 1, layers: { ...uniform('instance').layers, cache: 'Shared' } })).toBeUndefined();
    expect(parseIsolation({ version: 1, layers: { ...uniform('instance').layers, cache: true } })).toBeUndefined();
    expect(parseIsolation({ version: 1, layers: { ...uniform('instance').layers, cache: null } })).toBeUndefined();

    for (const bad of [undefined, null, 'shared', 1, [], [{ version: 1 }]]) {
      expect(parseIsolation(bad)).toBeUndefined();
    }
  });

  it('返回的是新副本：不存外部对象，之后改它也不影响结果', () => {
    const input = uniform('shared');
    const parsed = parseIsolation(input)!;
    expect(parsed).not.toBe(input);
    expect(parsed.layers).not.toBe(input.layers);
    // 解析结果与输入解耦：改输入的五层，结果不动
    input.layers.cache = 'instance';
    expect(parsed).toEqual(uniform('shared'));
    // 反过来也一样：改结果不回写输入
    parsed.layers.runtime = 'instance';
    expect(input.layers.runtime).toBe('shared');
  });
});
