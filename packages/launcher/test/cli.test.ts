import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.ts';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

/** 只读命令定义，不执行 run：不写盘、不起进程、不碰网络。 */
interface CommandShape {
  args?: Record<string, { type?: string; default?: unknown } | undefined>;
  subCommands?: Record<string, CommandShape | undefined>;
}

const subCommands = (main as unknown as CommandShape).subCommands ?? {};

describe('pal cli --json', () => {
  for (const name of ['show', 'rename', 'migrate', 'use', 'current']) {
    it(`${name} 声明 --json（boolean，默认 false）`, () => {
      const command = subCommands[name];
      expect(command, `${name} 应存在`).toBeTruthy();
      const json = command?.args?.json;
      expect(json?.type, `${name} --json 类型`).toBe('boolean');
      expect(json?.default, `${name} --json 默认值`).toBe(false);
    });
  }
});

describe('pal --version', () => {
  it('meta.version 与 package.json 一致（唯一来源）', () => {
    expect((main as unknown as { meta: { version?: string } }).meta.version).toBe(packageJson.version);
  });
});

describe('pal doctor 报告运行时（A11）', () => {
  /** 只跑 run 的第一行/JSON 段：probe=false 不 spawn 宿主，discoverAll 只查路径。 */
  const doctor = subCommands.doctor as unknown as {
    run: (ctx: { args: Record<string, unknown> }) => void;
  };

  function capture(json: boolean): string {
    const out: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      out.push(String(line));
    });
    try {
      doctor.run({ args: { probe: false, json } });
    } finally {
      spy.mockRestore();
    }
    return out.join('\n');
  }

  it('文本第一行是运行时：node 版本、平台、pal 版本', () => {
    const text = capture(false);
    expect(text.split('\n')[0]).toBe(
      `运行时：node ${process.version} (${process.platform}-${process.arch})，pal ${packageJson.version}`,
    );
  });

  it('--json 顶层带 runtime 段（含数据目录），宿主清单在 hosts 下', () => {
    const payload = JSON.parse(capture(true)) as {
      runtime?: { node?: string; platform?: string; arch?: string; pal?: string; home?: string };
      hosts?: unknown[];
    };
    expect(payload.runtime).toMatchObject({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pal: packageJson.version,
    });
    expect(payload.runtime?.home).toEqual(expect.any(String));
    expect(Array.isArray(payload.hosts)).toBe(true);
  });
});

