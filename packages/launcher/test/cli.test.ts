import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';

/** 只读命令定义，不执行 run：不写盘、不起进程、不碰网络。 */
interface CommandShape {
  args?: Record<string, { type?: string; default?: unknown } | undefined>;
  subCommands?: Record<string, CommandShape | undefined>;
}

const subCommands = (main as unknown as CommandShape).subCommands ?? {};

describe('pal cli --json', () => {
  for (const name of ['show', 'rename', 'migrate', 'use', 'current']) {
    it(`${name} 声明 --json（boolean，默认 false）`, () => {
      const command = subCommands[name];
      expect(command, `${name} 应存在`).toBeTruthy();
      const json = command?.args?.json;
      expect(json?.type, `${name} --json 类型`).toBe('boolean');
      expect(json?.default, `${name} --json 默认值`).toBe(false);
    });
  }
});
