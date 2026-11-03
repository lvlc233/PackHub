import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPack, planFor } from '../src/index.ts';

const BODY = Buffer.from('# 内网规范\n\n需要 token 才能拿到。\n');
const HASH = `sha256-${createHash('sha256').update(BODY).digest('base64')}`;

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (req.url === '/rules.md') {
      if (auth === 'Bearer secret-token') {
        res.writeHead(200, { 'content-type': 'text/markdown' });
        res.end(BODY);
        return;
      }
      res.writeHead(401).end('unauthorized');
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
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-auth-'));
  mkdirSync(join(dir, 'resources'), { recursive: true });
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/private
  version: 0.0.1
  targets: [dir]
  visibility: internal
requires:
  packhub: ">=0.0.1 <0.1"
resources:
  - id: rules
    type: knowledge
    source: ${base}/rules.md
    integrity: ${HASH}
    auth:
      env: CORP_GITLAB_TOKEN
      scheme: bearer
`,
    'utf8',
  );
  return dir;
}

describe('私有来源的鉴权', () => {
  it('声明 auth 后，安装期从环境变量取 token 拼请求头', async () => {
    const dir = fixture();
    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const { plan } = planFor(ctx);
    const fetchAction = plan!.actions.find((a) => a.op === 'fetch');
    expect(fetchAction && 'auth' in fetchAction ? fetchAction.auth?.env : null).toBe('CORP_GITLAB_TOKEN');

    process.env.CORP_GITLAB_TOKEN = 'secret-token';
    const result = await installPack(ctx, plan!);
    expect(result.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    expect(readFileSync(join(dir, '.packhub/knowledge/rules.md'), 'utf8')).toContain('内网规范');
    delete process.env.CORP_GITLAB_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });

  it('缺凭证时报错指名环境变量，且不含 token', async () => {
    const dir = fixture();
    delete process.env.CORP_GITLAB_TOKEN;
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    const result = await installPack(ctx, plan!);
    const failed = result.outcomes.find((o) => o.status === 'failed');
    expect(failed?.message).toContain('CORP_GITLAB_TOKEN');
    rmSync(dir, { recursive: true, force: true });
  });

  it('token 无效时是 401，报错里不带 token 本身', async () => {
    const dir = fixture();
    process.env.CORP_GITLAB_TOKEN = 'wrong-token';
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    const result = await installPack(ctx, plan!);
    const failed = result.outcomes.find((o) => o.status === 'failed');
    expect(failed?.message).toMatch(/401/);
    expect(failed?.message).toContain('CORP_GITLAB_TOKEN');
    expect(failed?.message).not.toContain('wrong-token');
    delete process.env.CORP_GITLAB_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });

  it('visibility 只接受三档', () => {
    const dir = fixture();
    const text = readFileSync(join(dir, 'packhub.yaml'), 'utf8');
    writeFileSync(join(dir, 'packhub.yaml'), text.replace('visibility: internal', 'visibility: secret'), 'utf8');
    const ctx = loadPack(dir);
    expect(ctx.issues.some((i) => i.code === 'schema')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
