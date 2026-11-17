import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json' with { type: 'json' };
import type { Manifest, Plan } from '../src/index.ts';
import { buildLock } from '../src/index.ts';

const MANIFEST: Manifest = {
  apiVersion: 'packhub.dev/v0',
  kind: 'Pack',
  metadata: { name: 'demo/lock', version: '0.0.1', targets: ['dir'] },
  requires: { packhub: '>=0.0.1 <0.1' },
  resources: [],
};

function plan(target: Plan['target'] = 'dir'): Plan {
  return {
    apiVersion: 'packhub.dev/plan/v0',
    pack: { name: 'demo/lock', version: '0.0.1' },
    target,
    actions: [],
    verify: [],
    excluded: [],
    planHash: `sha256-${target}`,
  };
}

describe('buildLock', () => {
  it('generatedBy 取仓库 package.json 的版本，不留手写字面量', () => {
    const lock = buildLock(MANIFEST, plan());
    expect(lock.generatedBy).toBe(`packhub/${pkg.version}`);
  });

  it('主计划之外的多 target 快照进 plans，主计划本身仍在 plan', () => {
    const lock = buildLock(MANIFEST, plan('dir'), { plans: [plan('dir'), plan('dsh')] });
    expect(lock.plan?.target).toBe('dir');
    expect(lock.plans?.dsh?.planHash).toBe('sha256-dsh');
    // 只有一个 target 时不写空的 plans
    expect(buildLock(MANIFEST, plan('dir')).plans).toBeUndefined();
  });
});
