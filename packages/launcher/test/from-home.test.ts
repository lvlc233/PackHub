import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerHarness } from '@packhub/kernel';
import { createInstance } from '../src/index.ts';
import { isPalError } from '../src/errors.ts';

const PACK = 'test/fixtures/packs/doc-review';

/**
 * 临时注册的测试宿主：只为了验证 --from-home 的复制逻辑。
 * 不改真实宿主模块——credentialFiles 是宿主注册项的一部分，测试可以自己登记一个。
 */
registerHarness({
  id: 'testcred',
  label: 'testcred',
  layout: { skillsDir: '.testcred/skills', configFile: '.testcred/config.json', instructionFile: 'AGENTS.md' },
  home: { dir: 'home/testcred', env: 'TESTCRED_HOME' },
  credentialFiles: ['auth.json', 'nested/token.txt'],
  instructionFile: 'AGENTS.md',
  probe: {
    executable: 'testcred',
    args: () => [],
    preview: () => '',
    answer: (stdout) => stdout.trim(),
  },
});

/** 没有登记凭据文件的测试宿主：对应真实世界里 credentialFiles 为空的宿主（例如 opencode）。 */
registerHarness({
  id: 'testcred-empty',
  label: 'testcred-empty',
  layout: { skillsDir: '.testcred-empty/skills', configFile: '.testcred-empty/config.json', instructionFile: 'AGENTS.md' },
  home: { dir: 'home/testcred-empty', env: 'TESTCRED_EMPTY_HOME' },
  instructionFile: 'AGENTS.md',
  probe: {
    executable: 'testcred-empty',
    args: () => [],
    preview: () => '',
    answer: (stdout) => stdout.trim(),
  },
});

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-from-home-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  process.env.PACKHUB_HOME = join(tmp, 'home');
});

afterEach(() => {
  delete process.env.PACKHUB_INSTANCES;
  delete process.env.PACKHUB_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

function sourceHome(files: Record<string, string>): string {
  const dir = join(tmp, 'global-home');
  for (const [rel, body] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, body, 'utf8');
  }
  return dir;
}

describe('--from-home：按 credentialFiles 复制凭据', () => {
  it('复制清单里的文件到新 home 的对应位置，父目录按需创建', async () => {
    const fromHome = sourceHome({
      'auth.json': '{"token":"global"}\n',
      'nested/token.txt': 'nested-secret\n',
      // 宿主没登记的文件即便存在也不带
      'sessions/keep.txt': 'session\n',
    });
    const notes: string[] = [];

    const rec = await createInstance({
      name: 'cred',
      harness: 'testcred',
      packDir: PACK,
      fromHome,
      onWarn: (line) => notes.push(line),
    });

    const home = join(rec.root, 'home/testcred');
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('{"token":"global"}\n');
    expect(readFileSync(join(home, 'nested/token.txt'), 'utf8')).toBe('nested-secret\n');
    // 不在 credentialFiles 里的东西不搬
    expect(existsSync(join(home, 'sessions/keep.txt'))).toBe(false);
    expect(notes.some((line) => line.includes('复制凭据：auth.json'))).toBe(true);
  });

  it('源文件不存在：跳过该文件并提示，home 照样建好', async () => {
    const fromHome = sourceHome({ 'auth.json': '{}\n' });
    const notes: string[] = [];

    const rec = await createInstance({
      name: 'cred-missing',
      harness: 'testcred',
      packDir: PACK,
      fromHome,
      onWarn: (line) => notes.push(line),
    });

    expect(existsSync(join(rec.root, 'home/testcred/auth.json'))).toBe(true);
    expect(existsSync(join(rec.root, 'home/testcred/nested/token.txt'))).toBe(false);
    expect(notes.some((line) => line.includes('跳过 nested/token.txt'))).toBe(true);
  });

  it('宿主没有登记凭据文件：不复制任何东西并说明', async () => {
    const fromHome = sourceHome({ 'auth.json': '{}\n' });
    const notes: string[] = [];

    const rec = await createInstance({
      name: 'cred-empty',
      harness: 'testcred-empty',
      packDir: PACK,
      fromHome,
      onWarn: (line) => notes.push(line),
    });

    expect(existsSync(join(rec.root, 'home/testcred-empty/auth.json'))).toBe(false);
    expect(notes).toContain('宿主没有登记凭据文件（credentialFiles 为空），--from-home 没有复制任何东西');
  });

  it('目录不存在：用法错，不建实例', async () => {
    let caught: unknown;
    try {
      await createInstance({
        name: 'cred-gone',
        harness: 'testcred',
        packDir: PACK,
        fromHome: join(tmp, 'no-such-home'),
      });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('invalid-input');
    expect(existsSync(join(tmp, 'instances'))).toBe(false);
  });

  it('attached home 不接受 --from-home（凭据本来就在全局目录）', async () => {
    const fromHome = sourceHome({ 'auth.json': '{}\n' });
    let caught: unknown;
    try {
      await createInstance({
        name: 'cred-attached',
        harness: 'opencode',
        packDir: PACK,
        attachedHome: join(tmp, 'opencode-global'),
        fromHome,
      });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('invalid-input');
    expect(isPalError(caught) && caught.message).toContain('--from-home 只能配 managed home');
    expect(existsSync(join(tmp, 'opencode-global'))).toBe(false);
  });
});
