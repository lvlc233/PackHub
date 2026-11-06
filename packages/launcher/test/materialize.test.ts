import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializePack } from '../src/materialize.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-materialize-'));
  process.env.PACKHUB_HOME = tmp;
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  delete process.env.PACKHUB_INDEX;
});

afterEach(() => {
  delete process.env.PACKHUB_HOME;
  delete process.env.PACKHUB_INSTANCES;
  rmSync(tmp, { recursive: true, force: true });
});

describe('Pack 取用', () => {
  it('本地目录直接用，不复制', async () => {
    const dir = await materializePack('examples/doc-review');
    expect(dir).toMatch(/examples[\\/]doc-review$/);
  });

  it('registry 名没有索引时报错', async () => {
    await expect(materializePack('lvlc233/doc-review')).rejects.toThrow('需要一个索引');
  });
});
