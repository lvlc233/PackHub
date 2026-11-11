import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VerifyCheck } from '@packhub/kernel';
import { runChecks } from '../src/index.ts';

async function check(root: string, c: VerifyCheck) {
  return (await runChecks([c], { root }))[0]!;
}

describe('verify 的 config-key 检查', () => {
  it('JSON 的嵌套键按点路径取，值与 equals 相等才算过', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packhub-cfgkey-'));
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ mcpServers: { lint: { command: 'npx', args: ['-y'] } } }),
      'utf8',
    );

    const pass = await check(root, {
      type: 'config-key',
      path: 'config.json',
      key: 'mcpServers.lint.command',
      equals: 'npx',
    });
    expect(pass.status).toBe('pass');

    const wrong = await check(root, {
      type: 'config-key',
      path: 'config.json',
      key: 'mcpServers.lint.command',
      equals: 'node',
    });
    expect(wrong.status).toBe('fail');
    expect(wrong.detail).toContain('期望');
    expect(wrong.detail).toContain('npx');

    rmSync(root, { recursive: true, force: true });
  });

  it('不写 equals 只看键在不在；null 与 false 都算「在」', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packhub-cfgkey-'));
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ hooks: { onSave: null }, enabled: false }),
      'utf8',
    );

    expect((await check(root, { type: 'config-key', path: 'config.json', key: 'hooks.onSave' })).status).toBe('pass');
    expect((await check(root, { type: 'config-key', path: 'config.json', key: 'enabled', equals: false })).status).toBe('pass');

    const missing = await check(root, { type: 'config-key', path: 'config.json', key: 'hooks.onExit' });
    expect(missing.status).toBe('fail');
    expect(missing.detail).toContain('缺少键');

    rmSync(root, { recursive: true, force: true });
  });

  it('YAML 配置也能读；文件不存在与路径越界都是 fail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packhub-cfgkey-'));
    writeFileSync(join(root, 'config.yaml'), 'app:\n  flavor: vanilla\n', 'utf8');

    expect(
      (await check(root, { type: 'config-key', path: 'config.yaml', key: 'app.flavor', equals: 'vanilla' })).status,
    ).toBe('pass');

    const absent = await check(root, { type: 'config-key', path: 'nope.json', key: 'a.b' });
    expect(absent.status).toBe('fail');
    expect(absent.detail).toContain('配置文件不存在');

    const escape = await check(root, { type: 'config-key', path: '../outside.json', key: 'a' });
    expect(escape.status).toBe('fail');
    expect(escape.detail).toContain('越界');

    rmSync(root, { recursive: true, force: true });
  });
});
