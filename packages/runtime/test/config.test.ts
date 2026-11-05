import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, defaultRegistryIndex } from '../src/index.ts';

const dirs: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-cfg-'));
  dirs.push(dir);
  process.env.PACKHUB_HOME = dir;
  return dir;
}

afterEach(() => {
  delete process.env.PACKHUB_HOME;
  delete process.env.PACKHUB_INDEX;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('默认 registry 配置', () => {
  it('PACKHUB_INDEX 优先于配置文件', () => {
    const dir = home();
    writeFileSync(
      configPath(),
      JSON.stringify({ registries: [{ name: 'corp', url: 'https://corp/index.json' }], defaultRegistry: 'corp' }),
      'utf8',
    );
    expect(defaultRegistryIndex()).toBe('https://corp/index.json');
    process.env.PACKHUB_INDEX = 'https://env/index.json';
    expect(defaultRegistryIndex()).toBe('https://env/index.json');
  });

  it('只有一个 registry 时直接用它；没有就返回 undefined', () => {
    const dir = home();
    expect(defaultRegistryIndex()).toBeUndefined();
    writeFileSync(
      configPath(),
      JSON.stringify({ registries: [{ name: 'only', url: 'https://only/index.json' }] }),
      'utf8',
    );
    expect(defaultRegistryIndex()).toBe('https://only/index.json');
    // 只读：读配置不会在 home 里多写出别的文件
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  it('坏配置按空处理，不炸', () => {
    home();
    writeFileSync(configPath(), '{not json', 'utf8');
    expect(defaultRegistryIndex()).toBeUndefined();
  });
});
