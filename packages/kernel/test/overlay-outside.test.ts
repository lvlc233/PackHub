import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor } from '../src/index.ts';

describe('overlays 不能逃出包目录', () => {
  it('从 ../ 指到包外直接报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-ov-out-'));
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/ov, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
overlays:
  - from: ./../outside
`,
      'utf8',
    );
    writeFileSync(join(dir, 'rules.md'), '# r\n', 'utf8');
    const { plan, issues } = planFor(loadPack(dir));
    expect(plan).toBeUndefined();
    expect(issues.map((i) => i.code)).toContain('overlay-outside-pack');
    rmSync(dir, { recursive: true, force: true });
  });
});
