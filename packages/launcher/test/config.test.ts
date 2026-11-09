import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_VERSION, parseIsolationSpec, readPalConfig, writePalConfig, type PalConfig } from '../src/config.ts';
import { DEFAULT_ISOLATION, ISOLATION_LAYERS, type Isolation } from '../src/isolation.ts';
import { palConfigFile } from '../src/paths.ts';
import { isPalError, type PalError } from '../src/errors.ts';

/**
 * 全局配置只落在 PACKHUB_HOME 下：每个用例一个临时 home，
 * 绝不碰开发机上真实的 ~/.packhub/config.json。
 */
let tmp: string;
let home: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-config-'));
  home = join(tmp, 'home');
  process.env.PACKHUB_HOME = home;
});

afterEach(() => {
  delete process.env.PACKHUB_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * 和默认值处处相反、但凭据仍是 instance：这是当前唯一能写进 config 的「反向」策略，
 * 用来看出覆盖有没有落盘。凭据 shared 尚未实现，是拒绝用例，不能进合法样本。
 */
const OPPOSITE: Isolation = {
  version: 1,
  layers: { assembly: 'shared', session: 'shared', credentials: 'instance', cache: 'instance', runtime: 'instance' },
};

/** 只把凭据层改成 shared：写 config 时必须在落盘前被拒。 */
const CREDENTIALS_SHARED: Isolation = {
  version: 1,
  layers: { ...DEFAULT_ISOLATION.layers, credentials: 'shared' },
};

function expectPalError(fn: () => unknown): PalError {
  try {
    fn();
  } catch (err) {
    expect(isPalError(err)).toBe(true);
    return err as PalError;
  }
  throw new Error('应该抛错，但没有抛');
}

describe('配置文件位置', () => {
  it('落在 <PACKHUB_HOME>/config.json', () => {
    expect(palConfigFile()).toBe(join(home, 'config.json'));
  });
});

describe('读配置', () => {
  it('文件不存在：用内置默认；返回的是副本，改不到冻结的默认值', () => {
    expect(existsSync(palConfigFile())).toBe(false);
    const config = readPalConfig();
    expect(config).toEqual({ version: CONFIG_VERSION, isolation: DEFAULT_ISOLATION });
    expect(config.isolation).not.toBe(DEFAULT_ISOLATION);
    expect(config.isolation.layers).not.toBe(DEFAULT_ISOLATION.layers);

    // 调用方能就地改自己的那份，但改不到 DEFAULT_ISOLATION，也污染不了下一次读
    config.isolation.layers.cache = 'instance';
    expect(DEFAULT_ISOLATION.layers.cache).toBe('shared');
    expect(readPalConfig().isolation).toEqual(DEFAULT_ISOLATION);
  });

  it('坏 JSON：invalid-input，message 带路径与原因，hint 给修法', () => {
    mkdirSync(home, { recursive: true });
    const file = palConfigFile();
    writeFileSync(file, '{ "version": 1, ', 'utf8');

    const err = expectPalError(() => readPalConfig());
    expect(err.code).toBe('invalid-input');
    expect(err.message).toContain('配置文件读不了');
    expect(err.message).toContain(file);
    expect(err.message).toContain('JSON');
    expect(err.hint).toBeTruthy();
    expect(err.details?.file).toBe(file);
  });

  it('版本不对、结构不对、isolation 不合法都报错，绝不静默回落默认', () => {
    mkdirSync(home, { recursive: true });
    const file = palConfigFile();
    const cases: [string, string][] = [
      ['版本不对', JSON.stringify({ version: 2, isolation: DEFAULT_ISOLATION })],
      ['缺版本', JSON.stringify({ isolation: DEFAULT_ISOLATION })],
      ['缺 isolation', JSON.stringify({ version: 1 })],
      ['isolation 缺层', JSON.stringify({ version: 1, isolation: { version: 1, layers: { assembly: 'instance' } } })],
      [
        'isolation 模式不认识',
        JSON.stringify({
          version: 1,
          isolation: { version: 1, layers: { ...DEFAULT_ISOLATION.layers, cache: 'link' } },
        }),
      ],
      ['顶层不是对象', '[]'],
      ['顶层是 null', 'null'],
    ];
    for (const [label, text] of cases) {
      writeFileSync(file, text, 'utf8');
      const err = expectPalError(() => readPalConfig());
      expect(err.code, label).toBe('invalid-input');
      // 路径必须在 message 里：排查时用户得知道改哪个文件
      expect(err.message, label).toContain(file);
      expect(err.hint, label).toBeTruthy();
    }
  });
});

describe('写配置', () => {
  it('写进去再读回来是同一条策略；目录不存在会建出来，不留临时文件', () => {
    expect(existsSync(home)).toBe(false);
    const written = writePalConfig({ version: CONFIG_VERSION, isolation: OPPOSITE });
    expect(written.isolation).toEqual(OPPOSITE);
    expect(readPalConfig().isolation).toEqual(OPPOSITE);

    const onDisk = JSON.parse(readFileSync(palConfigFile(), 'utf8')) as PalConfig;
    expect(onDisk).toEqual({ version: CONFIG_VERSION, isolation: OPPOSITE });
    // 原子写：临时文件已经 rename 掉了，不留在 home 里
    expect(readdirSync(home).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('写盘用的是副本：改传进去的对象、改读回来的对象，都不影响文件与默认值', () => {
    const input: PalConfig = {
      version: CONFIG_VERSION,
      isolation: { version: 1, layers: { ...DEFAULT_ISOLATION.layers, cache: 'instance' } },
    };
    writePalConfig(input);

    // 写完之后改输入：文件已经是快照，不跟着变
    input.isolation.layers.cache = 'shared';
    expect(readPalConfig().isolation.layers.cache).toBe('instance');

    // 读出来的那份同理：改它不回写文件
    const first = readPalConfig();
    first.isolation.layers.runtime = 'instance';
    expect(readPalConfig().isolation.layers.runtime).toBe('shared');

    // 全程没碰过冻结的默认值
    expect(DEFAULT_ISOLATION.layers.cache).toBe('shared');
    expect(DEFAULT_ISOLATION.layers.runtime).toBe('shared');
    expect(Object.isFrozen(DEFAULT_ISOLATION)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ISOLATION.layers)).toBe(true);
  });

  it('落盘前校验：版本或 isolation 不合法就拒绝，且不留文件', () => {
    const badVersion = { version: 2, isolation: DEFAULT_ISOLATION } as unknown as PalConfig;
    expectPalError(() => writePalConfig(badVersion));
    expect(existsSync(palConfigFile())).toBe(false);

    const badIsolation = {
      version: CONFIG_VERSION,
      isolation: { version: 1, layers: { ...DEFAULT_ISOLATION.layers, cache: 'nope' } },
    } as unknown as PalConfig;
    expectPalError(() => writePalConfig(badIsolation));
    expect(existsSync(palConfigFile())).toBe(false);
  });

  it('未实现的策略（credentials=shared）写盘前就拒绝，原文件逐字节不变；合法配置照旧能写', () => {
    // 先落一份合法配置当基线
    writePalConfig({ version: CONFIG_VERSION, isolation: OPPOSITE });
    const before = readFileSync(palConfigFile());

    const err = expectPalError(() => writePalConfig({ version: CONFIG_VERSION, isolation: CREDENTIALS_SHARED }));
    expect(err.code).toBe('invalid-input');
    // 说的是「还没实现什么」以及怎么改，不是「文件写不进去」
    expect(err.message).toContain('shared-ro');
    expect(err.hint).toContain('credentials=instance');
    // message 不回显路径：pal config 自己会报文件名，错误文案不重复它
    expect(err.message).not.toContain(home);
    expect(err.message).not.toContain(palConfigFile());

    // 原文件一个字节没动，也没留下临时文件或半份 JSON
    expect(readFileSync(palConfigFile()).equals(before)).toBe(true);
    expect(readdirSync(home).filter((name) => name.includes('.tmp'))).toEqual([]);

    // 合法配置仍可写（拒绝只针对没实现的语义）
    const written = writePalConfig({ version: CONFIG_VERSION, isolation: DEFAULT_ISOLATION });
    expect(written.isolation).toEqual(DEFAULT_ISOLATION);
    expect(readPalConfig().isolation).toEqual(DEFAULT_ISOLATION);
  });
});

describe('--isolation 写法', () => {
  it('只覆盖写出来的层，其余沿用 base；base 不会被改', () => {
    const parsed = parseIsolationSpec('cache=instance', DEFAULT_ISOLATION);
    expect(parsed).toEqual({
      version: 1,
      layers: { ...DEFAULT_ISOLATION.layers, cache: 'instance' },
    });
    expect(parsed).not.toBe(DEFAULT_ISOLATION);
    expect(parsed.layers).not.toBe(DEFAULT_ISOLATION.layers);
    expect(DEFAULT_ISOLATION.layers.cache).toBe('shared');

    const multi = parseIsolationSpec('assembly=shared, runtime=instance', DEFAULT_ISOLATION);
    expect(multi.layers).toEqual({
      assembly: 'shared',
      session: 'instance',
      credentials: 'instance',
      cache: 'shared',
      runtime: 'instance',
    });

    // 空格容忍；base 里没写的层保持 base 的值
    const fromBase = parseIsolationSpec(' session = shared ', DEFAULT_ISOLATION);
    expect(fromBase.layers).toEqual({ ...DEFAULT_ISOLATION.layers, session: 'shared' });
  });

  it('未知层名、未知模式、重复项、空项都报 invalid-input 并列出可选值', () => {
    const cases: [string, RegExp][] = [
      ['nope=shared', /没有这一层：nope/],
      ['cache=link', /没有这个模式：link/],
      ['cache=shared,cache=instance', /写了两次：cache/],
      ['cache=shared,', /空项/],
      ['cache=shared,,session=shared', /空项/],
      ['', /没有内容/],
      ['cache', /不是 layer=mode/],
      ['=shared', /缺层名/],
      ['cache=', /缺模式/],
    ];
    for (const [text, pattern] of cases) {
      const err = expectPalError(() => parseIsolationSpec(text, DEFAULT_ISOLATION));
      expect(err.code, text).toBe('invalid-input');
      expect(err.message, text).toMatch(pattern);
      expect(err.hint, text).toBeTruthy();
    }

    // 可选值必须写全：用户照着 hint 就能改对
    const layerErr = expectPalError(() => parseIsolationSpec('nope=shared', DEFAULT_ISOLATION));
    for (const layer of ISOLATION_LAYERS) expect(layerErr.hint).toContain(layer);
    const modeErr = expectPalError(() => parseIsolationSpec('cache=link', DEFAULT_ISOLATION));
    expect(modeErr.hint).toContain('instance');
    expect(modeErr.hint).toContain('shared');
  });
});
