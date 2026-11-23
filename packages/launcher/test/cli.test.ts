import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { harnessIds } from '@packhub/kernel';
import { main } from '../src/cli.ts';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

/** 只读命令定义，不执行 run：不写盘、不起进程、不碰网络。 */
interface CommandShape {
  args?: Record<string, { type?: string; default?: unknown; description?: string } | undefined>;
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

describe('pal cli：实例形态是 --kind（不再有 --harness）', () => {
  // create 只建宿主实例（默认 dsh）；adopt 接管已有目录，dir 是它的形态值
  for (const name of ['create', 'adopt']) {
    it(`${name} 声明 --kind（string，默认 dsh）`, () => {
      const command = subCommands[name];
      expect(command, `${name} 应存在`).toBeTruthy();
      expect(command?.args?.kind?.type, `${name} --kind 类型`).toBe('string');
      expect(command?.args?.kind?.default, `${name} --kind 默认值`).toBe('dsh');
      // 旧的 --harness 参数应该已经删掉，不然两份参数会各说各话
      expect(command?.args?.harness).toBeUndefined();
    });
  }
});

describe('pal cli：harness 列表六项', () => {
  const SIX = ['dsh', 'claude-code', 'codex', 'opencode', 'workbody', 'hermes'];

  it('注册表就是六个宿主（顺序稳定）', () => {
    expect(harnessIds()).toEqual(SIX);
  });

  it('create / adopt 的 --kind 说明列出六个宿主', () => {
    for (const name of ['create', 'adopt']) {
      const description = String(subCommands[name]?.args?.kind?.description ?? '');
      for (const id of SIX) {
        expect(description, `${name} 的 --kind 应列出 ${id}`).toContain(id);
      }
    }
  });

  it('install 的 --harness 说明列出六个宿主，并说明不用 dir', () => {
    const description = String(subCommands.install?.args?.harness?.description ?? '');
    for (const id of SIX) {
      expect(description, `install --harness 应列出 ${id}`).toContain(id);
    }
    expect(description).toContain('不用 dir');
  });
});

describe('pal --version', () => {
  it('meta.version 与 package.json 一致（唯一来源）', () => {
    expect((main as unknown as { meta: { version?: string } }).meta.version).toBe(packageJson.version);
  });
});

describe('pal 命令面：doctor 并入 health --hosts，audit 归 pal', () => {
  it('一共 32 条命令：没有 status / recover / doctor，有 leftovers', () => {
    const names = Object.keys(subCommands);
    expect(names).toHaveLength(32);
    expect(new Set(names).size).toBe(32);
    // status 合并进 ps（默认纯读，--refresh 才刷新）；recover 改名 leftovers
    expect(names).not.toContain('status');
    expect(names).not.toContain('recover');
    expect(names).not.toContain('doctor');
    expect(names).toContain('leftovers');
    expect(names).toContain('ps');
    // 目录对象命令仍是一级命令
    for (const name of ['install', 'uninstall', 'verify', 'rollback', 'update']) {
      expect(names.includes(name), `${name} 应存在`).toBe(true);
    }
  });

  it('doctor 不再是命令；health 声明 --hosts；audit 是根命令', () => {
    expect(subCommands.doctor, 'doctor 应已并入 health --hosts').toBeUndefined();
    expect(subCommands.health?.args?.hosts?.type).toBe('boolean');
    expect(subCommands.health?.args?.hosts?.default).toBe(false);
    expect(subCommands.audit, 'audit 应是根命令').toBeTruthy();
    expect(subCommands.audit?.args?.json?.type).toBe('boolean');
    expect(subCommands.audit?.args?.tail?.default).toBe('20');
  });

  interface HealthShape {
    run: (ctx: { args: Record<string, unknown> }) => Promise<void>;
  }

  /** 在隔离的 PAL 数据目录里跑一次 health：不读也不写用户自己的实例。 */
  async function healthRun(args: Record<string, unknown>): Promise<string[]> {
    const home = mkdtempSync(join(tmpdir(), 'pal-health-home-'));
    const beforeHome = process.env.PACKHUB_HOME;
    const beforeInstances = process.env.PACKHUB_INSTANCES;
    process.env.PACKHUB_HOME = home;
    process.env.PACKHUB_INSTANCES = join(home, 'instances');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      lines.push(String(line));
    });
    try {
      await (subCommands.health as unknown as HealthShape).run({ args });
    } finally {
      spy.mockRestore();
      if (beforeHome === undefined) delete process.env.PACKHUB_HOME;
      else process.env.PACKHUB_HOME = beforeHome;
      if (beforeInstances === undefined) delete process.env.PACKHUB_INSTANCES;
      else process.env.PACKHUB_INSTANCES = beforeInstances;
      rmSync(home, { recursive: true, force: true });
    }
    return lines;
  }

  it('health --hosts 文本：先打宿主段，再打实例段', async () => {
    const text = (await healthRun({ hosts: true, json: false })).join('\n');
    expect(text.split('\n')[0]).toBe('宿主：');
    expect(text).toContain(
      `  运行时：node ${process.version} (${process.platform}-${process.arch})，pal ${packageJson.version}`,
    );
    expect(text).toContain('  数据目录：');
    expect(text).toContain('实例：');
  });

  it('health --hosts --json：runtime / hosts / instances 三段', async () => {
    const lines = await healthRun({ hosts: true, json: true });
    const payload = JSON.parse(lines.join('\n')) as {
      runtime?: { node?: string; platform?: string; arch?: string; pal?: string; home?: string };
      hosts?: { id?: string; available?: boolean; startable?: boolean }[];
      instances?: unknown[];
    };
    expect(Object.keys(payload).sort()).toEqual(['hosts', 'instances', 'runtime']);
    expect(payload.runtime).toMatchObject({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pal: packageJson.version,
    });
    expect(payload.runtime?.home).toEqual(expect.any(String));
    expect(Array.isArray(payload.hosts)).toBe(true);
    expect(payload.hosts!.length).toBeGreaterThan(0);
    for (const host of payload.hosts!) {
      expect(typeof host.id).toBe('string');
      expect(typeof host.available).toBe('boolean');
      expect(typeof host.startable).toBe('boolean');
    }
    expect(payload.instances).toEqual([]);
  });
});


