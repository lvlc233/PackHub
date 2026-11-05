#!/usr/bin/env node
import { runMain } from 'citty';
import { main, unknownFlag } from './cli.ts';

const problem = unknownFlag(process.argv.slice(2));
if (problem) {
  console.error(`x ${problem}`);
  process.exit(2);
}

runMain(main).catch((err: unknown) => {
  console.error(`x ${(err as Error).message}`);
  process.exit(1);
});