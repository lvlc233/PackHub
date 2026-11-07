import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packArchive } from '@packhub/runtime';
import { materializePack } from '../src/materialize.ts';

let tmp: string;
let archive: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-materialize-'));
  process.env.PACKHUB_HOME = tmp;
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  delete process.env.PACKHUB_INDEX;
  // 打一个真 .phub：取包路径要按真归档走
  const out = join(tmp, 'pack.phub');
  await packArchive('examples/doc-review', { vendored: true, out });
  archive = out;
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

  it('registry 名没有索引时报错，并给出替代做法', async () => {
    await expect(materializePack('lvlc233/doc-review')).rejects.toThrow('需要一个索引');
  });

  it('同一个 .phub 重取时清空旧内容，不叠文件', async () => {
    const first = await materializePack(archive);
    expect(existsSync(join(first, 'packhub.yaml'))).toBe(true);

    // 上一次留在缓存里的东西：换版本/重取时不该再出现
    writeFileSync(join(first, 'stale-from-last-run.txt'), 'old', 'utf8');

    const second = await materializePack(archive);
    expect(second).toBe(first);
    expect(existsSync(join(second, 'stale-from-last-run.txt'))).toBe(false);
    expect(existsSync(join(second, 'packhub.yaml'))).toBe(true);
  });

  it('不同版本落到不同缓存目录', async () => {
    const one = await materializePack(archive, { version: '0.1.0' });
    writeFileSync(join(one, 'v1.txt'), 'one', 'utf8');
    const two = await materializePack(archive, { version: '0.2.0' });
    expect(two).not.toBe(one);
    expect(existsSync(join(two, 'v1.txt'))).toBe(false);
    expect(existsSync(join(one, 'v1.txt'))).toBe(true);
  });

  it('取不回来时不留半份目录', async () => {
    const missing = join(tmp, 'nope.phub');
    await expect(materializePack(missing)).rejects.toThrow('没有这个归档');
    const cache = join(tmp, 'cache', 'packs', 'nope');
    expect(existsSync(cache) ? readdirSafe(cache) : []).toEqual([]);
  });
});

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
