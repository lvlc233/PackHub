import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * bin.ts 只在进程边界上可观察：自己解析 --version / --help，自己收错误。
 * 这些用例真起子进程跑它，看退出码与 stdout/stderr，不 import 内部实现。
 */
const run = promisify(execFile);

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
const launcherDir = fileURLToPath(new URL('..', import.meta.url));

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'pal-bin-'));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

/** 按用户实际敲命令的方式跑一遍；失败退出也是结果，不当作测试错误。 */
async function pal(...args: string[]): Promise<Outcome> {
  // vitest 把 NODE_ENV=test / TEST=true 写进了自己的环境；子进程继承后 citty 里的 consola 会静音，
  // --help 就一个字都打不出来。这里是「用户在普通 shell 里怎么跑 pal」，所以把测试标记摘掉。
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PACKHUB_HOME: home,
    PACKHUB_INSTANCES: join(home, 'instances'),
  };
  delete env.NODE_ENV;
  delete env.TEST;
  const options = { cwd: launcherDir, env, windowsHide: true };
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ['--experimental-strip-types', bin, ...args],
      options,
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failed = err as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === 'number' ? failed.code : -1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
  }
}

describe('pal bin --version', () => {
  it('只给 --version 时打印 package.json 的版本并退出 0', async () => {
    const result = await pal('--version');
    expect(result.code, `stderr：${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  }, 30_000);
});

describe('pal bin --help', () => {
  it('打印根命令用法（含 pal 与一级子命令 create）并退出 0', async () => {
    const result = await pal('--help');
    expect(result.code, `stderr：${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('pal');
    expect(result.stdout).toContain('create');
  }, 30_000);

  it('带子命令时打印那个子命令的用法', async () => {
    const result = await pal('create', '--help');
    expect(result.code, `stderr：${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('pal create');
    // pack 是位置参数，用法里以 <PACK> 出现
    expect(result.stdout).toContain('PACK');
  }, 30_000);
});

describe('pal bin 的错误展示', () => {
  it('普通失败：stderr 只给一行 x <message>，不带调用栈，退出 1', async () => {
    const result = await pal('show', 'nope');
    expect(result.code, `stderr：${result.stderr}`).toBe(1);
    expect(result.stderr).toMatch(/^x\s/m);
    // 堆栈行的特征是缩进后的 "at "；用户不该看到它
    expect(result.stderr).not.toContain('    at ');
  }, 30_000);

  it('invalid-input：带上 PalError 的 hint，退出 2，仍不打堆栈', async () => {
    const result = await pal('config', '--set-isolation', 'credentials=shared');
    expect(result.code, `stderr：${result.stderr}`).toBe(2);
    expect(result.stderr).toContain('credentials=instance');
    expect(result.stderr).not.toContain('    at ');
  }, 30_000);
});
