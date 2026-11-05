import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor } from '../src/index.ts';

describe('config 资源只收本地片段', () => {
  it('远程 config 直接报错，不再静默合并空对象', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-cfg-src-'));
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/cfg, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: cfg
    type: config
    source: https://example.com/config.yaml
    integrity: sha256-AAAA
`,
      'utf8',
    );
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    expect(issues.map((i) => i.code)).toContain('config-source-unsupported');
    rmSync(dir, { recursive: true, force: true });
  });
});
