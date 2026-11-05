import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishPack, writeIndex } from '../src/index.ts';
import {
  fetchPack,
  flattenPack,
  generateKeyPair,
  installPack,
  loadPackResolved,
  packArchive,
  planFor,
  readSignatures,
  signPlan,
  verifySignatures,
  writeSignature,
} from '@packhub/runtime';

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.PACKHUB_INDEX;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('发布前扁平化', () => {
  it('远程 extends 的包能发布成自包含版本，消费端不需要父包', async () => {
    const regIn = temp('packhub-flat-reg-');
    const base = join(regIn, 'base-src');
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/base, version: 1.0.0, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: shared
    type: knowledge
    source: ./shared.md
verify:
  - type: file-exists
    path: "\${target.knowledgeDir}/shared.md"
`,
      'utf8',
    );
    writeFileSync(join(base, 'shared.md'), '# shared\n', 'utf8');
    await packArchive(base, { vendored: true, out: join(regIn, 'packs/demo/base/1.0.0.phub') });
    const indexIn = join(regIn, 'index.json');
    writeFileSync(
      indexIn,
      JSON.stringify({
        apiVersion: 'packhub.dev/index/v0',
        packs: [{ name: 'demo/base', latest: '1.0.0', versions: ['1.0.0'], trust: 'community' }],
      }),
      'utf8',
    );
    process.env.PACKHUB_INDEX = indexIn;

    const child = temp('packhub-flat-child-');
    writeFileSync(
      join(child, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
extends: packhub://demo/base@1.0.0
metadata: { name: demo/flat, version: 0.1.0, targets: [dir], visibility: public }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: own
    type: knowledge
    source: ./own.md
`,
      'utf8',
    );
    writeFileSync(join(child, 'own.md'), '# own\n', 'utf8');

    const flat = await flattenPack(child, { index: indexIn });
    try {
      expect(flat.manifest.extends).toBeUndefined();
      const byId = new Map(flat.manifest.resources.map((r) => [r.id, r.source]));
      expect(byId.get('shared')).toMatch(/^\.\/external\/extends\/demo\/base\/1\.0\.0\//);
      expect(byId.get('own')).toBe('./own.md');
      expect(existsSync(join(flat.dir, 'external/extends/demo/base/1.0.0/shared.md'))).toBe(true);

      const regOut = temp('packhub-flat-out-');
      const published = await publishPack(flat.dir, { registry: regOut, offline: true });
      const outManifest = readFileSync(
        join(regOut, 'packs/demo/flat/0.1.0/packhub.yaml'),
        'utf8',
      );
      expect(outManifest).not.toContain('extends:');
      expect(existsSync(join(regOut, 'packs/demo/flat/0.1.0.phub'))).toBe(true);

      const indexed = writeIndex(regOut);
      expect(indexed.ok).toBe(true);

      // 消费端只连新 registry：父包不存在也能装
      const project = temp('packhub-flat-proj-');
      const dest = join(project, '.packhub/packs/demo/flat');
      await fetchPack({ name: 'demo/flat', index: join(regOut, 'index.json'), dest });
      const ctx = await loadPackResolved(dest, { index: join(regOut, 'index.json') });
      expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);
      await installPack(ctx, planFor(ctx).plan!, { root: project, packRoot: dest });
      expect(readFileSync(join(project, '.packhub/knowledge/shared.md'), 'utf8')).toBe('# shared\n');
      expect(readFileSync(join(project, '.packhub/knowledge/own.md'), 'utf8')).toBe('# own\n');
      expect(published.name).toBe('demo/flat');
    } finally {
      flat.cleanup();
    }
  });

  it('对扁平化计划签的名，重新扁平化后仍然保留', async () => {
    const regIn = temp('packhub-flat-sign-reg-');
    const base = join(regIn, 'base-src');
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/signbase, version: 1.0.0, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: shared
    type: knowledge
    source: ./shared.md
`,
      'utf8',
    );
    writeFileSync(join(base, 'shared.md'), '# shared\n', 'utf8');
    await packArchive(base, { vendored: true, out: join(regIn, 'packs/demo/signbase/1.0.0.phub') });
    const indexIn = join(regIn, 'index.json');
    writeFileSync(
      indexIn,
      JSON.stringify({
        apiVersion: 'packhub.dev/index/v0',
        packs: [{ name: 'demo/signbase', latest: '1.0.0', versions: ['1.0.0'], trust: 'community' }],
      }),
      'utf8',
    );

    const child = temp('packhub-flat-sign-child-');
    writeFileSync(
      join(child, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
extends: packhub://demo/signbase@1.0.0
metadata: { name: demo/signed, version: 0.1.0, targets: [dir], visibility: public }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: own
    type: knowledge
    source: ./own.md
`,
      'utf8',
    );
    writeFileSync(join(child, 'own.md'), '# own\n', 'utf8');

    // 先拿到扁平化计划并签名，模拟 packhub sign 的行为
    const first = await flattenPack(child, { index: indexIn });
    try {
      const ctx = await loadPackResolved(first.dir, { index: indexIn });
      const plan = planFor(ctx).plan!;
      const { privatePem, publicKey } = generateKeyPair();
      writeSignature(child, signPlan(privatePem, 'demo/signed@0.1.0', plan.planHash));
      expect(readSignatures(child)).toHaveLength(1);

      // publish 会再扁平化一次：签名必须还在，且能对新的扁平化计划验过
      const second = await flattenPack(child, { index: indexIn });
      try {
        expect(second.manifest.signatures ?? []).toHaveLength(0);
        const sigs = readSignatures(second.dir);
        expect(sigs).toHaveLength(1);
        expect(sigs[0]!.key).toBe(publicKey);
        const again = planFor(await loadPackResolved(second.dir, { index: indexIn })).plan!;
        expect(verifySignatures(sigs, 'demo/signed@0.1.0', again.planHash)[0]!.ok).toBe(true);
      } finally {
        second.cleanup();
      }
    } finally {
      first.cleanup();
    }
  });
});
