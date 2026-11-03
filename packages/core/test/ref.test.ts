import { describe, expect, it } from 'vitest';
import { checkSource, isVolatilePin, parseSource } from '../src/ref.ts';

describe('parseSource', () => {
  it('解析带版本的 npm 包（含 scope）', () => {
    const parsed = parseSource('npm:@modelcontextprotocol/server-everything@0.6.2');
    expect(parsed.kind).toBe('npm');
    expect(parsed.locator).toBe('npm:@modelcontextprotocol/server-everything');
    expect(parsed.pin).toBe('0.6.2');
  });

  it('解析不带版本的 npm 包', () => {
    const parsed = parseSource('npm:@scope/pkg');
    expect(parsed.locator).toBe('npm:@scope/pkg');
    expect(parsed.pin).toBeUndefined();
  });

  it('解析 github 子路径与 commit', () => {
    const parsed = parseSource('github:lvlc233/skill-hub/skills/code-review@9f2c1ab');
    expect(parsed.kind).toBe('github');
    expect(parsed.locator).toBe('github:lvlc233/skill-hub');
    expect(parsed.subpath).toBe('skills/code-review');
    expect(parsed.pin).toBe('9f2c1ab');
  });

  it('解析 packhub 引用与范围', () => {
    const parsed = parseSource('packhub://lvlc233/base-review@^0.3');
    expect(parsed.kind).toBe('packhub');
    expect(parsed.locator).toBe('packhub:lvlc233/base-review');
    expect(parsed.pin).toBe('^0.3');
  });

  it('识别本地与 https', () => {
    expect(parseSource('./resources/a.md').kind).toBe('local');
    expect(parseSource('https://example.com/a.md').kind).toBe('http');
  });

  it('拒绝无法识别的形态', () => {
    expect(() => parseSource('gitlab:foo/bar')).toThrow(/无法识别的 source/);
  });
});

describe('checkSource', () => {
  it('未锁 pin 报错，锁 main 也算未锁', () => {
    expect(checkSource(parseSource('npm:left-pad'), undefined, 'p')).toHaveLength(1);
    expect(isVolatilePin('main')).toBe(true);
    expect(checkSource(parseSource('github:a/b@main'), undefined, 'p')[0]?.code).toBe('unpinned-source');
  });

  it('https 缺 integrity 报错', () => {
    const issues = checkSource(parseSource('https://example.com/x.md'), undefined, 'p');
    expect(issues[0]?.code).toBe('http-missing-integrity');
  });

  it('已锁版本的 npm 无问题', () => {
    expect(checkSource(parseSource('npm:left-pad@1.3.0'), undefined, 'p')).toHaveLength(0);
  });
});
