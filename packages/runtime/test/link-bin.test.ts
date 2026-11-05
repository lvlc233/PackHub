import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan, loadPack, planFor } from '../src/index.ts';
import type { Plan } from '@packhub/kernel';

function toolPlan(): Plan {
  return {
    apiVersion: 'packhub.dev/plan/v0',
    pack: { name: 'demo/bin', version: '0.0.1' },
    target: 'dir',
    planHash: 'sha256-test',
    excluded: [],
    verify: [],
    actions: [
      {
        actionId: 'write#1',
        op: 'write',
        to: '.packhub/cache/tools/demo/package.json',
        content: JSON.stringify({ name: 'demo', version: '1.0.0', bin: { 'demo-cli': 'bin/cli.js' } }),
        resource: 'demo',
      },
      {
        actionId: 'write#2',
        op: 'write',
        to: '.packhub/cache/tools/demo/bin/cli.js',
        content: '#!/usr/bin/env node\nconsole.log("demo:" + process.argv.slice(2).join(" "));\n',
        resource: 'demo',
      },
      {
        actionId: 'link.bin#1',
        op: 'link.bin',
        from: '.packhub/cache/tools/demo',
        to: '.packhub/bin/demo-cli',
        command: 'demo-cli',
        resource: 'demo',
        dependsOn: ['write#2'],
      },
    ],
  };
}

describe('tool 的可执行入口', () => {
  it('按 package.json 的 bin 生成 wrapper，并能真的执行', async () => {
    const project = mkdtempSync(join(tmpdir(), 'packhub-bin-'));
    const result = await applyPlan(toolPlan(), { root: project, packRoot: project });
    expect(result.outcomes.map((o) => o.status)).toEqual(['done', 'done', 'done']);

    const shim = join(project, '.packhub/bin/demo-cli');
    const cmd = `${shim}.cmd`;
    expect(existsSync(shim)).toBe(true);
    expect(existsSync(cmd)).toBe(true);
    expect(readFileSync(shim, 'utf8')).toContain('cli.js');

    const res =
      process.platform === 'win32'
        ? spawnSync(cmd, ['hello'], { encoding: 'utf8', shell: true })
        : spawnSync(shim, ['hello'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(`${res.stdout}`).toContain('demo:hello');

    const state = JSON.parse(readFileSync(join(project, '.packhub/state.json'), 'utf8'));
    const written = state.packs['demo/bin@0.0.1'].written as string[];
    expect(written).toContain('.packhub/bin/demo-cli');
    expect(written).toContain('.packhub/bin/demo-cli.cmd');

    rmSync(project, { recursive: true, force: true });
  });

  it('清单里的 tool 资源生成 link.bin，可用 config.bin 改命令名', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-bin-plan-'));
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/tool, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: lint
    type: tool
    source: npm:markdownlint-cli2@0.14.0
    config: { bin: markdownlint }
`,
      'utf8',
    );
    const { plan } = planFor(loadPack(dir));
    expect(plan).toBeTruthy();
    expect(plan!.actions.map((a) => a.op)).toEqual(['fetch', 'unpack', 'link.bin']);
    const link = plan!.actions.find((a) => a.op === 'link.bin');
    expect(link && 'to' in link ? link.to : '').toBe('.packhub/bin/markdownlint');
    rmSync(dir, { recursive: true, force: true });
  });

  it('package.json 没有 bin 时明确失败，不留下假入口', async () => {
    const project = mkdtempSync(join(tmpdir(), 'packhub-bin-'));
    const plan = toolPlan();
    plan.actions = plan.actions.map((a) =>
      a.op === 'write' && a.to.endsWith('package.json')
        ? { ...a, content: JSON.stringify({ name: 'demo', version: '1.0.0' }) }
        : a,
    );
    const result = await applyPlan(plan, { root: project, packRoot: project });
    expect(result.rolledBack).toBe(true);
    expect(result.outcomes.some((o) => o.status === 'failed')).toBe(true);
    expect(existsSync(join(project, '.packhub/bin/demo-cli'))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });
});
