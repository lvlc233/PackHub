#!/usr/bin/env node
import { resolve } from 'node:path';
import { startMarket } from './server.ts';

const args = process.argv.slice(2);
const root = resolve(args[0] ?? '.');
const port = Number(args[1] ?? process.env.PACKHUB_MARKET_PORT ?? 8789);
const host = args[2] ?? process.env.PACKHUB_MARKET_HOST ?? '127.0.0.1';

startMarket({ root, port, host })
  .then((market) => {
    console.log(`PackHub 市场（写端）→ ${market.url}  root=${root}`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        void market.close().then(() => process.exit(0));
      });
    }
  })
  .catch((err: Error) => {
    console.error(`x ${err.message}`);
    process.exit(1);
  });
