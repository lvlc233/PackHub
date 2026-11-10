import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/index.ts';

const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/homes, version: 0.1.0, targets: [dir, codex, claude-code] }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`;

let tmp: string;
let packDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-homes-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
  // 建实例会读全局配置（默认隔离策略），指到 tmp 里，别读开发机上的真实 pal.json
  process.env.PACKHUB_HOME = join(tmp, 'home');
  packDir = join(tmp, 'pack');
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, 'rules.md'), '# rules\n', 'utf8');
  writeFileSync(join(packDir, 'packhub.yaml'), MANIFEST, 'utf8');
});

afterEach(() => {
  delete process.env.PACKHUB_INSTANCES;
  delete process.env.PACKHUB_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe('各宿主的实例 home', () => {
  it('codex 与 claude-code 的资源落进各自的 home', async () => {
    for (const harness of ['codex', 'claude-code'] as const) {
      const rec = await createInstance({ name: `h-${harness}`, harness, packDir });
      const dir = harness === 'codex' ? 'codex' : 'claude';
      expect(rec.home).toBe(join(rec.root, 'home', dir));
      expect(existsSync(join(rec.root, 'home', dir, 'knowledge', 'rules.md'))).toBe(true);
    }
  });

  it('dir 没有 home 段', async () => {
    const rec = await createInstance({ name: 'h-dir', harness: 'dir', packDir });
    expect(rec.home).toBeUndefined();
  });
});
