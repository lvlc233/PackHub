import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPackResources } from '../src/index.ts';

function registryWithPack(): string {
  const root = mkdtempSync(join(tmpdir(), 'packhub-res-'));
  const dir = join(root, 'registry/packs/demo/res/0.0.1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/res
  version: 0.0.1
  title: 资源池
  description: 给创作台拆资源用。
  targets: [dir]
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
  - id: search
    type: mcp
    source: npm:@scope/x@1.0.0
    transport: stdio
    slot: search
`,
    'utf8',
  );
  writeFileSync(
    join(root, 'registry/index.json'),
    JSON.stringify({
      apiVersion: 'packhub.dev/index/v0',
      packs: [{ name: 'demo/res', latest: '0.0.1', versions: ['0.0.1'] }],
    }),
    'utf8',
  );
  return root;
}

describe('collectPackResources', () => {
  it('拆出 metadata 与 resources', () => {
    const root = registryWithPack();
    const res = collectPackResources(root, 'demo/res');
    expect(res?.version).toBe('0.0.1');
    expect(res?.meta.title).toBe('资源池');
    expect(res?.resources.map((r) => r.id)).toEqual(['rules', 'search']);
    expect(res?.resources[1]?.slot).toBe('search');
    expect(res?.resources[1]?.transport).toBe('stdio');
    rmSync(root, { recursive: true, force: true });
  });

  it('不认识的包名/版本返回 null', () => {
    const root = registryWithPack();
    expect(collectPackResources(root, '../etc/passwd')).toBeNull();
    expect(collectPackResources(root, 'demo/res', '9.9.9')).toBeNull();
    expect(collectPackResources(root, 'demo/missing')).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});
