import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, readBaseline } from '../src/index.ts';
import { baselineDrift, checkInstance } from '../src/health.ts';

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
