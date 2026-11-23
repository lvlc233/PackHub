import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, removePack } from '../src/index.ts';

/**
 * 旧 state 的 `written` 是 `string[]`：读端按 base='root' 兼容，不为了读回写文件；
 * uninstall 仍然按它摘干净。
 */
function legacyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-written-'));
  mkdirSync(join(dir, '.packhub/knowledge'), { recursive: true });
  writeFileSync(join(dir, '.packhub/knowledge/rules.md'), '# rules\n', 'utf8');
  writeFileSync(
    join(dir, '.packhub/state.json'),
    JSON.stringify(
      {
        apiVersion: 'packhub.dev/state/v0',
        packs: {
          'demo/legacy@0.1.0': {
            pack: 'demo/legacy',
            version: '0.1.0',
            planHash: 'sha256-legacy',
            installedAt: '2026-01-01T00:00:00.000Z',
            actions: [],
            written: ['.packhub/knowledge/rules.md'],
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  return dir;
}

describe('state.written 的旧形状兼容', () => {
  it('string[] 按 root 读；读不重写 state；removePack 正常摘除', () => {
    const dir = legacyProject();
    const state = loadState(dir);
    expect(state.packs['demo/legacy@0.1.0']!.written).toEqual([
      { path: '.packhub/knowledge/rules.md', base: 'root' },
    ]);
    expect(state.packs['demo/legacy@0.1.0']!.home).toBeUndefined();

    const removed = removePack(dir);
    expect(removed.removed).toContain('.packhub/knowledge/rules.md');
    expect(existsSync(join(dir, '.packhub/knowledge/rules.md'))).toBe(false);
    expect(existsSync(join(dir, '.packhub/state.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
