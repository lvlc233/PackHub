import { describe, expect, it } from 'vitest';
import type { Plan, PlanAction, PlanOpName } from '../src/index.ts';
import {
  PLAN_OPS,
  actionFromBase,
  actionInputs,
  actionIsShared,
  actionPaths,
  actionRetainWarning,
  actionUndo,
  actionUndoPayload,
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
} satisfies { [K in PlanOpName]: PlanAction };

/** 编译期检查：表与样例都按 `PlanOpName` 列全，新增 op 不补样例这里就编不过。 */
type MissingSample = Exclude<PlanOpName, keyof typeof A>;

/** 取共享配置的撤销载荷；没有就当场报错，别让断言在 null 上静默通过。 */
function restoreShared(action: PlanAction): { path: string; key: string } {
  const payload = actionUndoPayload(action);
  if (payload?.undo !== 'restore-shared') throw new Error(`${action.op} 没有 restore-shared 载荷`);
  return payload;
}

/** 取托管块的撤销载荷。 */
function stripBlock(action: PlanAction): { file: string; blockId: string } {
  const payload = actionUndoPayload(action);
  if (payload?.undo !== 'strip-block') throw new Error(`${action.op} 没有 strip-block 载荷`);
  return payload;
}

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

  it('撤销载荷：共享配置给路径 + 键，托管块给文件 + 块 id', () => {
    expect(restoreShared(A['register.mcp'])).toEqual({
      undo: 'restore-shared',
      path: '.packhub/config.json',
      key: 'mcp',
    });
    // 卸载时按 resource 当键；resource 缺省才用 mcp（与 install.ts 的 sharedServers 同口径）
    const named = { ...A['register.mcp'], resource: 'demo' } as PlanAction;
    expect(restoreShared(named)).toMatchObject({ path: '.packhub/config.json', key: 'demo' });
    const customPath = { ...A['register.mcp'], path: 'mcp.json' } as PlanAction;
    expect(restoreShared(customPath).path).toBe('mcp.json');

    expect(stripBlock(A.instruction)).toEqual({
      undo: 'strip-block',
      file: 'AGENTS.md',
      blockId: 'demo/ops',
    });
  });

  it('表里每个 op 的 undo 与 undoPayload 自洽（新增 op 不补样例编不过）', () => {
    const missing: MissingSample[] = [];
    expect(missing).toEqual([]);

    const needPayload = new Set(['restore-shared', 'strip-block']);
    for (const op of Object.keys(PLAN_OPS) as PlanOpName[]) {
      const action = A[op];
      expect(action, `PLAN_OPS 里的 ${op} 在样例表里没补`).toBeDefined();
      const undo = actionUndo(action);
      const payload = actionUndoPayload(action);
      if (needPayload.has(undo)) {
        expect(payload, `${op} 的撤销需要载荷`).not.toBeNull();
        expect(payload?.undo).toBe(undo);
        const fields = payload?.undo === 'restore-shared' ? [payload.path, payload.key] : payload?.undo === 'strip-block' ? [payload.file, payload.blockId] : [];
        expect(fields.length, `${op} 的载荷字段不全`).toBe(2);
        for (const field of fields) expect(field, `${op} 的载荷字段不能为空`).not.toBe('');
      } else {
        expect(payload, `${op} 不需要撤销载荷`).toBeNull();
      }
    }
  });
});
