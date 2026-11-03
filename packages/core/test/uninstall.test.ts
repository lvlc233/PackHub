import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPack, loadPack, planFor, removePack } from '../src/index.ts';

const EXAMPLE = fileURLToPath(new URL('../../../examples/team-conventions/', import.meta.url));

function work(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-rm-'));
  cpSync(EXAMPLE, dir, { recursive: true });
  rmSync(join(dir, '.packhub'), { recursive: true, force: true });
  return dir;
}

describe('卸载', () => {
  it('按 state 删掉装过的文件，state 一起清空', async () => {
    const dir = work();
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    await installPack(ctx, plan!);
    expect(existsSync(join(dir, '.packhub/knowledge/style-guide.md'))).toBe(true);

    const res = removePack(dir);
    expect(res.removed.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, '.packhub/knowledge/style-guide.md'))).toBe(false);
    expect(existsSync(join(dir, '.packhub/state.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('没有记录时是空操作', () => {
    const dir = work();
    const res = removePack(dir);
    expect(res.removed).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('安装锁存在时拒绝并发安装，并指出持有者', async () => {
    const dir = work();
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    mkdirSync(join(dir, '.packhub'), { recursive: true });
    writeFileSync(join(dir, '.packhub/installing.lock'), '12345', 'utf8');
    await expect(installPack(ctx, plan!)).rejects.toThrow(/另一个安装正在进行.*12345/);
    rmSync(dir, { recursive: true, force: true });
  });
});
