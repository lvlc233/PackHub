import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor } from '@packhub/kernel';
import {
  installPack,
  readCredentials,
  readIndex,
  readSignatures,
  readTrust,
  readVersionRecord,
  RegistryError,
} from '../src/index.ts';

let home: string;
const previousHome = process.env.PACKHUB_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'packhub-apiver-'));
  process.env.PACKHUB_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PACKHUB_HOME;
  else process.env.PACKHUB_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('带版本文件的读取闸门', () => {
  it('credentials：写了 v1 就拒绝，缺 apiVersion 也拒绝', () => {
    const file = join(home, 'credentials.json');
    writeFileSync(file, JSON.stringify({ apiVersion: 'packhub.dev/credentials/v1', tokens: {} }), 'utf8');
    expect(() => readCredentials()).toThrow(/格式版本不认识/);

    writeFileSync(file, JSON.stringify({ tokens: { NPM_TOKEN: { value: 'x', updatedAt: 'now' } } }), 'utf8');
    expect(() => readCredentials()).toThrow(/没有 apiVersion/);
  });

  it('trust：写了 v1 就拒绝', () => {
    writeFileSync(join(home, 'trust.json'), JSON.stringify({ apiVersion: 'packhub.dev/trust/v1', keys: [] }), 'utf8');
    expect(() => readTrust()).toThrow(/格式版本不认识/);
  });

  it('签名文件：写了 v1 就拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-apiver-sig-'));
    writeFileSync(
      join(dir, 'packhub.signatures.json'),
      JSON.stringify({ apiVersion: 'packhub.dev/signatures/v1', signatures: [] }),
      'utf8',
    );
    expect(() => readSignatures(dir)).toThrow(/格式版本不认识/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('版本记录：写了 v1 就拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-apiver-pack-'));
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/apiver, version: 0.0.1 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`,
      'utf8',
    );
    writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
    const ctx = loadPack(dir);
    await installPack(ctx, planFor(ctx).plan!);

    const recordFile = join(dir, '.packhub/versions/demo-apiver/0.0.1/record.json');
    const record = JSON.parse(readFileSync(recordFile, 'utf8')) as Record<string, unknown>;
    writeFileSync(recordFile, JSON.stringify({ ...record, apiVersion: 'packhub.dev/version/v1' }), 'utf8');
    expect(() => readVersionRecord(dir, 'demo/apiver', '0.0.1')).toThrow(/格式版本不认识/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('registry 索引：v1 与缺 apiVersion 都拒绝，v0 照常读', async () => {
    const file = join(home, 'index.json');
    writeFileSync(file, JSON.stringify({ apiVersion: 'packhub.dev/index/v1', packs: [] }), 'utf8');
    await expect(readIndex(file)).rejects.toThrow(/格式版本不认识/);
    await expect(readIndex(file)).rejects.toBeInstanceOf(RegistryError);

    writeFileSync(file, JSON.stringify({ packs: [] }), 'utf8');
    await expect(readIndex(file)).rejects.toThrow(/没有 apiVersion/);

    writeFileSync(file, JSON.stringify({ apiVersion: 'packhub.dev/index/v0', packs: [] }), 'utf8');
    await expect(readIndex(file)).resolves.toEqual({ apiVersion: 'packhub.dev/index/v0', packs: [] });
  });
});
