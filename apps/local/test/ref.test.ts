import { describe, expect, it } from 'vitest';
import { formatPackRef, parsePackRef } from '../src/ref.ts';

describe('name@version 只在一个地方解析', () => {
  it.each([
    ['demo/pack@1.2.3', { name: 'demo/pack', version: '1.2.3' }],
    ['@scope/pack@0.0.1', { name: '@scope/pack', version: '0.0.1' }],
    ['pack@0.1.0-beta.1', { name: 'pack', version: '0.1.0-beta.1' }],
  ])('%s 拆成 name 与 version', (ref, expected) => {
    expect(parsePackRef(ref)).toEqual(expected);
  });

  it.each(['noversion', '@1.0.0', 'name@', '@', ''])('%s 缺包名或缺版本 → undefined', (ref) => {
    expect(parsePackRef(ref)).toBeUndefined();
  });

  it('拼回去与拆开是一对互逆操作', () => {
    const ref = parsePackRef('lvlc233/team-conventions@0.0.2');
    expect(ref).toBeDefined();
    expect(formatPackRef(ref!)).toBe('lvlc233/team-conventions@0.0.2');
  });
});
