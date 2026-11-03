import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPack, planFor, removePack } from '../src/index.ts';

const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/merge, version: 0.0.1, targets: [dir] }
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
    mkdirSync(join(dir, '.packhub'), { recursive: true });
    writeFileSync(join(dir, '.packhub/config.json'), userConfig, 'utf8');
  }
  const ctx = loadPack(dir);
  await installPack(ctx, planFor(ctx).plan!);
  return dir;
}

describe('merge.config 的可逆性', () => {
  it('卸载后还原用户原来的值，保留用户其它键', async () => {
    const dir = await project('{\n  "editor": { "tabSize": 8, "mine": true },\n  "userKey": 1\n}\n');
    const after = JSON.parse(readFileSync(join(dir, '.packhub/config.json'), 'utf8')) as {
      editor: { tabSize: number; strict: boolean; mine: boolean };
      userKey: number;
    };
    expect(after.editor.tabSize).toBe(2);
    expect(after.editor.strict).toBe(true);
    expect(after.userKey).toBe(1);

    removePack(dir);
    const restored = JSON.parse(readFileSync(join(dir, '.packhub/config.json'), 'utf8')) as {
      editor: { tabSize: number; strict?: boolean; mine: boolean };
      userKey: number;
    };
    expect(restored.editor.tabSize).toBe(8);
    expect(restored.editor.strict).toBeUndefined();
    expect(restored.editor.mine).toBe(true);
    expect(restored.userKey).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('原来没有这个文件时，卸载后整个文件消失（不留空壳）', async () => {
    const dir = await project();
    expect(existsSync(join(dir, '.packhub/config.json'))).toBe(true);
    removePack(dir);
    expect(existsSync(join(dir, '.packhub/config.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rollback 走快照，也能回到合并前', async () => {
    const dir = await project('{\n  "editor": { "tabSize": 8 }\n}\n');
    const { rollbackPack } = await import('../src/index.ts');
    rollbackPack(dir);
    const restored = JSON.parse(readFileSync(join(dir, '.packhub/config.json'), 'utf8')) as {
      editor: { tabSize: number; strict?: boolean };
    };
    expect(restored.editor.tabSize).toBe(8);
    expect(restored.editor.strict).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
