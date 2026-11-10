import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import {
  HOME_SOURCE_LABEL,
  choosePalHome,
  homeHasData,
  locationFile,
  palHomeInfo,
  writeHomePointer,
} from '../src/paths.ts';

function choose(overrides: Partial<Parameters<typeof choosePalHome>[0]> = {}) {
  return choosePalHome({
    fallback: '/tmp/fallback',
    ...overrides,
  });
}

describe('数据目录的选择顺序', () => {
  it('PACKHUB_HOME 最优先，压过指针与便携', () => {
    const picked = choose({
      env: '/tmp/env-home',
      pointerHome: '/tmp/pointer-home',
      portable: '/tmp/app/data',
      portableWritable: true,
    });
    expect(picked).toEqual({ home: resolve('/tmp/env-home'), source: 'env' });
  });

  it('指针是绝对路径就当用户已选，压过便携', () => {
    const picked = choose({
      pointerHome: '/tmp/pointer-home',
      portable: '/tmp/app/data',
      portableWritable: true,
    });
    expect(picked).toEqual({ home: resolve('/tmp/pointer-home'), source: 'pointer' });
  });

  it('指针写坏了（相对路径 / 空串）当没设，继续往下走', () => {
    expect(choose({ pointerHome: 'relative/home' }).source).toBe('default');
    expect(choose({ pointerHome: '  ' }).source).toBe('default');
    expect(choose({ pointerHome: 'relative/home', portable: '/tmp/app/data', portableWritable: true }).source).toBe(
      'portable',
    );
  });

  it('没有手动选择、便携目录可写时，默认落在程序目录旁', () => {
    const picked = choose({ portable: '/tmp/app/data', portableWritable: true });
    expect(picked).toEqual({ home: resolve('/tmp/app/data'), source: 'portable' });
  });

  it('便携目录不可写时退到系统默认', () => {
    const picked = choose({ portable: '/tmp/app/data', portableWritable: false });
    expect(picked).toEqual({ home: resolve('/tmp/fallback'), source: 'default' });
  });

  it('每个来源都有可读的说明', () => {
    for (const source of ['env', 'pointer', 'portable', 'default'] as const) {
      expect(HOME_SOURCE_LABEL[source]).toBeTruthy();
    }
  });
});

describe('数据目录的真实解析与手动选择', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pal-home-'));
    process.env.PACKHUB_LOCATION_FILE = join(tmp, 'location.json');
    delete process.env.PACKHUB_HOME;
    delete process.env.PACKHUB_INSTANCES;
  });

  afterEach(() => {
    delete process.env.PACKHUB_LOCATION_FILE;
    delete process.env.PACKHUB_HOME;
    delete process.env.PACKHUB_INSTANCES;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('palHomeInfo 认 PACKHUB_HOME', () => {
    process.env.PACKHUB_HOME = join(tmp, 'env-home');
    expect(palHomeInfo()).toEqual({ home: resolve(join(tmp, 'env-home')), source: 'env' });
  });

  it('没有覆盖时落到系统默认，不再读 ~/.packhub', () => {
    const info = palHomeInfo();
    expect(info.source).toBe('default');
    if (process.platform === 'win32') {
      expect(info.home).toMatch(/[/\\]PackHub$/);
    } else {
      expect(info.home.endsWith('.packhub')).toBe(true);
    }
  });

  it('pal config --home 写下的指针，下一次解析就能读到', () => {
    const target = join(tmp, 'custom-data');
    const written = writeHomePointer(target);
    expect(written).toBe(resolve(target));
    // 指针目录本身被建出来，但实例目录还没建
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, 'instances'))).toBe(false);
    expect(JSON.parse(readFileSync(locationFile(), 'utf8'))).toEqual({ home: resolve(target) });
    expect(palHomeInfo()).toEqual({ home: resolve(target), source: 'pointer' });
  });

  it('指针只收绝对路径，也不收盘符根', () => {
    expect(() => writeHomePointer('relative/data')).toThrow('绝对路径');
    expect(() => writeHomePointer('')).toThrow('不能为空');
    const root = parse(process.cwd()).root;
    expect(() => writeHomePointer(root)).toThrow('盘符根');
  });

  it('homeHasData：只有点目录不算有数据，配置/实例/缓存/备份都算', () => {
    const home = join(tmp, 'has-data');
    expect(homeHasData(home)).toBe(false);
    mkdirSync(join(home, 'instances', '.links'), { recursive: true });
    expect(homeHasData(home)).toBe(false);
    mkdirSync(join(home, 'backups', 'one'), { recursive: true });
    expect(homeHasData(home)).toBe(true);

    const onlyConfig = join(tmp, 'only-config');
    mkdirSync(onlyConfig, { recursive: true });
    writeFileSync(join(onlyConfig, 'config.json'), '{}', 'utf8');
    expect(homeHasData(onlyConfig)).toBe(true);
  });
});
