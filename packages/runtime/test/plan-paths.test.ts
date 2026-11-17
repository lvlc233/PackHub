import { describe, expect, it } from 'vitest';
import type { Plan, PlanAction } from '@packhub/kernel';
import { planPaths } from '../src/index.ts';

function plan(actions: PlanAction[]): Plan {
  return {
    apiVersion: 'packhub.dev/plan/v0',
    pack: { name: 'demo/paths', version: '0.0.1' },
    target: 'dir',
    actions,
    verify: [],
    excluded: [],
    planHash: 'sha256-test',
  };
}

const action = (a: PlanAction): PlanAction => a;

describe('planPaths：计划产物路径的唯一口径', () => {
  it('每个 op 都覆盖；fetch 的 dest、link.exec 的 .cmd 算写入，exec/state.dir 不算', () => {
    const paths = planPaths(
      plan([
        action({ op: 'fetch', actionId: 'fetch#1', uri: 'https://example.test/a.tar.gz', dest: '.packhub/cache/a.tar.gz' }),
        action({ op: 'unpack', actionId: 'unpack#1', from: '.packhub/cache/a.tar.gz', to: '.packhub/cache/skills/a' }),
        action({ op: 'write', actionId: 'write#1', to: '.packhub/knowledge/doc.md', content: '# doc\n' }),
        action({ op: 'copy', actionId: 'copy#1', from: './tool', to: '.packhub/cache/tools/t' }),
        action({
          op: 'link.exec',
          actionId: 'link.exec#1',
          to: '.packhub/bin/t',
          runtime: 'node',
          entry: '.packhub/shim/route.mjs',
          module: '.packhub/cache/tools/t/main.mjs',
          args: [],
        }),
        action({ op: 'delete', actionId: 'delete#1', to: '.packhub/knowledge/gone.md' }),
        action({ op: 'link.skill', actionId: 'link.skill#1', from: '.packhub/cache/skills/s', to: '.packhub/skills/s' }),
        action({ op: 'register.mcp', actionId: 'register.mcp#1', spec: { command: 'npx' }, path: '.packhub/config.json' }),
        action({ op: 'exec', actionId: 'exec#1', command: 'npm', args: ['i'], approval: 'required' }),
        action({ op: 'instruction', actionId: 'instruction#1', file: 'AGENTS.md', blockId: 'demo/paths', content: 'x' }),
        action({ op: 'state.dir', actionId: 'state.dir#1', to: '.packhub/state/memory', retain: 'keep' }),
      ]),
    );

    expect(paths.sort()).toEqual(
      [
        '.packhub/cache/a.tar.gz',
        '.packhub/cache/skills/a',
        '.packhub/knowledge/doc.md',
        '.packhub/cache/tools/t',
        '.packhub/bin/t',
        '.packhub/bin/t.cmd',
        '.packhub/knowledge/gone.md',
        '.packhub/skills/s',
        '.packhub/config.json',
        'AGENTS.md',
      ].sort(),
    );
  });

  it('register.mcp 没写 path 时按默认配置落点', () => {
    const paths = planPaths(
      plan([action({ op: 'register.mcp', actionId: 'register.mcp#1', spec: { command: 'npx' } })]),
    );
    expect(paths).toEqual(['.packhub/config.json']);
  });

  it('同一路径只出现一次', () => {
    const paths = planPaths(
      plan([
        action({ op: 'write', actionId: 'write#1', to: 'AGENTS.md', content: 'a' }),
        action({ op: 'instruction', actionId: 'instruction#1', file: 'AGENTS.md', blockId: 'x', content: 'b' }),
      ]),
    );
    expect(paths).toEqual(['AGENTS.md']);
  });
});
