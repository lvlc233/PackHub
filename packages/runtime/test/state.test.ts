import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorPack, installPack, loadPack, planFor, removePack, rollbackPack } from '../src/index.ts';

function scaffold(version: string, state: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-state-'));
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/memory, version: ${version}, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
${state}
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`,
    'utf8',
  );
  writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
  return dir;
}

const DEFAULT_STATE = `state:
  - id: memory
    description: 长期记忆
`;

describe('持久状态目录的生命周期', () => {
  it('安装建目录并记录；卸载默认保留目录与数据', async () => {
    const dir = scaffold('0.0.1', DEFAULT_STATE);
    const ctx = loadPack(dir);
    const plan = planFor(ctx).plan!;
    const result = await installPack(ctx, plan);
    expect(result.outcomes.some((o) => o.op === 'state.dir' && o.status === 'done')).toBe(true);

    const stateDir = join(dir, '.packhub/state/memory');
    expect(existsSync(stateDir)).toBe(true);
    writeFileSync(join(stateDir, 'notes.md'), '记忆\n', 'utf8');

    const state = JSON.parse(readFileSync(join(dir, '.packhub/state.json'), 'utf8'));
    expect(state.packs['demo/memory@0.0.1'].stateDirs).toEqual([
      { id: 'memory', path: '.packhub/state/memory', retain: 'keep' },
    ]);

    const removed = removePack(dir);
    expect(removed.kept).toContain('.packhub/state/memory');
    expect(existsSync(join(stateDir, 'notes.md'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('retain: remove 才跟随卸载删除', async () => {
    const dir = scaffold(
      '0.0.1',
      `state:
  - id: memory
    retain: remove
`,
    );
    const ctx = loadPack(dir);
    await installPack(ctx, planFor(ctx).plan!);
    const stateDir = join(dir, '.packhub/state/memory');
    expect(existsSync(stateDir)).toBe(true);

    const removed = removePack(dir);
    expect(removed.removed).toContain('.packhub/state/memory');
    expect(existsSync(stateDir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('升级换版本时目录里的数据不动，state 合并旧记录', async () => {
    const dir = scaffold('0.0.1', DEFAULT_STATE);
    const first = loadPack(dir);
    await installPack(first, planFor(first).plan!);
    writeFileSync(join(dir, '.packhub/state/memory/notes.md'), '保留\n', 'utf8');

    writeFileSync(
      join(dir, 'packhub.yaml'),
      readFileSync(join(dir, 'packhub.yaml'), 'utf8').replace('version: 0.0.1', 'version: 0.0.2'),
      'utf8',
    );
    const second = loadPack(dir);
    await installPack(second, planFor(second).plan!);

    expect(readFileSync(join(dir, '.packhub/state/memory/notes.md'), 'utf8')).toBe('保留\n');
    const state = JSON.parse(readFileSync(join(dir, '.packhub/state.json'), 'utf8'));
    expect(Object.keys(state.packs)).toEqual(['demo/memory@0.0.2']);
    expect(state.packs['demo/memory@0.0.2'].stateDirs).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('状态目录被删掉时 doctor 报出来，且回滚不碰它', async () => {
    const dir = scaffold('0.0.1', DEFAULT_STATE);
    const ctx = loadPack(dir);
    await installPack(ctx, planFor(ctx).plan!);
    writeFileSync(join(dir, '.packhub/state/memory/notes.md'), '数据\n', 'utf8');

    rmSync(join(dir, '.packhub/state/memory'), { recursive: true, force: true });
    const report = doctorPack(dir);
    expect(report.ok).toBe(false);
    expect(report.findings[0]!.stateMissing).toContain('.packhub/state/memory');

    // 回滚走的是安装快照，不应该把状态目录当成本次新建的产物删掉
    mkdirSync(join(dir, '.packhub/state/memory'), { recursive: true });
    writeFileSync(join(dir, '.packhub/state/memory/keep.md'), 'x\n', 'utf8');
    rollbackPack(dir);
    expect(existsSync(join(dir, '.packhub/state/memory/keep.md'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('state 写了别的主版本 → 拒绝读取，不当成 v0 接着装', async () => {
    const dir = scaffold('0.0.1', DEFAULT_STATE);
    const ctx = loadPack(dir);
    const plan = planFor(ctx).plan!;
    await installPack(ctx, plan);

    const file = join(dir, '.packhub/state.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...parsed, apiVersion: 'packhub.dev/state/v1' }, null, 2), 'utf8');

    await expect(installPack(ctx, plan)).rejects.toThrow(/格式版本不认识/);
    expect(() => doctorPack(dir)).toThrow(/格式版本不认识/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('两个包声明同一状态目录时算所有权冲突', async () => {
    const a = scaffold('0.0.1', DEFAULT_STATE);
    const ctxA = loadPack(a);
    await installPack(ctxA, planFor(ctxA).plan!);

    const b = scaffold('0.0.1', DEFAULT_STATE);
    writeFileSync(
      join(b, 'packhub.yaml'),
      readFileSync(join(b, 'packhub.yaml'), 'utf8').replace('demo/memory', 'demo/memory-two'),
      'utf8',
    );
    // 装到 a 的目录里，模拟同项目的第二个包
    const ctxB = loadPack(b);
    await expect(installPack(ctxB, planFor(ctxB).plan!, { root: a })).rejects.toThrow(
      /已被别的包占用/,
    );
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });
});
