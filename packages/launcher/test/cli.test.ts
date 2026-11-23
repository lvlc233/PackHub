import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { harnessIds } from '@packhub/kernel';
import { main } from '../src/cli.ts';
import { CORE_ENTRY } from '../src/coreEntry.ts';
import { installDir } from '../src/dirCommands.ts';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

/** 只读命令定义，不执行 run：不写盘、不起进程、不碰网络。 */
interface CommandShape {
  args?: Record<
    string,
    { type?: string; default?: unknown; description?: string; required?: boolean } | undefined
  >;
  subCommands?: Record<string, CommandShape | undefined>;
}

const subCommands = (main as unknown as CommandShape).subCommands ?? {};

describe('pal cli --json', () => {
  for (const name of ['show', 'config', 'migrate', 'use', 'current']) {
    it(`${name} 声明 --json（boolean，默认 false）`, () => {
      const command = subCommands[name];
      expect(command, `${name} 应存在`).toBeTruthy();
      const json = command?.args?.json;
      expect(json?.type, `${name} --json 类型`).toBe('boolean');
      expect(json?.default, `${name} --json 默认值`).toBe(false);
    });
  }
});

describe('pal cli：target 统一后的参数面', () => {
  it('adopt 用 --host（必填、无默认），不再是 --kind / --harness', () => {
    const command = subCommands.adopt;
    expect(command, 'adopt 应存在').toBeTruthy();
    expect(command?.args?.host?.type, 'adopt --host 类型').toBe('string');
    expect(command?.args?.host?.default).toBeUndefined();
    expect(command?.args?.kind).toBeUndefined();
    expect(command?.args?.harness).toBeUndefined();
    expect(command?.args?.name?.required).toBeUndefined();
  });

  it('create 已删除', () => {
    expect(subCommands.create, 'create 应已并入 install 的默认 target').toBeUndefined();
  });

  it('install 声明 --host / --home / --project / --name；旧参数都不再声明', () => {
    const command = subCommands.install;
    expect(command, 'install 应存在').toBeTruthy();
    expect(command?.args?.host?.type).toBe('string');
    expect(command?.args?.home?.type).toBe('string');
    expect(command?.args?.project?.type).toBe('string');
    expect(command?.args?.name?.type).toBe('string');
    expect(command?.args?.source?.type).toBe('positional');
    for (const old of ['new', 'environment', 'harness', 'kind']) {
      expect(command?.args?.[old], `install 不该再声明 --${old}`).toBeUndefined();
    }
    // 改名后旧参数不再声明（旧名由 bin 在解析前拒绝）
    expect(command?.args?.into).toBeUndefined();
    expect(command?.args?.instance).toBeUndefined();
    // target 互斥的说明至少在一处写着
    const home = String(command?.args?.home?.description ?? '');
    expect(home).toContain('attached home');
  });

  it('uninstall / verify / rollback / update 都收 --home 与 --project，不再有 --environment / --dir', () => {
    for (const name of ['uninstall', 'verify', 'rollback', 'update']) {
      const command = subCommands[name];
      expect(command, `${name} 应存在`).toBeTruthy();
      expect(command?.args?.project?.type, `${name} --project`).toBe('string');
      expect(command?.args?.home?.type, `${name} --home`).toBe('string');
      for (const old of ['environment', 'dir', 'into', 'instance', 'harness', 'kind']) {
        expect(command?.args?.[old], `${name} 不该再有 --${old}`).toBeUndefined();
      }
    }
  });
});

describe('pal cli：harness 列表六项', () => {
  const SIX = ['dsh', 'claude-code', 'codex', 'opencode', 'workbody', 'hermes'];

  it('注册表就是六个宿主（顺序稳定）', () => {
    expect(harnessIds()).toEqual(SIX);
  });

  it('install / adopt 的 --host 说明列出六个宿主', () => {
    for (const name of ['install', 'adopt']) {
      const description = String(subCommands[name]?.args?.host?.description ?? '');
      for (const id of SIX) {
        expect(description, `${name} 的 --host 应列出 ${id}`).toContain(id);
      }
    }
  });
});

describe('installDir 的内部参数', () => {
  it('宿主参数叫 host；旧的 harness 键不再声明（内部命令不进 help）', () => {
    const args = (installDir as unknown as CommandShape).args ?? {};
    expect(args.host?.type).toBe('string');
    expect(args.harness).toBeUndefined();
    expect(args.source?.type).toBe('positional');
  });
});

describe('pal --version', () => {
  it('meta.version 与 package.json 一致（唯一来源）', () => {
    expect((main as unknown as { meta: { version?: string } }).meta.version).toBe(packageJson.version);
  });
});

describe('pal 命令面：25 条，诊断并进 flag', () => {
  it('一共 25 条命令：core / leftovers / audit / scan / cache / rebaseline / rename 都不是命令', () => {
    const names = Object.keys(subCommands);
    expect(names).toHaveLength(25);
    expect(new Set(names).size).toBe(25);
    // 历史入口：create → install 的默认 target；status → ps；doctor → health --hosts；recover → health --leftovers
    // 这一轮：leftovers / audit / scan / rebaseline / rename 并进 flag，core / cache 从 CLI 移除
    for (const removed of [
      'create',
      'status',
      'recover',
      'doctor',
      'watch',
      'core',
      'cache',
      'leftovers',
      'audit',
      'scan',
      'rebaseline',
      'rename',
    ]) {
      expect(names, `${removed} 不该是命令`).not.toContain(removed);
    }
    // core 的常驻进程还在，但只剩内部入口：它不是子命令
    expect(subCommands[CORE_ENTRY], `${CORE_ENTRY} 是内部入口，不是命令`).toBeUndefined();
    // 安装类命令仍是一级命令
    for (const name of ['install', 'uninstall', 'verify', 'rollback', 'update']) {
      expect(names.includes(name), `${name} 应存在`).toBe(true);
    }
  });

  it('被并进 flag 的诊断都是 boolean（默认 false），改名带 --name，list 的审计带 --tail', () => {
    expect(subCommands.health?.args?.leftovers?.type).toBe('boolean');
    expect(subCommands.health?.args?.leftovers?.default).toBe(false);
    expect(subCommands.list?.args?.history?.type).toBe('boolean');
    expect(subCommands.list?.args?.history?.default).toBe(false);
    expect(subCommands.list?.args?.tail?.default).toBe('20');
    expect(subCommands.adopt?.args?.scan?.type).toBe('boolean');
    expect(subCommands.adopt?.args?.scan?.default).toBe(false);
    expect(subCommands.verify?.args?.accept?.type).toBe('boolean');
    expect(subCommands.verify?.args?.accept?.default).toBe(false);
    expect(subCommands.config?.args?.name?.type).toBe('string');
    expect(subCommands.config?.args?.target?.type).toBe('positional');
    // 位参不再必填：adopt --scan 不带目录也能跑
    expect(subCommands.adopt?.args?.dir?.required).toBe(false);
  });

  it('doctor 不再是命令；health 声明 --hosts', () => {
    expect(subCommands.doctor, 'doctor 应已并入 health --hosts').toBeUndefined();
    expect(subCommands.health?.args?.hosts?.type).toBe('boolean');
    expect(subCommands.health?.args?.hosts?.default).toBe(false);
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


