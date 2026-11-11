import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sidecarCommand } from '../sidecar.js';

const slash = (p: string): string => p.replaceAll('\\', '/');

describe('侧车的启动方式', () => {
  it('dev：跑仓库源码，参数带 strip-types 与「关 stdin 就退」', () => {
    const cmd = sidecarCommand({ packaged: false, repoRoot: 'G:/repo', env: {} });
    expect(cmd.command).toBe('node');
    expect(cmd.args[0]).toBe('--experimental-strip-types');
    expect(slash(cmd.args[1]!)).toBe('G:/repo/packages/launcher/src/bin.ts');
    expect(cmd.args).toContain('--exit-on-stdin-close');
    expect(slash(cmd.cwd)).toBe('G:/repo');
  });

  it('dev：PAL_NODE 可换掉 node 可执行文件', () => {
    const cmd = sidecarCommand({ packaged: false, repoRoot: '/r', env: { PAL_NODE: '/opt/node' } });
    expect(cmd.command).toBe('/opt/node');
  });

  it('打包：用 resources/runtime 下的 node 与 pal.cjs', () => {
    const res = mkdtempSync(join(tmpdir(), 'pal-pack-'));
    const runtime = join(res, 'runtime');
    mkdirSync(runtime);
    const node = join(runtime, process.platform === 'win32' ? 'node.exe' : 'node');
    writeFileSync(node, '', 'utf8');
    writeFileSync(join(runtime, 'pal.cjs'), '', 'utf8');

    const cmd = sidecarCommand({ packaged: true, repoRoot: '/ignored', resourcesPath: res, env: {} });
    expect(cmd.command).toBe(node);
    expect(cmd.args[0]).toBe(join(runtime, 'pal.cjs'));
    expect(cmd.cwd).toBe(runtime);

    rmSync(res, { recursive: true, force: true });
  });

  it('打包但缺文件：说清缺哪个，而不是等 spawn 才炸 ENOENT', () => {
    const res = mkdtempSync(join(tmpdir(), 'pal-pack-miss-'));
    expect(() => sidecarCommand({ packaged: true, repoRoot: '/x', resourcesPath: res, env: {} })).toThrow(
      /pal\.cjs/,
    );
    rmSync(res, { recursive: true, force: true });
  });
});
