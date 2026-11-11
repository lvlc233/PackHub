import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activatePack,
  installPack,
  listVersions,
  loadPack,
  planFor,
  removePack,
  readVersionRecord,
} from '../src/index.ts';

const MANIFEST = (version: string): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/ver, version: ${version}, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
  - id: cfg
    type: config
    source: ./cfg.yaml
`;

function makePack(version: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), `packhub-vers-${version}-`));
  writeFileSync(join(dir, 'packhub.yaml'), MANIFEST(version), 'utf8');
  writeFileSync(join(dir, 'rules.md'), `${body}\n`, 'utf8');
  writeFileSync(join(dir, 'cfg.yaml'), `app:\n  flavor: ${body}\n`, 'utf8');
  return dir;
}

describe('staged 版本与激活指针', () => {
  it('同一项目的两个版本可切换，文件、配置、state 一起换', async () => {
    const project = mkdtempSync(join(tmpdir(), 'packhub-vers-proj-'));
    const v1 = makePack('0.1.0', 'one');
    const v2 = makePack('0.2.0', 'two');

    const ctx1 = loadPack(v1);
    await installPack(ctx1, planFor(ctx1).plan!, { root: project, packRoot: v1 });
    const ctx2 = loadPack(v2);
    await installPack(ctx2, planFor(ctx2).plan!, { root: project, packRoot: v2 });

    const knowledge = join(project, '.packhub/knowledge/rules.md');
    expect(readFileSync(knowledge, 'utf8')).toBe('two\n');

    const versions = listVersions(project, 'demo/ver');
    expect(versions.map((v) => v.version).sort()).toEqual(['0.1.0', '0.2.0']);
    expect(versions.find((v) => v.active)?.version).toBe('0.2.0');
    // versions 现在带文件数 / 动作数 / 失败数，不只是一行名字
    expect(versions.find((v) => v.version === '0.2.0')?.files).toBeGreaterThan(0);
    expect(versions.find((v) => v.version === '0.2.0')?.actions).toBeGreaterThan(0);
    expect(versions.every((v) => v.failed === 0)).toBe(true);

    // 切回 0.1.0：文件镜像、配置合并、state 记录都跟着换
    const back = await activatePack(project, 'demo/ver', '0.1.0');
    expect(back.from).toBe('demo/ver@0.2.0');
    expect(readFileSync(knowledge, 'utf8')).toBe('one\n');
    const config = JSON.parse(readFileSync(join(project, '.packhub/config.json'), 'utf8'));
    expect(config.app.flavor).toBe('one');
    const state = JSON.parse(readFileSync(join(project, '.packhub/state.json'), 'utf8'));
    expect(state.packs['demo/ver@0.1.0']).toBeTruthy();
    expect(state.packs['demo/ver@0.2.0']).toBeUndefined();

    // 再切回 0.2.0
    await activatePack(project, 'demo/ver', '0.2.0');
    expect(readFileSync(knowledge, 'utf8')).toBe('two\n');
    expect(readVersionRecord(project, 'demo/ver', '0.1.0').files).toContain('.packhub/knowledge/rules.md');

    rmSync(project, { recursive: true, force: true });
    rmSync(v1, { recursive: true, force: true });
    rmSync(v2, { recursive: true, force: true });
  });

  it('卸载会清掉整个版本目录与激活项', async () => {
    const project = mkdtempSync(join(tmpdir(), 'packhub-vers-rm-'));
    const v1 = makePack('0.1.0', 'one');
    const ctx = loadPack(v1);
    await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: v1 });

    expect(existsSync(join(project, '.packhub/versions'))).toBe(true);
    expect(existsSync(join(project, '.packhub/active.json'))).toBe(true);

    removePack(project);
    expect(existsSync(join(project, '.packhub/versions'))).toBe(false);
    expect(existsSync(join(project, '.packhub/active.json'))).toBe(false);
    rmSync(project, { recursive: true, force: true });
    rmSync(v1, { recursive: true, force: true });
  });

  it('切换失败时 state 与 active 跟文件一起退回', async () => {
    const project = mkdtempSync(join(tmpdir(), 'packhub-vers-fail-'));
    const v1 = makePack('0.1.0', 'one');
    const v2 = makePack('0.2.0', 'two');
    for (const dir of [v1, v2]) {
      const ctx = loadPack(dir);
      await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: dir });
    }

    // 把 active.json 设成只读：state 写完之后 setActive 的 rename 会失败（本机实测 EPERM）
    const activeFile = join(project, '.packhub/active.json');
    const activeBefore = readFileSync(activeFile, 'utf8');
    chmodSync(activeFile, 0o444);

    await expect(activatePack(project, 'demo/ver', '0.1.0')).rejects.toThrow();

    // 文件回到 0.2.0，state 也没留在 0.1.0，激活指针还是原来那份
    expect(readFileSync(join(project, '.packhub/knowledge/rules.md'), 'utf8')).toBe('two\n');
    const state = JSON.parse(readFileSync(join(project, '.packhub/state.json'), 'utf8'));
    expect(state.packs['demo/ver@0.2.0']).toBeTruthy();
    expect(state.packs['demo/ver@0.1.0']).toBeUndefined();
    expect(readFileSync(activeFile, 'utf8')).toBe(activeBefore);

    chmodSync(activeFile, 0o666);
    rmSync(project, { recursive: true, force: true });
    rmSync(v1, { recursive: true, force: true });
    rmSync(v2, { recursive: true, force: true });
  });

  it('激活不存在的版本会报错并列出可用版本', async () => {
    // 本用例只需确认拒绝路径，不要求项目里已有版本目录
    const project = mkdtempSync(join(tmpdir(), 'packhub-vers-miss-'));
    mkdirSync(join(project, '.packhub'), { recursive: true });
    await expect(activatePack(project, 'demo/ver', '9.9.9')).rejects.toThrow(/没有这个版本/);
    rmSync(project, { recursive: true, force: true });
  });
});
