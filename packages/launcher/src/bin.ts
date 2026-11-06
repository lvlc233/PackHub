#!/usr/bin/env node
import { runMain } from 'citty';
import { main } from './cli.ts';

runMain(main).catch((err: unknown) => {
  console.error(`x ${(err as Error).message}`);
  process.exit(1);
});
