import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLock, loadPack, planFor } from '@packhub/kernel';
import { packArchive, updatePack } from '../src/index.ts';

/** 造一个最小 registry：index + 两个版本归档。`extraResource` 只加在 0.2.0 上，用来让 diff 有内容。 */
async function registry(extraResource = ''): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'packhub-upd-reg-'));
  const mk = async (version: string, content: string): Promise<void> => {
    const dir = join(root, 'packs/demo/upd', version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/upd, version: ${version} }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
${version === '0.2.0' ? extraResource : ''}`,
      'utf8',
    );
    writeFileSync(join(dir, 'rules.md'), content, 'utf8');
    if (version === '0.2.0' && extraResource) writeFileSync(join(dir, 'extra.md'), '# extra\n', 'utf8');
    await packArchive(dir, { vendored: true, out: join(root, 'packs/demo/upd', `${version}.phub`) });
  };
  await mk('0.1.0', '# v1\n');
  await mk('0.2.0', '# v2\n');
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify(
      {
        apiVersion: 'packhub.dev/index/v0',
        packs: [{ name: 'demo/upd', latest: '0.2.0', versions: ['0.1.0', '0.2.0'], trust: 'community' }],
      },
      null,
      2,
    ),
    'utf8',
  );
  return root;
}

describe('update', () => {
  it('装 0.1.0 后更新到 0.2.0，内容与 state 都对', async () => {
    const reg = await registry();
    const project = mkdtempSync(join(tmpdir(), 'packhub-upd-proj-'));
    const index = join(reg, 'index.json');

    // 先装旧版本：直接走 updatePack 会取 latest，所以用 add 的等价路径
    const { fetchPack } = await import('../src/index.ts');
    const { installPack, loadPack } = await import('../src/index.ts');
    const dest = join(project, '.packhub/packs/demo/upd');
    await fetchPack({ name: 'demo/upd', index, version: '0.1.0', dest });
    const ctx = loadPack(dest);
    await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: dest });
    expect(readFileSync(join(project, '.packhub/knowledge/rules.md'), 'utf8')).toBe('# v1\n');

    const res = await updatePack({ name: 'demo/upd', index, projectDir: project });
    expect(res.changed).toBe(true);
    expect(res.to).toBe('demo/upd@0.2.0');
    expect(readFileSync(join(project, '.packhub/knowledge/rules.md'), 'utf8')).toBe('# v2\n');

    const state = JSON.parse(readFileSync(join(project, '.packhub/state.json'), 'utf8'));
    expect(state.packs['demo/upd@0.2.0']).toBeTruthy();
    rmSync(reg, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('state 里存的是计划快照（无 apiVersion/pack），update 的 diff 仍正确', async () => {
    const reg = await registry('  - id: extra\n    type: knowledge\n    source: ./extra.md\n');
    const project = mkdtempSync(join(tmpdir(), 'packhub-upd-snap-'));
    const index = join(reg, 'index.json');
    const { fetchPack, installPack, loadPack } = await import('../src/index.ts');

    const dest = join(project, '.packhub/packs/demo/upd');
    await fetchPack({ name: 'demo/upd', index, version: '0.1.0', dest });
    const oldCtx = loadPack(dest);
    await installPack(oldCtx, planFor(oldCtx).plan!, { root: project, packRoot: dest });

    const before = JSON.parse(readFileSync(join(project, '.packhub/state.json'), 'utf8')).packs[
      'demo/upd@0.1.0'
    ].plan;
    expect(before).not.toHaveProperty('apiVersion');
    expect(before).not.toHaveProperty('pack');
    expect(Object.keys(before).sort()).toEqual(['actions', 'excluded', 'planHash', 'verify']);

    const res = await updatePack({ name: 'demo/upd', index, projectDir: project });
    expect(res.changed).toBe(true);
    expect(res.added.some((line) => line.includes('extra.md'))).toBe(true);
    expect(res.removed).toEqual([]);

    const after = JSON.parse(readFileSync(join(project, '.packhub/state.json'), 'utf8')).packs[
      'demo/upd@0.2.0'
    ].plan;
    expect(after).not.toHaveProperty('apiVersion');
    expect(after).not.toHaveProperty('pack');
    rmSync(reg, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('已是最新时 changed=false 且不产生新 generation', async () => {
    const reg = await registry();
    const project = mkdtempSync(join(tmpdir(), 'packhub-upd2-'));
    const index = join(reg, 'index.json');
    const first = await updatePack({ name: 'demo/upd', index, projectDir: project });
    expect(first.changed).toBe(true);
    const gens = JSON.parse(readFileSync(join(project, '.packhub/state.json'), 'utf8')).generations;
    const second = await updatePack({ name: 'demo/upd', index, projectDir: project });
    expect(second.changed).toBe(false);
    const gens2 = JSON.parse(readFileSync(join(project, '.packhub/state.json'), 'utf8')).generations;
    expect(gens2.length).toBe(gens.length);
    rmSync(reg, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
});
describe('update 的锁核对', () => {
  /** 先按清单 lock 一份，再改清单：归档里的锁就过期了。 */
  async function staleLockRegistry(): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), 'packhub-upd-stale-'));
    const dir = join(root, 'packs/demo/stale/0.2.0');
    mkdirSync(dir, { recursive: true });
    const manifest = (extra: string): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/stale, version: 0.2.0 }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
${extra}`;
    writeFileSync(join(dir, 'packhub.yaml'), manifest(''), 'utf8');
    writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');

    const ctx = loadPack(dir);
    writeFileSync(
      join(dir, 'packhub.lock.json'),
      JSON.stringify(buildLock(ctx.manifest!), null, 2),
      'utf8',
    );

    // 锁定之后再加一个资源：锁的 contentHash 与当前清单对不上
    writeFileSync(
      join(dir, 'packhub.yaml'),
      manifest('  - id: extra\n    type: knowledge\n    source: ./extra.md\n'),
      'utf8',
    );
    writeFileSync(join(dir, 'extra.md'), '# extra\n', 'utf8');
    await packArchive(dir, { vendored: true, out: join(root, 'packs/demo/stale/0.2.0.phub') });

    writeFileSync(
      join(root, 'index.json'),
      JSON.stringify(
        {
          apiVersion: 'packhub.dev/index/v0',
          packs: [{ name: 'demo/stale', latest: '0.2.0', versions: ['0.2.0'] }],
        },
        null,
        2,
      ),
      'utf8',
    );
    return root;
  }

  it('锁过期时默认拒绝（文案不变），传 allowStaleLock 才继续', async () => {
    const reg = await staleLockRegistry();
    const project = mkdtempSync(join(tmpdir(), 'packhub-upd-stale-proj-'));
    const opts = { name: 'demo/stale', index: join(reg, 'index.json'), projectDir: project };

    await expect(updatePack(opts)).rejects.toThrow(
      '新版本的锁与清单对不上（清单在锁定后被改过）；确认后用 --allow-stale-lock 继续',
    );
    // 拒绝发生在安装之前：一个文件都不该写
    expect(existsSync(join(project, '.packhub/state.json'))).toBe(false);
    expect(existsSync(join(project, '.packhub/knowledge/rules.md'))).toBe(false);

    const res = await updatePack({ ...opts, allowStaleLock: true });
    expect(res.changed).toBe(true);
    expect(res.to).toBe('demo/stale@0.2.0');
    expect(readFileSync(join(project, '.packhub/knowledge/rules.md'), 'utf8')).toBe('# rules\n');
    expect(existsSync(join(project, '.packhub/knowledge/extra.md'))).toBe(true);

    rmSync(reg, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
});

describe('unlisted', () => {
  it('索引里没有这个包，但给了版本就能装（unlisted）', async () => {
    const reg = await registry();
    const project = mkdtempSync(join(tmpdir(), 'packhub-unl-'));
    const { fetchPack } = await import('../src/index.ts');
    const dest = join(project, '.packhub/packs/demo/upd');

    // 正常情况下索引里没这个包就该报错
    await expect(
      fetchPack({ name: 'demo/missing', index: join(reg, 'index.json'), dest }),
    ).rejects.toThrow(/索引里没有这个包/);

    // unlisted：知道确切名称与版本，允许绕过索引
    const res = await fetchPack({
      name: 'demo/upd',
      index: join(reg, 'index.json'),
      version: '0.1.0',
      allowUnlisted: true,
      dest,
    });
    expect(res.version).toBe('0.1.0');
    rmSync(reg, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
});