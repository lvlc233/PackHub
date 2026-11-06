import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, listInstances, readInstance, removeInstance } from '../src/index.ts';

const PACK = 'examples/doc-review';

describe('实例配置', () => {
  it('从 Pack 创建：写实例记录、装进实例根、能列出与删除', async () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-instance-'));
    process.env.PACKHUB_INSTANCES = join(base, 'instances');
    try {
      const record = await createInstance({ name: 'demo', harness: 'dir', packDir: PACK });
      expect(record.name).toBe('demo');
      expect(record.harness).toBe('dir');
      expect(record.pack).toEqual({ name: 'lvlc233/doc-review', version: '0.1.0' });
      expect(existsSync(join(record.root, 'instance.json'))).toBe(true);
      expect(existsSync(join(record.root, '.packhub', 'state.json'))).toBe(true);

      const listed = listInstances();
      expect(listed.map((i) => i.name)).toEqual(['demo']);
      expect(readInstance(record.id)?.name).toBe('demo');

      removeInstance('demo');
      expect(listInstances()).toEqual([]);
      expect(existsSync(record.root)).toBe(false);
    } finally {
      delete process.env.PACKHUB_INSTANCES;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('重名与未声明的 target 都拒绝', async () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-instance-'));
    process.env.PACKHUB_INSTANCES = join(base, 'instances');
    try {
      await createInstance({ name: 'dup', harness: 'dir', packDir: PACK });
      await expect(createInstance({ name: 'dup', harness: 'dir', packDir: PACK })).rejects.toThrow('实例名已存在');
      await expect(createInstance({ name: 'dsh-inst', harness: 'dsh', packDir: PACK })).resolves.toBeTruthy();
      await expect(createInstance({ name: 'codex-only', harness: 'codex', packDir: PACK })).rejects.toThrow(
        '没有声明 target codex',
      );
    } finally {
      delete process.env.PACKHUB_INSTANCES;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
