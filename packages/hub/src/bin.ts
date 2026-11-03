#!/usr/bin/env node
// Hub 的独立入口：只读发布端。对外监听必须带鉴权，否则拒绝启动。
import { resolve } from 'node:path';
import { defaultStaticDir, startHub } from './index.ts';

interface Args {
  dir: string;
  port: number;
  host: string;
  token?: string;
  userHeader?: string;
  audit?: string;
  rpm?: number;
}

function parse(argv: string[]): Args {
  const args: Args = { dir: '.', port: 8788, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => argv[++i] ?? '';
    if (a === '--dir') args.dir = next();
    else if (a === '--port') args.port = Number(next());
    else if (a === '--host') args.host = next();
    else if (a === '--token') args.token = next();
    else if (a === '--user-header') args.userHeader = next();
    else if (a === '--audit') args.audit = next();
    else if (a === '--rpm') args.rpm = Number(next());
    else if (a === '-h' || a === '--help') {
      console.log(
        `用法: packhub-hub [--dir .] [--port 8788] [--host 127.0.0.1] [--token T | --user-header H] [--audit FILE] [--rpm N]`,
      );
      process.exit(0);
    }
  }
  return args;
}

const args = parse(process.argv.slice(2));

try {
  const server = await startHub({
    root: resolve(args.dir),
    port: args.port,
    host: args.host,
    staticDir: defaultStaticDir(),
    ...(args.token || args.userHeader
      ? { auth: { ...(args.token ? { token: args.token } : {}), ...(args.userHeader ? { userHeader: args.userHeader } : {}) } }
      : {}),
    ...(args.audit ? { auditFile: resolve(args.audit) } : {}),
    ...(args.rpm !== undefined ? { rpm: args.rpm } : {}),
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : args.port;
  console.log(`Hub（只读）→ http://${args.host}:${port}`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`${signal} → 停止接收新请求`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }
} catch (err) {
  console.error(`x ${(err as Error).message}`);
  process.exit(1);
}
