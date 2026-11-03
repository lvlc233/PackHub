import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download, FetchError, resolveDownloadUrl } from '../src/download.ts';

const BODY = Buffer.from('packhub-integrity-fixture\n'.repeat(64));
const SHA256 = `sha256-${createHash('sha256').update(BODY).digest('base64')}`;

let server: Server;
let base = '';
let work = '';

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'packhub-dl-'));
  server = createServer((req, res) => {
    if (req.url === '/file.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(BODY);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  rmSync(work, { recursive: true, force: true });
});

describe('resolveDownloadUrl', () => {
  it('npm → registry 元数据地址', () => {
    expect(resolveDownloadUrl('npm:left-pad@1.3.0').url).toBe(
      'https://registry.npmjs.org/left-pad/1.3.0',
    );
  });

  it('github → codeload tar.gz', () => {
    expect(resolveDownloadUrl('github:o/r/skills/x@abc123').url).toBe(
      'https://codeload.github.com/o/r/tar.gz/abc123',
    );
  });

  it('pypi 明确报不支持', () => {
    expect(() => resolveDownloadUrl('pypi:foo@1.0')).toThrow(FetchError);
  });
});

describe('download', () => {
  it('内容与 integrity 匹配时落盘', async () => {
    const dest = join(work, 'a.txt');
    const res = await download(`${base}/file.txt`, dest, SHA256);
    expect(res.integrity).toBe(SHA256);
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('integrity 不匹配时抛错且不留下错误文件', async () => {
    const dest = join(work, 'b.txt');
    const wrong = `sha256-${createHash('sha256').update('other').digest('base64')}`;
    await expect(download(`${base}/file.txt`, dest, wrong)).rejects.toThrow(/完整性校验失败/);
  });

  it('404 报 http-status', async () => {
    await expect(download(`${base}/missing.txt`, join(work, 'c.txt'))).rejects.toMatchObject({
      code: 'http-status',
    });
  });
});
