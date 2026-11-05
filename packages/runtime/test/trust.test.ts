import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addTrustedKey,
  appendAudit,
  readAudit,
  readTrust,
  removeTrustedKey,
  signaturePolicy,
  trustedKeyIds,
} from '../src/index.ts';

const homes: string[] = [];

afterEach(() => {
  delete process.env.PACKHUB_HOME;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function useHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'packhub-trust-'));
  homes.push(home);
  process.env.PACKHUB_HOME = home;
  return home;
}

describe('持久信任列表', () => {
  it('加公钥后默认要求签名，且只认列表内公钥', () => {
    useHome();
    expect(signaturePolicy()).toEqual({ require: false });

    addTrustedKey('key-abc', '维护者');
    expect(trustedKeyIds()).toEqual(['key-abc']);
    expect(readTrust().keys[0]?.label).toBe('维护者');
    expect(signaturePolicy()).toEqual({ require: true, trusted: ['key-abc'] });

    // 无签名包被拒；--allow-unsigned 是显式的降级
    expect(signaturePolicy({ require: false })).toEqual({ require: true, trusted: ['key-abc'] });
    expect(signaturePolicy({ allowUnsigned: true })).toEqual({ require: false, trusted: ['key-abc'] });

    expect(removeTrustedKey('key-abc')).toBe(true);
    expect(signaturePolicy()).toEqual({ require: false });
  });
});

describe('安装审计', () => {
  it('追加与读取审计行，坏行不会挡住后面的记录', () => {
    const home = useHome();
    appendAudit({ action: 'add', pack: 'demo/a', version: '0.0.1', planHash: 'sha256-x', ok: true, root: home });
    expect(readAudit()).toHaveLength(1);
    expect(readAudit()[0]?.action).toBe('add');
  });
});
