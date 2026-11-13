import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPack, planFor, removePack } from '../src/index.ts';

const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/cfg-file, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: cfg
    type: config
    source: ./fragment.yaml
`;

async function project(userConfig?: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-inv-'));
  writeFileSync(join(dir, 'packhub.yaml'), MANIFEST, 'utf8');
  writeFileSync(join(dir, 'fragment.yaml'), 'editor:\n  tabSize: 2\n  strict: true\n', 'utf8');
  if (userConfig !== undefined) {
    // 用户自己的同名文件：config 资源整份覆盖，不合并
    writeFileSync(join(dir, 'fragment.yaml.user'), userConfig, 'utf8');
  }
  const ctx = loadPack(dir);
  await installPack(ctx, planFor(ctx).plan!);
  return dir;
}

describe('config 作为文件的可逆性', () => {
  it('装完落在 config 目录，内容是资源原文', async () => {
    const dir = await project();
    const file = join(dir, '.packhub/config/fragment.yaml');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('tabSize: 2');
    rmSync(dir, { recursive: true, force: true });
  });

  it('卸载后文件消失，不留空壳', async () => {
    const dir = await project();
    expect(existsSync(join(dir, '.packhub/config/fragment.yaml'))).toBe(true);
    removePack(dir);
    expect(existsSync(join(dir, '.packhub/config/fragment.yaml'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rollback 走快照，也能回到安装前', async () => {
    const dir = await project();
    const { rollbackPack } = await import('../src/index.ts');
    rollbackPack(dir);
    expect(existsSync(join(dir, '.packhub/config/fragment.yaml'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
