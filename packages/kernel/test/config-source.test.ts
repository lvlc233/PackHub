import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor } from '../src/index.ts';

describe('config 资源', () => {
  it('远程片段就是一份文件：照常 fetch，不合并进别处', () => {
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
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    const fetch = plan!.actions.find((a) => a.op === 'fetch');
    expect(fetch && fetch.op === 'fetch' ? fetch.dest : '').toBe('.packhub/config/config.yaml');
    rmSync(dir, { recursive: true, force: true });
  });
});
