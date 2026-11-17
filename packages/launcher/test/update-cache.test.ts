import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, updateInstance } from '../src/index.ts';

/**
 * 端到端固定一个曾经被删掉的缓存：`fetch` 的落点也是计划产物。
 *
 * 老实现里 launcher 的 planTargets 不数 fetch，更新后仍在用的下载文件会被当成
 * 「上一版独有的文件」删掉（install 刚下回来的那份）。这里用本地 http 服务器供一份
 * 知识文件，v1 与 v2 引用同一个来源，更新后它必须还在。
 */
const BODY = '# 取回的知识\n\nv1 与 v2 共用同一个 http 来源。\n';

let server: Server;
let source = '';
let tmp: string;

/** 造一个指定版本的 Pack：一个远程 knowledge（fetch 落点）+ 一个本地 knowledge。 */
function cachePack(version: string): string {
  const dir = join(tmp, `pack-${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'extra.md'), `# ${version}\n`, 'utf8');
  const integrity = `sha256-${createHash('sha256').update(BODY).digest('base64')}`;
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/cache, version: ${version}, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: shared
    type: knowledge
    source: ${source}
    integrity: ${integrity}
  - id: local
    type: knowledge
    source: ./extra.md
`,
    'utf8',
  );
  return dir;
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(BODY);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const addr = server.address() as AddressInfo;
  source = `http://127.0.0.1:${addr.port}/shared.md`;
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-update-cache-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  process.env.PACKHUB_HOME = join(tmp, 'home');
});

afterEach(() => {
  delete process.env.PACKHUB_INSTANCES;
  delete process.env.PACKHUB_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe('pal update：仍在用的 fetch 缓存不被删', () => {
  it('v1 与 v2 引用同一个 http 来源：更新后文件还在，也不列进 removedFiles', async () => {
    const v1 = cachePack('0.1.0');
    const rec = await createInstance({ name: 'keep-cache', harness: 'dir', packDir: v1, packRef: v1 });
    const cached = join(rec.root, '.packhub', 'knowledge', 'shared.md');
    expect(existsSync(cached)).toBe(true);
    expect(readFileSync(cached, 'utf8')).toBe(BODY);

    const v2 = cachePack('0.2.0');
    const result = await updateInstance('keep-cache', { packDir: v2 });

    expect(result.changed).toBe(true);
    expect(result.to).toBe('demo/cache@0.2.0');
    expect(result.removedFiles).not.toContain('.packhub/knowledge/shared.md');
    expect(existsSync(cached)).toBe(true);
    expect(readFileSync(cached, 'utf8')).toBe(BODY);
  });
});
