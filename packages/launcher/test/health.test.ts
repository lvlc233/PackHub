import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, readBaseline, writeBaseline } from '../src/index.ts';
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
    const rec = await createInstance({ name: 'h1', harness: 'dir', packDir: 'examples/doc-review' });
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
    const rec = await createInstance({ name: 'h2', harness: 'dsh', packDir: 'examples/doc-review' });
    rmSync(rec.home!, { recursive: true, force: true });
    const report = await checkInstance('h2');
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'home')?.status).toBe('fail');
  });

  it('未知实例直接报错，不是给一份空体检', async () => {
    await expect(checkInstance('nope')).rejects.toThrow('没有这个实例');
  });
});

describe('运行时版本可见（A11）', () => {
  it('新基线记下写盘时的 node 版本', async () => {
    const rec = await createInstance({ name: 'r1', harness: 'dir', packDir: 'examples/doc-review' });
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
    await createInstance({ name: 'r2', harness: 'dir', packDir: 'examples/doc-review' });

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
