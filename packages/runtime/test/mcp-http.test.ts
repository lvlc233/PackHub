import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks } from '../src/index.ts';

const servers: Server[] = [];

function listen(handler: (body: string) => { status: number; body: string }): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const reply = handler(body);
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}/mcp`);
    });
  });
}

function listenSse(handler: (body: string) => { status: number; body: string }): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const reply = handler(body);
        res.writeHead(reply.status, { 'content-type': 'text/event-stream' });
        res.end(reply.body);
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}/mcp`);
    });
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('http MCP 探活', () => {
  it('端点回应 initialize 时通过', async () => {
    const url = await listen((body) => {
      expect(body).toContain('"initialize"');
      return {
        status: 200,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2024-11-05', capabilities: {} },
        }),
      };
    });
    const root = mkdtempSync(join(tmpdir(), 'packhub-mcp-http-'));
    const results = await runChecks([{ type: 'mcp-ready', resource: 'remote', timeout: 5 }], {
      root,
      servers: { remote: { transport: 'http', url } },
    });
    expect(results[0]?.status).toBe('pass');
    rmSync(root, { recursive: true, force: true });
  });

  it('端点不回应时失败，而不是静默跳过', async () => {
    const url = await listen(() => ({ status: 500, body: 'not ready' }));
    const root = mkdtempSync(join(tmpdir(), 'packhub-mcp-http-bad-'));
    const results = await runChecks([{ type: 'mcp-ready', resource: 'remote', timeout: 5 }], {
      root,
      servers: { remote: { transport: 'http', url } },
    });
    expect(results[0]?.status).toBe('fail');
    rmSync(root, { recursive: true, force: true });
  });

  it('SSE 响应按 data 行拼出结果：注释和 event 行不算，分多行的 JSON 也能拼回', async () => {
    const url = await listenSse((body) => {
      expect(body).toContain('"initialize"');
      return {
        status: 200,
        body: [
          ': keep-alive',
          'event: message',
          'data: {"jsonrpc":"2.0","id":1,',
          'data: "result":{"protocolVersion":"2024-11-05","capabilities":{}}}',
          '',
        ].join('\n'),
      };
    });
    const root = mkdtempSync(join(tmpdir(), 'packhub-mcp-sse-'));
    const results = await runChecks([{ type: 'mcp-ready', resource: 'remote', timeout: 5 }], {
      root,
      servers: { remote: { transport: 'http', url } },
    });
    expect(results[0]?.status).toBe('pass');
    expect(results[0]?.detail).toContain('http initialize');
    rmSync(root, { recursive: true, force: true });
  });

  it('SSE 里只有错误对象、没有 result 时算失败', async () => {
    const url = await listenSse(() => ({
      status: 200,
      body: 'event: message\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"no init"}}\n\n',
    }));
    const root = mkdtempSync(join(tmpdir(), 'packhub-mcp-sse-bad-'));
    const results = await runChecks([{ type: 'mcp-ready', resource: 'remote', timeout: 5 }], {
      root,
      servers: { remote: { transport: 'http', url } },
    });
    expect(results[0]?.status).toBe('fail');
    expect(results[0]?.detail).toContain('没有回应 initialize');
    rmSync(root, { recursive: true, force: true });
  });
});
