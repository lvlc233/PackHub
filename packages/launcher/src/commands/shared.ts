// 命令模块共用的小 helper：只依赖 errors.ts，不反向依赖 cli.ts。
import { createInterface } from 'node:readline/promises';
import { PalError } from '../errors.ts';

export function requireTarget(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) throw new PalError('invalid-input', '要指定实例 id 或名字');
  return text;
}

export async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    throw new PalError('invalid-input', `${question}（非交互环境请加 --yes）`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
