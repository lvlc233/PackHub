import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/index.ts';
import { startInstance, stopInstance } from '../src/start.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-start-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
});

afterEach(() => {
  delete process.env.PACKHUB_INSTANCES;
  rmSync(tmp, { recursive: true, force: true });
});

describe('实例启动', () => {
  it('dsh 实例的技能装进实例自己的 home', async () => {
    const rec = await createInstance({ name: 'dsh-home', harness: 'dsh', packDir: 'examples/doc-review' });
    expect(rec.home).toBe(join(rec.root, 'home', 'dsh'));
    expect(existsSync(join(rec.root, 'home', 'dsh', 'skills', 'doc-review', 'SKILL.md'))).toBe(true);
  });

  it('start 从日志里拿到地址与端口，stop 清掉运行信息', async () => {
    const inst = await createInstance({ name: 'dsh-run', harness: 'dsh', packDir: 'examples/doc-review' });
    const logPath = join(inst.root, 'logs', 'start.log');
    let seen: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
    const spawn = ((_cmd: string, _args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      seen = options;
      writeFileSync(logPath, 'dsh web: http://127.0.0.1:51234/?token=abc\n', 'utf8');
      return { pid: 4321, unref: () => {} };
    }) as never;

    const running = await startInstance('dsh-run', { spawn, timeoutMs: 2000, isAlive: () => false });

    expect(running.status).toBe('running');
    expect(running.pid).toBe(4321);
    expect(running.port).toBe(51234);
    expect(running.url).toBe('http://127.0.0.1:51234/?token=abc');
    expect(seen?.cwd).toBe(inst.root);
    expect(seen?.env?.DSH_HOME).toBe(inst.home);

    const stopped = stopInstance('dsh-run', { kill: () => {} });
    expect(stopped.status).toBe('stopped');
    expect(stopped.pid).toBeUndefined();
    expect(stopped.url).toBeUndefined();
  });
});
