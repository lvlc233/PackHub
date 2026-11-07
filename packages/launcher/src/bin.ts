#!/usr/bin/env node
import { runMain } from 'citty';
import { main } from './cli.ts';
import { errorBody } from './errors.ts';

runMain(main).catch((err: unknown) => {
  const body = errorBody(err);
  console.error(`x ${body.error}`);
  if (body.hint) console.error(`  ${body.hint}`);
  process.exit(body.code === 'invalid-input' ? 2 : 1);
});
