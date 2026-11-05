import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  credentialsPath,
  listTokens,
  mask,
  readCredentials,
  removeToken,
  resolveToken,
  setToken,
} from '../src/index.ts';

const dirs: string[] = [];
function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-cred-'));
  dirs.push(dir);
  process.env.PACKHUB_HOME = dir;
  return dir;
}

afterEach(() => {
  delete process.env.PACKHUB_HOME;
  delete process.env.DEMO_TOKEN;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('凭据库', () => {
  it('存进去能读出来，文件权限 0600（POSIX）', () => {
    const home = freshHome();
    setToken('DEMO_TOKEN', 'abc123456789');
    const file = credentialsPath();
    expect(file.startsWith(home)).toBe(true);
    expect(resolveToken('DEMO_TOKEN')).toBe('abc123456789');
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    const raw = readFileSync(file, 'utf8');
    expect(raw).toContain('abc123456789');
  });

  it('环境变量优先于凭据库', () => {
    freshHome();
    setToken('DEMO_TOKEN', 'from-store');
    process.env.DEMO_TOKEN = 'from-env';
    expect(resolveToken('DEMO_TOKEN')).toBe('from-env');
  });

  it('list 只给掩码，不泄漏完整值', () => {
    freshHome();
    setToken('DEMO_TOKEN', 'oc_sk_secret_value_123456');
    const list = listTokens();
    expect(list).toHaveLength(1);
    expect(list[0]!.masked).not.toContain('secret_value');
    expect(list[0]!.masked).toContain('3456');
  });

  it('remove 删掉；重复删返回 false', () => {
    freshHome();
    setToken('DEMO_TOKEN', 'x');
    expect(removeToken('DEMO_TOKEN')).toBe(true);
    expect(removeToken('DEMO_TOKEN')).toBe(false);
    expect(resolveToken('DEMO_TOKEN')).toBeUndefined();
  });

  it('坏文件不炸，按空库处理', () => {
    const home = freshHome();
    setToken('DEMO_TOKEN', 'x');
    const file = join(home, 'credentials.json');
    writeFileSync(file, '{not json', 'utf8');
    expect(readCredentials().tokens).toEqual({});
  });

  it('mask 对短值只给 ***', () => {
    expect(mask('short')).toBe('***');
    expect(mask('1234567890')).toBe('1234…7890（10 位）');
  });
});
