import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packArchive } from '@packhub/runtime';
import { listInstances } from '../src/index.ts';
import { createFromRef, updateFromRef } from '../src/service.ts';

/**
 * C9：编排层的成功/失败各一条，用本地 registry（同 materialize.test 的 tmp 索引）避开网络。
 * 这里只测 service 的取包 + 建/更新顺序与透传；CLI/HTTP 各自的参数语义由它们的用例覆盖。
 */

let tmp: string;
let index: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-service-'));
  process.env.PACKHUB_HOME = join(tmp, 'home');
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  delete process.env.PACKHUB_INDEX;
  index = await makeRegistry();
});

afterEach(() => {
  delete process.env.PACKHUB_HOME;
  delete process.env.PACKHUB_INSTANCES;
  rmSync(tmp, { recursive: true, force: true });
});

describe('createFromRef', () => {
  it('按 registry 引用取包并建实例：name / harness / root / packRef 都透传', async () => {
    const root = join(tmp, 'beside', 'svc-root');
    const rec = await createFromRef({
      packRef: 'testorg/service-demo',
      version: '0.1.0',
      index,
      name: 'svc',
      harness: 'dir',
      root,
    });

    expect(rec.status).toBe('installed');
    expect(rec.name).toBe('svc');
    expect(rec.root).toBe(root);
    expect(rec.pack).toMatchObject({
      name: 'lvlc233/doc-review',
      version: '0.1.0',
      ref: 'testorg/service-demo',
    });
    expect(existsSync(join(root, 'instance.json'))).toBe(true);
    expect(listInstances().map((item) => item.id)).toEqual([rec.id]);
  });

  it('取包失败时不建实例：没有索引就报错，列表保持为空', async () => {
    await expect(
      createFromRef({ packRef: 'testorg/service-demo', name: 'no-index', harness: 'dir' }),
    ).rejects.toThrow('需要一个索引');
    expect(listInstances()).toEqual([]);
  });
});

describe('updateFromRef', () => {
  it('换成 registry 里的新版本：from/to 与记录里的版本一起前进，取包日志透传', async () => {
    const rec = await createFromRef({
      packRef: 'testorg/service-demo',
      version: '0.1.0',
      index,
      name: 'upd',
      harness: 'dir',
    });

    const lines: string[] = [];
    const result = await updateFromRef({
      idOrName: rec.id,
      packRef: 'testorg/service-demo',
      version: '0.2.0',
      index,
      log: (line) => lines.push(line),
    });

    expect(result.changed).toBe(true);
    expect(result.from).toBe('lvlc233/doc-review@0.1.0');
    expect(result.to).toBe('lvlc233/doc-review@0.2.0');
    expect(result.record.pack).toMatchObject({
      name: 'lvlc233/doc-review',
      version: '0.2.0',
      ref: 'testorg/service-demo',
    });
    expect(lines.some((line) => line.includes('testorg/service-demo@0.2.0'))).toBe(true);
  });

  it('实例不存在时报 unknown-instance，不写任何新记录', async () => {
    await expect(
      updateFromRef({
        idOrName: 'nope',
        packRef: 'testorg/service-demo',
        version: '0.1.0',
        index,
      }),
    ).rejects.toMatchObject({ code: 'unknown-instance' });
    expect(listInstances()).toEqual([]);
  });
});

/** 本地 registry：索引 + 两个真归档（0.1.0 / 0.2.0），版本号从 examples 的清单上改。 */
async function makeRegistry(): Promise<string> {
  const root = join(tmp, 'reg');
  const dir = join(root, 'packs', 'testorg', 'service-demo');
  mkdirSync(dir, { recursive: true });
  await packVersion('0.1.0', join(dir, '0.1.0.phub'));
  await packVersion('0.2.0', join(dir, '0.2.0.phub'));
  const file = join(root, 'index.json');
  writeFileSync(
    file,
    JSON.stringify({
      apiVersion: 'packhub.dev/index/v0',
      packs: [{ name: 'testorg/service-demo', latest: '0.2.0', versions: ['0.1.0', '0.2.0'] }],
    }),
    'utf8',
  );
  return file;
}

/** 复制一份 examples/doc-review，改清单版本后打成 .phub。 */
async function packVersion(version: string, out: string): Promise<void> {
  const src = join(tmp, 'src', version);
  cpSync('examples/doc-review', src, { recursive: true });
  const manifest = join(src, 'packhub.yaml');
  writeFileSync(
    manifest,
    readFileSync(manifest, 'utf8').replace('version: 0.1.0', `version: ${version}`),
    'utf8',
  );
  await packArchive(src, { vendored: true, out });
}
