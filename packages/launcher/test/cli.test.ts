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

  it('--json 顶层带 runtime 段，宿主清单在 hosts 下', () => {
    const payload = JSON.parse(capture(true)) as {
      runtime?: { node?: string; platform?: string; arch?: string; pal?: string };
      hosts?: unknown[];
    };
    expect(payload.runtime).toEqual({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pal: packageJson.version,
    });
    expect(Array.isArray(payload.hosts)).toBe(true);
  });
});

describe('pal serve 的关闭入口（D7）', () => {
  it('声明 --exit-on-stdin-close（boolean，默认 false）', () => {
    const serve = subCommands.serve;
    expect(serve, 'serve 应存在').toBeTruthy();
    const flag = serve?.args?.['exit-on-stdin-close'];
    expect(flag?.type, '--exit-on-stdin-close 类型').toBe('boolean');
    expect(flag?.default, '--exit-on-stdin-close 默认值').toBe(false);
  });

  it('真起一个 serve：关掉 stdin 后自己退出 0，不用 taskkill', async () => {
    const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', bin, 'serve', '--port', '0', '--insecure', '--exit-on-stdin-close', '--json'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    try {
      // 先等它报出地址，确认 serve 真的起来了，再关 stdin
      await waitForUrl(child);
      child.stdin.end();
      const result = await waitForExit(child, 10_000);
      expect(result, '关掉 stdin 后进程应在 10s 内退出').not.toBeNull();
      expect(result?.code, `退出码（signal=${result?.signal ?? '-'}）`).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }, 30_000);
});

/** 等到 stdout 里出现 `{"url":"http://…"}` 那一行；stderr 留着，失败时能看出原因。 */
function waitForUrl(child: ChildProcess, ms = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`等 pal serve 报地址超时；stderr：${stderr}`)), ms);
    const finish = (err?: Error): void => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffered += chunk;
      for (const line of buffered.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const payload = JSON.parse(line) as { url?: unknown };
          if (typeof payload.url === 'string' && payload.url.startsWith('http')) {
            finish();
            return;
          }
        } catch {
          /* 还没收全，等下一块 */
        }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.once('exit', (code, signal) => {
      finish(new Error(`pal serve 在报地址前就退出了（code=${code}, signal=${signal}）；stderr：${stderr}`));
    });
  });
}

/** 等进程退出；到点返回 null（调用方自己判断是失败）。 */
function waitForExit(
  child: ChildProcess,
  ms: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
