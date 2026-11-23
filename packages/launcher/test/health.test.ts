import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, readBaseline, updateInstance, writeBaseline } from '../src/index.ts';
import { baselineDrift, checkInstance, runtimeCheck } from '../src/health.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-health-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  process.env.PACKHUB_HOME = join(tmp, 'home');
});

afterEach(() => {
  delete process.env.PACKHUB_INSTANCES;
  delete process.env.PACKHUB_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe('实例体检', () => {
  it('基线一致时算健康；改过/删掉 Pack 文件会被指出来', async () => {
    const rec = await createInstance({ name: 'h1', harness: 'dir', packDir: 'test/fixtures/packs/doc-review' });
    const baseline = readBaseline(rec.root)!;
    expect(baseline.files.length).toBeGreaterThan(0);

    const healthy = await checkInstance('h1');
    expect(healthy.ok).toBe(true);
    expect(healthy.checks.find((check) => check.name === 'baseline')?.status).toBe('ok');

    const target = join(rec.root, baseline.files[0]!.path);
    writeFileSync(target, 'locally edited', 'utf8');
    const second = join(rec.root, baseline.files[1]!.path);
    unlinkSync(second);

    const drift = baselineDrift(rec);
    expect(drift?.changed).toContain(baseline.files[0]!.path);
    expect(drift?.missing).toContain(baseline.files[1]!.path);

    const report = await checkInstance('h1');
    expect(report.ok).toBe(true); // 漂移是警告，不是故障
    expect(report.checks.find((check) => check.name === 'baseline')?.status).toBe('warn');
  });

  it('home 不见了算故障', async () => {
    const rec = await createInstance({ name: 'h2', harness: 'dsh', packDir: 'test/fixtures/packs/doc-review' });
    rmSync(rec.home!, { recursive: true, force: true });
    const report = await checkInstance('h2');
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'home')?.status).toBe('fail');
  });

  it('未知实例直接报错，不是给一份空体检', async () => {
    await expect(checkInstance('nope')).rejects.toThrow('没有这个实例');
  });
});

describe('attached dsh 的 MCP 检查', () => {
  /** 一份 dsh attached home：给哪些 profile 建 patch 文件（空数组）。 */
  function dshAttachedHome(name: string, profiles: string[]): { home: string; patch: (profile: string) => string } {
    const home = join(tmp, name);
    for (const profile of profiles) {
      mkdirSync(join(home, 'profiles', profile), { recursive: true });
      writeFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), '[]\n', 'utf8');
    }
    return { home, patch: (profile: string) => join(home, 'profiles', profile, 'cordis.patch.yml') };
  }

  it('记录里有 profile：只查那一个 patch；条目被删进 mcpMissing（warn，不阻断）', async () => {
    const { home, patch } = dshAttachedHome('.dsh-profile', ['web', 'desktop']);
    await createInstance({
      name: 'dsh-profile',
      harness: 'dsh',
      packDir: 'test/fixtures/packs/doc-review',
      attachedHome: home,
      profile: 'web',
    });

    const healthy = await checkInstance('dsh-profile');
    expect(healthy.ok).toBe(true);
    expect(healthy.mcpMissing).toBeUndefined();
    expect(healthy.mcp).toMatchObject({ servers: 1, wired: true, file: patch('web'), scope: 'web' });
    expect(healthy.checks.find((check) => check.name === 'mcp')?.status).toBe('ok');

    // desktop 没装过条目也不算缺：记录只认 web；它只是 scope 外「还没装」
    expect(readFileSync(patch('desktop'), 'utf8')).toBe('[]\n');
    expect(healthy.mcpMissing).toBeUndefined();
    expect(healthy.mcp?.outOfScope).toEqual(['desktop']);
    expect(healthy.checks.find((check) => check.name === 'mcp')?.detail).toContain('profile web');

    // 外部把 web 的条目删掉：health 报出来，但不把实例判成故障；outOfScope 仍是「没装」不是漂移
    writeFileSync(patch('web'), '[]\n', 'utf8');
    const broken = await checkInstance('dsh-profile');
    expect(broken.ok).toBe(true);
    expect(broken.mcp?.wired).toBe(false);
    expect(broken.mcpMissing).toEqual(['profiles/web/cordis.patch.yml:pal-mcp-markdownlint']);
    expect(broken.mcp?.outOfScope).toEqual(['desktop']);
    const mcpCheck = broken.checks.find((check) => check.name === 'mcp');
    expect(mcpCheck?.status).toBe('warn');
    expect(mcpCheck?.detail).toContain('pal-mcp-markdownlint');

    // update --profile desktop 换 scope：记录换成 desktop，条目写进 desktop，web 变成 scope 外。
    // web 的 patch 上一步被外部改过（漂移），换范围要 --force 才肯覆盖。
    const switched = await updateInstance('dsh-profile', {
      packDir: 'test/fixtures/packs/doc-review',
      profile: 'desktop',
      force: true,
    });
    expect(switched.profileChange).toEqual({ from: 'web', to: 'desktop' });
    expect(switched.record.profile).toBe('desktop');
    expect(readFileSync(patch('desktop'), 'utf8')).toContain('- id: pal-mcp-markdownlint');
    // state.written 与基线跟着换：旧 profile 的文件不再归这个包
    const state = JSON.parse(readFileSync(join(home, '.packhub/state.json'), 'utf8')) as {
      packs: Record<string, { written: { path: string; base?: string }[]; plan?: { actions?: unknown[] } }>;
    };
    const written = Object.values(state.packs).flatMap((pack) => pack.written.map((item) => item.path));
    expect(written).toContain('profiles/desktop/cordis.patch.yml');
    expect(written).not.toContain('profiles/web/cordis.patch.yml');
    const baselined = readBaseline(switched.record.root)!.files.map((file) => file.path);
    expect(baselined).toContain('profiles/desktop/cordis.patch.yml');
    expect(baselined).not.toContain('profiles/web/cordis.patch.yml');

    const after = await checkInstance('dsh-profile');
    expect(after.ok).toBe(true);
    expect(after.mcpMissing).toBeUndefined();
    expect(after.mcp).toMatchObject({ wired: true, file: patch('desktop'), scope: 'desktop' });
    expect(after.mcp?.outOfScope).toEqual(['web']);
  });

  it('换 profile 时 Pack 没有 MCP 资源：记录与 scope 也跟着换，health 照样分 scope', async () => {
    const { home } = dshAttachedHome('.dsh-no-mcp', ['web', 'desktop']);
    await createInstance({
      name: 'dsh-no-mcp',
      harness: 'dsh',
      packDir: 'test/fixtures/packs/team-conventions',
      attachedHome: home,
      profile: 'web',
    });

    const result = await updateInstance('dsh-no-mcp', {
      packDir: 'test/fixtures/packs/team-conventions',
      profile: 'desktop',
    });
    // 没有 MCP 条目，但指令块里的 MCP 配置路径随 profile 变，计划仍然变；记录一起换
    expect(result.changed).toBe(true);
    expect(result.profileChange).toEqual({ from: 'web', to: 'desktop' });
    expect(result.record.profile).toBe('desktop');

    const report = await checkInstance('dsh-no-mcp');
    expect(report.mcp?.scope).toBe('desktop');
    expect(report.mcp?.servers).toBe(0);
    expect(report.mcp?.outOfScope).toEqual(['web']);

    // 切回 all：desktop 是枚举时排第一的 profile，计划与单 desktop 逐字节相同（changed=false），
    // 但记录里的范围仍必须换成 all
    const back = await updateInstance('dsh-no-mcp', {
      packDir: 'test/fixtures/packs/team-conventions',
      profile: 'all',
    });
    expect(back.changed).toBe(false);
    expect(back.record.profile).toBeUndefined();
    const all = await checkInstance('dsh-no-mcp');
    expect(all.mcp?.scope).toBe('all');
    expect(all.mcp?.outOfScope).toBeUndefined();
  });

  it('没记 profile（all）：枚举当前所有 profile；装完后新建的 profile 缺条目进 mcpMissing，update 后消失', async () => {
    const { home, patch } = dshAttachedHome('.dsh-all', ['web', 'desktop']);
    await createInstance({
      name: 'dsh-all',
      harness: 'dsh',
      packDir: 'test/fixtures/packs/doc-review',
      attachedHome: home,
    });

    const healthy = await checkInstance('dsh-all');
    expect(healthy.ok).toBe(true);
    expect(healthy.mcpMissing).toBeUndefined();
    expect(healthy.mcp?.files).toHaveLength(2);
    // all 的 scope 覆盖所有当前 profile：没有 scope 外的
    expect(healthy.mcp?.scope).toBe('all');
    expect(healthy.mcp?.outOfScope).toBeUndefined();

    // 安装之后新建的 profile 不在 state 里：health 枚举当前 profile，报它缺条目
    mkdirSync(join(home, 'profiles', 'later'), { recursive: true });
    writeFileSync(join(home, 'profiles', 'later', 'cordis.patch.yml'), '[]\n', 'utf8');

    const fresh = await checkInstance('dsh-all');
    expect(fresh.ok).toBe(true); // mcpMissing 是警告，不阻断
    expect(fresh.mcp?.wired).toBe(false);
    expect(fresh.mcp?.files).toHaveLength(3);
    expect(fresh.mcpMissing).toEqual(['profiles/later/cordis.patch.yml:pal-mcp-markdownlint']);
    expect(fresh.checks.find((check) => check.name === 'mcp')?.status).toBe('warn');

    // 跑一次 update：计划重新枚举 profile（多了一个文件），条目补进新 profile
    await updateInstance('dsh-all', { packDir: 'test/fixtures/packs/doc-review' });
    expect(readFileSync(patch('later'), 'utf8')).toContain('- id: pal-mcp-markdownlint');

    const repaired = await checkInstance('dsh-all');
    expect(repaired.mcpMissing).toBeUndefined();
    expect(repaired.mcp?.wired).toBe(true);

    writeFileSync(patch('desktop'), '[]\n', 'utf8');
    const broken = await checkInstance('dsh-all');
    expect(broken.mcpMissing).toEqual(['profiles/desktop/cordis.patch.yml:pal-mcp-markdownlint']);
  });
});

describe('运行时版本可见（A11）', () => {
  it('新基线记下写盘时的 node 版本', async () => {
    const rec = await createInstance({ name: 'r1', harness: 'dir', packDir: 'test/fixtures/packs/doc-review' });
    expect(readBaseline(rec.root)?.runtime).toBe(process.version);
  });

  it('writeBaseline 没给 runtime 就填 process.version；旧基线缺这个字段照样能读', () => {
    const root = join(tmp, 'baseline-root');
    mkdirSync(root, { recursive: true });
    const written = writeBaseline(root, {
      pack: 'demo/rt',
      version: '0.0.1',
      harness: 'dir',
      planHash: 'sha256-demo',
      files: [],
    });
    expect(written.runtime).toBe(process.version);
    const raw = JSON.parse(readFileSync(join(root, 'baseline.json'), 'utf8')) as { runtime?: string };
    expect(raw.runtime).toBe(process.version);

    // A11 之前写的基线没有 runtime：缺省当 undefined，不报错
    writeFileSync(
      join(root, 'baseline.json'),
      JSON.stringify({
        apiVersion: 'packhub.dev/baseline/v0',
        pack: 'demo/rt',
        version: '0.0.1',
        harness: 'dir',
        planHash: 'sha256-demo',
        at: '2026-01-01T00:00:00.000Z',
        files: [],
      }),
      'utf8',
    );
    expect(readBaseline(root)?.runtime).toBeUndefined();
    // 老基线没记版本：跳过对比，不报 warn（否则每个老实例体检都多一条噪音）
    expect(runtimeCheck(readBaseline(root)?.runtime, process.version).status).toBe('ok');
  });

  it('版本不一致给 warn 且不阻断；一致时 ok', async () => {
    await createInstance({ name: 'r2', harness: 'dir', packDir: 'test/fixtures/packs/doc-review' });

    const same = await checkInstance('r2');
    expect(same.checks.find((check) => check.name === 'runtime')?.status).toBe('ok');

    // 注入一个不同的“当前运行时”：不必真换 node 就能测比较逻辑
    const report = await checkInstance('r2', { runtime: 'v0.0.1-injected' });
    const check = report.checks.find((item) => item.name === 'runtime')!;
    expect(check.status).toBe('warn');
    expect(check.detail).toBe(`运行时换过：baseline ${process.version} / 当前 v0.0.1-injected`);
    expect(report.ok).toBe(true); // 只提醒，不阻断
  });
});
