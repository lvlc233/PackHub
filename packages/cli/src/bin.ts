#!/usr/bin/env node
import { runMain } from 'citty';
import { main } from './cli.ts';

void runMain(main);
