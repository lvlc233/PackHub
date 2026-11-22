import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planPathsOf } from '@packhub/kernel';
import {
  doctorPack,
  loadState,
  readVersionRecord,
  removePack,
  verifyAt,
} from '../src/index.ts';

/**
 * 「装到哪个宿主」以前叫 target，写进 state / active / record 三份本机记录里；
 * 现在字段名是 harness，且平铺目录时**字段不出现**。
 *
 * v0 没有兼容承诺：旧记录里的 `target` 读端不认，一律按平铺目录算（不会崩、也不会
 * 猜成某个宿主的落点）。装过宿主的旧安装想保留投影只能重装。
 */
const LEGACY_PLAN = {
  apiVersion: 'packhub.dev/plan/v0',
  pack: { name: 'demo/legacy', version: '0.1.0' },
  // 旧字段：读端不认
  target: 'dsh',
  actions: [
    {
      op: 'write',
      actionId: 'write#1',
      from: './rules.md',
      to: '.packhub/knowledge/rules.md',
      resource: 'rules',
    },
  ],
  verify: [{ type: 'file-exists', path: '.packhub/knowledge/rules.md' }],
  excluded: [],
  planHash: 'sha256-legacy',
};

/** 造一个「旧版本装的」项目：state / active / record 都带 target、没有 harness。 */
function legacyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-legacy-'));
  mkdirSync(join(dir, '.packhub/knowledge'), { recursive: true });
  writeFileSync(join(dir, '.packhub/knowledge/rules.md'), '# rules\n', 'utf8');
  writeFileSync(
    join(dir, '.packhub/state.json'),
    JSON.stringify(
      {
        apiVersion: 'packhub.dev/state/v0',
        packs: {
          'demo/legacy@0.1.0': {
            pack: 'demo/legacy',
            version: '0.1.0',
            planHash: 'sha256-legacy',
            installedAt: '2026-01-01T00:00:00.000Z',
            actions: [],
            written: ['.packhub/knowledge/rules.md'],
            plan: LEGACY_PLAN,
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  writeFileSync(
    join(dir, '.packhub/active.json'),
    JSON.stringify(
      {
        apiVersion: 'packhub.dev/active/v0',
        packs: {
          'demo/legacy': {
            version: '0.1.0',
            target: 'dsh',
            planHash: 'sha256-legacy',
            at: '2026-01-01T00:00:00.000Z',
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  mkdirSync(join(dir, '.packhub/versions/demo-legacy/0.1.0'), { recursive: true });
  writeFileSync(
    join(dir, '.packhub/versions/demo-legacy/0.1.0/record.json'),
    JSON.stringify(
      {
        apiVersion: 'packhub.dev/version/v0',
        pack: 'demo/legacy',
        version: '0.1.0',
        target: 'dsh',
        planHash: 'sha256-legacy',
        installedAt: '2026-01-01T00:00:00.000Z',
        plan: LEGACY_PLAN,
        actions: [],
        written: ['.packhub/knowledge/rules.md'],
        files: [],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  return dir;
}

describe('旧快照（带 target、没有 harness）按平铺目录读', () => {
  it('loadState 不认 target：plan.harness 为空，target 只当普通数据留着', () => {
    const dir = legacyProject();
    const state = loadState(dir);
    const plan = state.packs['demo/legacy@0.1.0']!.plan!;
    expect(plan.harness).toBeUndefined();
    expect((plan as unknown as { target?: string }).target).toBe('dsh');
    rmSync(dir, { recursive: true, force: true });
  });

  it('planPathsOf 按平铺算：只列 .packhub 下的产物，不套宿主的 skillsDir', () => {
    const dir = legacyProject();
    const plan = loadState(dir).packs['demo/legacy@0.1.0']!.plan!;
    expect(planPathsOf(plan)).toEqual(['.packhub/knowledge/rules.md']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('verifyAt 走项目模式、按平铺根验：不崩，检查照常 pass', async () => {
    const dir = legacyProject();
    const res = await verifyAt(dir);
    expect(res.mode).toBe('installed');
    expect(res.ready).toBe(true);
    expect(res.failed).toBe(0);
    expect(res.installed[0]!.pack).toBe('demo/legacy@0.1.0');
    expect(res.results.map((r) => [r.type, r.status])).toEqual([['file-exists', 'pass']]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('removePack 按平铺的 written 摘干净，state 一起收走', () => {
    const dir = legacyProject();
    const removed = removePack(dir);
    expect(removed.removed).toContain('.packhub/knowledge/rules.md');
    expect(existsSync(join(dir, '.packhub/knowledge/rules.md'))).toBe(false);
    expect(existsSync(join(dir, '.packhub/state.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('active.json / record.json 里的旧 target 不参与判定：doctor 不报漂移、记录按原样读回', () => {
    const dir = legacyProject();
    // active 里写的是 flat 装法（没有 harness），doctor 不该把它当成宿主投影去核对
    const doctor = doctorPack(dir);
    expect(doctor.ok).toBe(true);
    expect(doctor.findings).toEqual([]);

    const record = readVersionRecord(dir, 'demo/legacy', '0.1.0');
    expect(record.harness).toBeUndefined();
    expect((record as unknown as { target?: string }).target).toBe('dsh');
    rmSync(dir, { recursive: true, force: true });
  });
});
