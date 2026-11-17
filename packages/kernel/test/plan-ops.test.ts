import { describe, expect, it } from 'vitest';
import type { Plan, PlanAction } from '../src/index.ts';
import {
  PLAN_OPS,
  actionFromBase,
  actionInputs,
  actionIsShared,
  actionPaths,
  actionRetainWarning,
  actionUndo,
  actionWritten,
  planPathsOf,
} from '../src/index.ts';

function plan(actions: PlanAction[], target: Plan['target'] = 'dir'): Plan {
  return {
    apiVersion: 'packhub.dev/plan/v0',
    pack: { name: 'demo/ops', version: '0.0.1' },
    target,
    actions,
    verify: [],
    excluded: [],
    planHash: 'sha256-test',
  };
}

const A = {
  fetch: { op: 'fetch', actionId: 'fetch#1', uri: 'https://x.test/a.tar.gz', dest: '.packhub/cache/a.tar.gz' },
  unpack: { op: 'unpack', actionId: 'unpack#1', from: '.packhub/cache/a.tar.gz', to: '.packhub/cache/skills/a', strip: 1, fromBase: 'root' },
  write: { op: 'write', actionId: 'write#1', to: '.packhub/knowledge/doc.md', from: 'docs/doc.md', fromBase: 'pack' },
  copy: { op: 'copy', actionId: 'copy#1', from: 'tools/kit', to: '.packhub/cache/tools/kit' },
  'link.exec': { op: 'link.exec', actionId: 'link.exec#1', to: '.packhub/bin/kit', runtime: 'node', entry: '.packhub/shim/route.mjs', module: '.packhub/cache/tools/kit/main.mjs', args: [] },
  delete: { op: 'delete', actionId: 'delete#1', to: '.packhub/knowledge/gone.md' },
  'link.skill': { op: 'link.skill', actionId: 'link.skill#1', from: './skills/hello', to: '.packhub/skills/hello', fromBase: 'pack' },
  'register.mcp': { op: 'register.mcp', actionId: 'register.mcp#1', spec: { command: 'npx' }, path: '.packhub/config.json' },
  exec: { op: 'exec', actionId: 'exec#1', command: 'npm', args: ['i'], approval: 'required' },
  instruction: { op: 'instruction', actionId: 'instruction#1', file: 'AGENTS.md', blockId: 'demo/ops', content: 'x' },
  'state.dir': { op: 'state.dir', actionId: 'state.dir#1', to: '.packhub/state/memory', retain: 'keep' },
} satisfies Record<string, PlanAction>;

describe('PLAN_OPS：动作原语单表', () => {
  it('每个 op 的写入路径（含派生输出）都从表里推导', () => {
    expect(actionPaths(A.fetch, plan([]))).toEqual(['.packhub/cache/a.tar.gz']);
    expect(actionPaths(A.unpack, plan([]))).toEqual(['.packhub/cache/skills/a']);
    expect(actionPaths(A.write, plan([]))).toEqual(['.packhub/knowledge/doc.md']);
    expect(actionPaths(A.copy, plan([]))).toEqual(['.packhub/cache/tools/kit']);
    expect(actionPaths(A['link.exec'], plan([]))).toEqual(['.packhub/bin/kit', '.packhub/bin/kit.cmd']);
    expect(actionPaths(A.delete, plan([]))).toEqual(['.packhub/knowledge/gone.md']);
    expect(actionPaths(A['link.skill'], plan([]))).toEqual(['.packhub/skills/hello']);
    expect(actionPaths(A['register.mcp'], plan([]))).toEqual(['.packhub/config.json']);
    expect(actionPaths(A.exec, plan([]))).toEqual([]);
    expect(actionPaths(A.instruction, plan([]))).toEqual(['AGENTS.md']);
    expect(actionPaths(A['state.dir'], plan([]))).toEqual([]);
  });

  it('codex 的 link.skill 派生 agents/openai.yaml，planPaths 能列出它', () => {
    const codex = plan([A['link.skill']], 'codex');
    expect(actionPaths(A['link.skill'], codex)).toEqual([
      '.packhub/skills/hello',
      '.packhub/skills/hello/agents/openai.yaml',
    ]);
    expect(planPathsOf(codex)).toContain('.packhub/skills/hello/agents/openai.yaml');
    // 别的 target 不生成这个派生输出
    expect(planPathsOf(plan([A['link.skill']], 'dsh'))).not.toContain(
      '.packhub/skills/hello/agents/openai.yaml',
    );
  });

  it('每个 op 的 from 基准、撤销方式、共享判定都在表里', () => {
    expect(actionFromBase(A.fetch)).toBe('none');
    expect(actionFromBase(A.unpack)).toBe('root');
    expect(actionFromBase(A.write)).toBe('pack');
    expect(actionFromBase(A.copy)).toBe('pack');
    expect(actionFromBase(A['link.skill'])).toBe('pack');
    expect(actionFromBase(A.exec)).toBe('none');

    expect(actionUndo(A.fetch)).toBe('delete');
    expect(actionUndo(A.write)).toBe('delete');
    expect(actionUndo(A.unpack)).toBe('delete');
    expect(actionUndo(A.copy)).toBe('delete');
    expect(actionUndo(A['link.skill'])).toBe('delete');
    expect(actionUndo(A['link.exec'])).toBe('delete');
    expect(actionUndo(A['register.mcp'])).toBe('restore-shared');
    expect(actionUndo(A.instruction)).toBe('strip-block');
    expect(actionUndo(A.delete)).toBe('none');
    expect(actionUndo(A.exec)).toBe('none');
    expect(actionUndo(A['state.dir'])).toBe('none');

    expect(actionIsShared(A['register.mcp'])).toBe(true);
    expect(actionIsShared(A.instruction)).toBe(true);
    expect(actionIsShared(A.write)).toBe(false);
    expect(actionRetainWarning(A['state.dir'])).toContain('状态目录保留');
  });

  it('written 与平台相关：link.exec 的 .cmd 只在 win32 计入', () => {
    expect(actionWritten(A['link.exec'], plan([]), 'win32-x64')).toEqual([
      '.packhub/bin/kit',
      '.packhub/bin/kit.cmd',
    ]);
    expect(actionWritten(A['link.exec'], plan([]), 'linux-x64')).toEqual(['.packhub/bin/kit']);
    // 平台不匹配的动作不产出 written
    const gated = { ...A['link.exec'], platforms: ['linux-x64'] } as PlanAction;
    expect(actionWritten(gated, plan([]), 'win32-x64')).toEqual([]);
    // delete / exec / state.dir 不算写入
    expect(actionWritten(A.delete, plan([]), 'linux-x64')).toEqual([]);
    expect(actionWritten(A.exec, plan([]), 'linux-x64')).toEqual([]);
    expect(actionWritten(A['state.dir'], plan([]), 'linux-x64')).toEqual([]);
  });

  it('只读来源（inputs）也从表里取', () => {
    expect(actionInputs(A.unpack)).toEqual(['.packhub/cache/a.tar.gz']);
    expect(actionInputs(A['link.exec'])).toEqual([
      '.packhub/shim/route.mjs',
      '.packhub/cache/tools/kit/main.mjs',
    ]);
    expect(actionInputs(A.fetch)).toEqual([]);
    expect(actionInputs(A['register.mcp'])).toEqual([]);
  });

  it('显式 fromBase 覆盖 op 默认值', () => {
    const remote = { ...A['link.skill'], fromBase: 'root' } as PlanAction;
    expect(actionFromBase(remote)).toBe('root');
  });

  it('planPathsOf 去重且覆盖 fetch 落点与派生输出', () => {
    const p = plan([A.fetch, A.write, { ...A.write, actionId: 'write#2' } as PlanAction], 'codex');
    expect(planPathsOf(p)).toEqual([
      '.packhub/cache/a.tar.gz',
      '.packhub/knowledge/doc.md',
    ]);
    expect(Object.keys(PLAN_OPS).sort()).toEqual(
      ['copy', 'delete', 'exec', 'fetch', 'instruction', 'link.exec', 'link.skill', 'register.mcp', 'state.dir', 'unpack', 'write'],
    );
  });
});
