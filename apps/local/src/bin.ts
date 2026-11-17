#!/usr/bin/env node
import { runMain } from 'citty';
import { EXIT, isExitSignal, problem, terminate } from './emit.ts';
import { main, unknownFlag } from './cli.ts';

// 退出码与错误行的写法都在 emit.ts；入口只负责把未知参数和兜底异常落成进程退出码。
const problemArg = unknownFlag(process.argv.slice(2));
if (problemArg) {
  problem(problemArg);
  terminate(EXIT.USAGE);
}

runMain(main).catch((err: unknown) => {
  if (isExitSignal(err)) terminate(err.code);
  problem((err as Error).message);
  terminate(EXIT.RUNTIME);
});
