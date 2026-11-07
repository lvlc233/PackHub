import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/index.ts';
import { requireInstance } from '../src/index.ts';
import {
  spawnPlanFor,
  startInstance,
  startInstanceDetailed,
  stopInstance,
  refreshStatuses,
  type SpawnFn,
} from '../src/start.ts';
import { isPalError } from '../src/errors.ts';
import { readSecrets } from '../src/secrets.ts';
import { resetHarnessCache } from '../src/harness.ts';

let tmp: string;

const MCP_PACK = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/mcp, version: 0.2.0, targets: [dsh] }
resources:
  - id: everything
    type: mcp
    source: npm:@modelcontextprotocol/server-everything@0.6.2
    transport: stdio
    config:
      command: npx
      args: ['-y', '@modelcontextprotocol/server-everything@0.6.2']
      env:
        ROOT: /srv/repo
`,
    'utf8',
  );
  return dir;
};

interface Seen {
  file?: string;
  args?: string[];
  options?: Record<string, unknown>;
}

/** 假宿主：把地址写进 PAL 交给它的日志 fd，然后假装一直在跑。 */
function fakeSpawn(seen: Seen, line: string, spawnPid = 9999): SpawnFn {
  return (file, args, options) => {
    seen.file = file;
    seen.args = args;
    seen.options = options as Record<string, unknown>;
    const stdio = options.stdio as Array<'ignore' | number> | undefined;
    const fd = Array.isArray(stdio) ? stdio[1] : undefined;
    if (typeof fd === 'number') writeSync(fd, line);
    return { pid: spawnPid, unref: () => {}, once: () => {} };
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-start-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  process.env.PACKHUB_HOME = join(tmp, 'home');
  // 用一个一定存在的命令当宿主，避开机器上装没装 dsh
  process.env.PAL_DSH_BIN = process.execPath;
  resetHarnessCache();
});

afterEach(() => {
  delete process.env.PACKHUB_INSTANCES;
  delete process.env.PACKHUB_HOME;
  delete process.env.PAL_DSH_BIN;
  resetHarnessCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('实例启动', () => {
  it('dsh 实例的技能装进实例自己的 home', async () => {
    const rec = await createInstance({ name: 'dsh-home', harness: 'dsh', packDir: 'examples/doc-review' });
    expect(rec.home).toBe(join(rec.root, 'home', 'dsh'));
    expect(existsSync(join(rec.root, 'home', 'dsh', 'skills', 'doc-review', 'SKILL.md'))).toBe(true);
  });

  it('直接 spawn：不拼 shell、日志走 fd、地址与端口落记录、凭据进 secrets.json', async () => {
    const inst = await createInstance({ name: 'dsh-run', harness: 'dsh', packDir: 'examples/doc-review' });
    const seen: Seen = {};
    const spawn = fakeSpawn(seen, 'dsh web: http://127.0.0.1:51234/?token=abc\n');

    const result = await startInstanceDetailed('dsh-run', {
      spawn,
      timeoutMs: 3000,
      isAlive: () => false,
      ownerOf: () => 4321,
    });

    // 不是 "命令 + 参数拼成一个字符串再交给 shell"
    expect(seen.args).not.toBe(seen.file);
    expect(Array.isArray(seen.args)).toBe(true);
    expect(seen.options?.cwd).toBe(inst.root);
    const env = seen.options?.env as NodeJS.ProcessEnv;
    expect(env.DSH_HOME).toBe(inst.home);
    expect(Array.isArray(seen.options?.stdio)).toBe(true);
    expect(typeof (seen.options?.stdio as unknown[])[1]).toBe('number');

    const record = result.record;
    expect(record.status).toBe('running');
    // pid 记的是真正在监听的那个，不是垫片进程
    expect(record.pid).toBe(4321);
    expect(record.port).toBe(51234);
    expect(record.ports).toEqual([51234]);
    // 记录与 API 里都不出现 token
    expect(record.url).toBe('http://127.0.0.1:51234/');
    expect(readFileSync(join(record.root, 'instance.json'), 'utf8')).not.toContain('abc');
    expect(readSecrets(record.root)).toEqual({ token: 'abc' });

    const stopped = await stopInstance('dsh-run', { kill: () => {}, isAlive: () => false });
    expect(stopped.status).toBe('stopped');
    expect(stopped.pid).toBeUndefined();
    expect(stopped.url).toBeUndefined();
    expect(readSecrets(record.root)).toEqual({});
  });

  it('dsh 的 MCP 资源写成 --patch 层，参数在启动前就带上', async () => {
    const inst = await createInstance({ name: 'with-mcp', harness: 'dsh', packDir: MCP_PACK(join(tmp, 'mcp-pack')) });
    const seen: Seen = {};
    const spawn = fakeSpawn(seen, 'listening on http://127.0.0.1:51235/\n');

    await startInstanceDetailed('with-mcp', {
      spawn,
      timeoutMs: 3000,
      isAlive: () => false,
      ownerOf: () => 4322,
    });

    const patch = join(inst.home!, 'pal-mcp.patch.yml');
    expect(existsSync(patch)).toBe(true);
    const text = readFileSync(patch, 'utf8');
    expect(text).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(text).toContain('serverName: "everything"');
    expect(text).toContain('command: "npx"');
    expect(text).toContain('ROOT: "/srv/repo"');
    expect(seen.args).toContain('--patch');
    expect(seen.args?.[seen.args.indexOf('--patch') + 1]).toBe(patch);
    // --patch 必须排在 web 子命令的参数之前
    expect(seen.args!.indexOf('--patch')).toBeLessThan(seen.args!.indexOf('--no-open'));
  });

  it('已经在跑就不再起第二个', async () => {
    const rec = await createInstance({ name: 'twice', harness: 'dsh', packDir: 'examples/doc-review' });
    const seen: Seen = {};
    await startInstance('twice', {
      spawn: fakeSpawn(seen, 'http://127.0.0.1:51236/\n'),
      timeoutMs: 3000,
      isAlive: () => false,
      ownerOf: () => 555,
    });
    expect(requireInstance('twice').pid).toBe(555);

    let caught: unknown;
    try {
      await startInstance(rec.id, { spawn: fakeSpawn(seen, ''), isAlive: () => true });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('already-running');
  });

  it('没有常驻服务的宿主直接给能力说明，不是让它起不来', async () => {
    const rec = await createInstance({
      name: 'claude-home',
      harness: 'claude-code',
      packDir: (() => {
        const dir = join(tmp, 'cc-pack');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'packhub.yaml'),
          `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/cc, version: 0.1.0, targets: [claude-code] }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`,
          'utf8',
        );
        writeFileSync(join(dir, 'rules.md'), '# r\n', 'utf8');
        return dir;
      })(),
    });
    let caught: unknown;
    try {
      await startInstance(rec.id, { spawn: fakeSpawn({}, ''), isAlive: () => false });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('not-startable');
    expect((caught as Error).message).toContain('Claude Code');
  });

  it('等不到地址时把日志尾部贴进错误，并把实例标成异常', async () => {
    const inst = await createInstance({ name: 'slow', harness: 'dsh', packDir: 'examples/doc-review' });
    const spawn = fakeSpawn({}, 'booting the harness...\n');
    let caught: unknown;
    try {
      await startInstance('slow', { spawn, timeoutMs: 250, isAlive: () => false, pollMs: 20 });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('start-failed');
    expect((caught as { hint?: string }).hint).toContain('booting the harness');
    const after = requireInstance(inst.id);
    expect(after.status).toBe('broken');
    expect(after.lastError?.code).toBe('start-failed');
  });

  it('进程已经不在的记录会被刷新成异常，不会一直显示在跑', async () => {
    const rec = await createInstance({ name: 'stale', harness: 'dsh', packDir: 'examples/doc-review' });
    writeFileSync(
      join(rec.root, 'instance.json'),
      JSON.stringify({ ...requireInstance(rec.id), status: 'running', pid: 777777, port: 1 }, null, 2),
      'utf8',
    );
    const rows = refreshStatuses(() => false);
    expect(rows.find((row) => row.id === rec.id)?.status).toBe('broken');
    expect(rows.find((row) => row.id === rec.id)?.pid).toBeUndefined();
  });

  it('linux/win 的垫片都认得：.cmd 走 cmd，普通可执行文件直起', () => {
    const direct = spawnPlanFor('/usr/local/bin/dsh', ['--profile', 'web']);
    expect(direct.file).toBe('/usr/local/bin/dsh');
    expect(direct.args).toEqual(['--profile', 'web']);
    expect(direct.verbatim).toBe(false);

    const shim = spawnPlanFor('C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd', ['--profile', 'web', '--port', '5123']);
    expect(shim.verbatim).toBe(true);
    expect(shim.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(shim.args[3]).toContain('--port');
  });
});
