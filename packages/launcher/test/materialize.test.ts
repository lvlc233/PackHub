import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packArchive } from '@packhub/runtime';
import { materializePack, packCacheRoot, slug } from '../src/materialize.ts';

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
    const cache = join(packCacheRoot(), slug(missing));
    expect(existsSync(cache) ? readdirSafe(cache) : []).toEqual([]);
  });
});

describe('缓存目录名 slug', () => {
  // 只在前段不同的长引用：两者末 40 字符完全一样，旧的「只留末 40 字符」会撞成一个目录
  const sharedTail = 'x'.repeat(40);
  const refA = `https://registry.example.com/team-one/${sharedTail}`;
  const refB = `https://registry.example.com/team-two/${sharedTail}`;

  it('末 40 字符相同、前段不同的引用得到不同目录', () => {
    expect(refA.slice(-40)).toBe(refB.slice(-40));
    expect(slug(refA)).not.toBe(slug(refB));
  });

  it('同一引用多次调用名字稳定', () => {
    const once = slug(refA);
    expect(slug(refA)).toBe(once);
    expect(slug(refA)).toBe(once);
    expect(slug(refB)).toBe(slug(refB));
  });

  it('名字合法：无 Windows 非法字符、不以点或空格结尾、长度 ≤60', () => {
    const refs = [
      refA,
      refB,
      'git+https://github.com/org/repo@v1.0.0',
      'C:\\Users\\name\\repo.phub',
      'a<b>c:"d|e?f*g\\h/phub.phub',
      '  trailing.  ',
      '...',
      '..\\..\\..\\evil',
      'x'.repeat(200),
    ];
    for (const ref of refs) {
      const name = slug(ref);
      expect(name.length, ref).toBeGreaterThan(0);
      expect(name.length, ref).toBeLessThanOrEqual(60);
      expect(name, ref).toMatch(/-[0-9a-f]{8,}$/);
      expect(name, ref).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/);
      expect(name, ref).not.toMatch(/[. ]$/);
      expect(['.', '..'], ref).not.toContain(name);
      expect(name, ref).not.toMatch(/^\.\.?$/);
    }
  });

  it('组合落点：同尾段不同目录的 .phub 不共用缓存目录', async () => {
    // 文件名去掉 .phub 后仍以 40 个 y 结尾：旧规则下两个 ref 的 slug 与 variant（显式版本）都会相同
    const name = `${'y'.repeat(40)}.phub`;
    const one = join(tmp, 'src-a', name);
    const two = join(tmp, 'src-b', name);
    mkdirSync(join(tmp, 'src-a'), { recursive: true });
    mkdirSync(join(tmp, 'src-b'), { recursive: true });
    copyFileSync(archive, one);
    copyFileSync(archive, two);

    const dirOne = await materializePack(one, { version: '0.1.0' });
    const dirTwo = await materializePack(two, { version: '0.1.0' });

    expect(dirOne).not.toBe(dirTwo);
    expect(dirOne).toBe(join(packCacheRoot(), slug(one), '0.1.0'));
    expect(dirTwo).toBe(join(packCacheRoot(), slug(two), '0.1.0'));
    expect(existsSync(join(dirOne, 'packhub.yaml'))).toBe(true);
    expect(existsSync(join(dirTwo, 'packhub.yaml'))).toBe(true);
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
