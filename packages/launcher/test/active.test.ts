import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/index.ts';
import { activeEntries, activeInstance, clearActive, readActive, setActive } from '../src/active.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-active-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  // 建实例会读全局配置（默认隔离策略），指到 tmp 里，别读开发机上的 ~/.packhub/config.json
  process.env.PACKHUB_HOME = join(tmp, 'home');
});

afterEach(() => {
  delete process.env.PACKHUB_INSTANCES;
  delete process.env.PACKHUB_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe('实例切换', () => {
  it('按宿主记住当前实例，不排斥其它实例', async () => {
    const a = await createInstance({ name: 'a', harness: 'dsh', packDir: 'examples/doc-review' });
    const b = await createInstance({ name: 'b', harness: 'dsh', packDir: 'examples/doc-review' });

    setActive('a');
    expect(readActive().dsh).toBe(a.id);
    expect(activeInstance('dsh')?.id).toBe(a.id);
    expect(activeEntries().map((entry) => entry.record?.id)).toEqual([a.id]);

    setActive(b.id);
    expect(activeInstance('dsh')?.id).toBe(b.id);

    clearActive();
    expect(activeInstance('dsh')).toBeUndefined();
  });
});
