import { describe, expect, it } from 'vitest';
import type { PlanAction } from '../src/index.ts';
import { PLAN_OPS, actionIsShared } from '../src/index.ts';

/**
 * 共享性只看动作语义，不看落点长什么样。
 * 这里故意用旧路径启发式会判成「共享」的落点：任意层级 `.json` / `.jsonc` / `.toml`，
 * 以及根目录的 `.md`。
 */
const LOOKS_SHARED = [
  '.packhub/knowledge/table.json',
  'nested/settings.jsonc',
  'nested/dir/config.toml',
  'AGENTS.md',
];

/** 除 register.mcp / instruction 外，其余 op 的产物都是本包私有。 */
const PRIVATE: { op: 'write' | 'copy' | 'fetch' | 'unpack' | 'link.skill' | 'delete' | 'link.exec'; action: (to: string) => PlanAction }[] = [
  { op: 'write', action: (to) => ({ op: 'write', actionId: 'write#1', from: 'src/doc', to }) },
  { op: 'copy', action: (to) => ({ op: 'copy', actionId: 'copy#1', from: 'tools/kit', to }) },
  {
    op: 'fetch',
    action: (to) => ({ op: 'fetch', actionId: 'fetch#1', uri: 'https://x.test/doc', dest: to }),
  },
  {
    op: 'unpack',
    action: (to) => ({ op: 'unpack', actionId: 'unpack#1', from: '.packhub/cache/a.tar.gz', to }),
  },
  {
    op: 'link.skill',
    action: (to) => ({ op: 'link.skill', actionId: 'link.skill#1', from: './skills/hello', to }),
  },
  { op: 'delete', action: (to) => ({ op: 'delete', actionId: 'delete#1', to }) },
  {
    op: 'link.exec',
    action: (to) => ({ op: 'link.exec', actionId: 'link.exec#1', to, runtime: 'node', entry: '.packhub/shim/route.mjs', args: [] }),
  },
];

describe('共享判据只由动作语义决定', () => {
  it.each(LOOKS_SHARED)('私有 op 写 %s 也不算共享（旧启发式已删）', (to) => {
    for (const { op, action } of PRIVATE) {
      const a = action(to);
      expect(actionIsShared(a), `${op} 写到 ${to} 被当成共享`).toBe(false);
      expect(PLAN_OPS[op].shared(a), `${op} 表里的 shared 与 actionIsShared 不一致`).toBe(false);
    }
  });

  it.each(LOOKS_SHARED)('register.mcp / instruction 无论落点都算共享（%s）', (to) => {
    const mcp: PlanAction = { op: 'register.mcp', actionId: 'register.mcp#1', spec: {}, path: to };
    const block: PlanAction = { op: 'instruction', actionId: 'instruction#1', file: to, blockId: 'demo', content: 'x' };
    expect(actionIsShared(mcp)).toBe(true);
    expect(actionIsShared(block)).toBe(true);
  });

  it('exec / state.dir 不产出文件，也不共享', () => {
    expect(
      actionIsShared({ op: 'exec', actionId: 'exec#1', command: 'node', args: [], approval: 'required' }),
    ).toBe(false);
    expect(
      actionIsShared({ op: 'state.dir', actionId: 'state.dir#1', to: '.packhub/state/memory', retain: 'keep' }),
    ).toBe(false);
  });
});
