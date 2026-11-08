import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packArchive } from '@packhub/runtime';
import { materializePack } from '../src/materialize.ts';

let tmp: string;
let archive: string;
let index: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-materialize-'));
  process.env.PACKHUB_HOME = tmp;
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  delete process.env.PACKHUB_INDEX;
  // 打一个真 .phub：取包路径要按真归档走
  const out = join(tmp, 'pack.phub');
  await packArchive('examples/doc-review', { vendored: true, out });
  archive = out;
  index = await makeRegistry();
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

describe('明确版本的取包缓存复用', () => {
  it('同 ref + 同明确版本第二次直接命中：不 reset、不重新解包', async () => {
    const first = await materializePack('testorg/cache-demo', { index, version: '0.1.0' });
    expect(existsSync(join(first, 'packhub.yaml'))).toBe(true);
    // 命中时这一层不会被清掉：留下的标记文件就是「没 reset」的证据
    writeFileSync(join(first, 'cached-marker.txt'), 'from-first-run', 'utf8');
    const mtime = statSync(join(first, 'packhub.yaml')).mtimeMs;

    const lines: string[] = [];
    const second = await materializePack('testorg/cache-demo', {
      index,
      version: '0.1.0',
      log: (line) => lines.push(line),
    });

    expect(second).toBe(first);
    expect(lines.some((l) => l.includes('缓存命中'))).toBe(true);
    expect(existsSync(join(second, 'cached-marker.txt'))).toBe(true);
    expect(statSync(join(second, 'packhub.yaml')).mtimeMs).toBe(mtime);
  });

  it('不写版本（latest）仍然重取，不复用目录', async () => {
    const first = await materializePack('testorg/cache-demo', { index });
    writeFileSync(join(first, 'stale-from-last-run.txt'), 'old', 'utf8');

    const lines: string[] = [];
    const second = await materializePack('testorg/cache-demo', {
      index,
      log: (line) => lines.push(line),
    });

    expect(second).toBe(first);
    expect(lines.some((l) => l.includes('缓存命中'))).toBe(false);
    expect(existsSync(join(second, 'stale-from-last-run.txt'))).toBe(false);
  });

  it('.phub 来源即使给了明确版本也仍然重取', async () => {
    const first = await materializePack(archive, { version: '0.1.0' });
    writeFileSync(join(first, 'stale-from-last-run.txt'), 'old', 'utf8');

    const lines: string[] = [];
    const second = await materializePack(archive, {
      version: '0.1.0',
      log: (line) => lines.push(line),
    });

    expect(second).toBe(first);
    expect(lines.some((l) => l.includes('缓存命中'))).toBe(false);
    expect(existsSync(join(second, 'stale-from-last-run.txt'))).toBe(false);
  });

  it('目录里是别的版本时不命中，照样重取', async () => {
    const first = await materializePack('testorg/cache-demo', { index, version: '0.1.0' });
    writeFileSync(join(first, 'stale-from-last-run.txt'), 'old', 'utf8');

    // 同一个 dest 里塞一份版本不同的清单：版本对不上就不该复用
    const manifest = join(first, 'packhub.yaml');
    writeFileSync(
      manifest,
      readFileSync(manifest, 'utf8').replace('version: 0.1.0', 'version: 9.9.9'),
      'utf8',
    );

    const lines: string[] = [];
    const second = await materializePack('testorg/cache-demo', {
      index,
      version: '0.1.0',
      log: (line) => lines.push(line),
    });

    expect(second).toBe(first);
    expect(lines.some((l) => l.includes('缓存命中'))).toBe(false);
    expect(existsSync(join(second, 'stale-from-last-run.txt'))).toBe(false);
    expect(existsSync(join(second, 'packhub.yaml'))).toBe(true);
  });
});

/** 本地 registry：索引 + 一个真归档，避开网络。 */
async function makeRegistry(): Promise<string> {
  const root = join(tmp, 'reg');
  const dir = join(root, 'packs', 'testorg', 'cache-demo');
  mkdirSync(dir, { recursive: true });
  await packArchive('examples/doc-review', { vendored: true, out: join(dir, '0.1.0.phub') });
  const file = join(root, 'index.json');
  writeFileSync(
    file,
    JSON.stringify({
      apiVersion: 'packhub.dev/index/v0',
      packs: [{ name: 'testorg/cache-demo', latest: '0.1.0', versions: ['0.1.0'] }],
    }),
    'utf8',
  );
  return file;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
