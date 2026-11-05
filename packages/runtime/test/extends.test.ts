import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPack, planFor } from '../src/index.ts';

function manifest(name: string, version: string, body: string): string {
  return `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: ${name}, version: ${version}, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
${body}`;
}

describe('extends', () => {
  it('合并父包资源与接线，父包本地文件也能读', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packhub-ext-'));
    const base = join(root, 'base');
    const child = join(root, 'child');
    mkdirSync(base, { recursive: true });
    mkdirSync(child, { recursive: true });
    writeFileSync(
      join(base, 'packhub.yaml'),
      manifest(
        'demo/base',
        '1.0.0',
        `composition:
  env: { BASE: "1" }
resources:
  - id: shared
    type: knowledge
    source: ./shared.md
verify:
  - type: file-exists
    path: "\${target.knowledgeDir}/shared.md"
`,
      ),
      'utf8',
    );
    writeFileSync(join(base, 'shared.md'), '# shared\n', 'utf8');
    writeFileSync(
      join(child, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
extends: ../base
metadata: { name: demo/child, version: 0.1.0, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
composition:
  env: { CHILD: "2" }
resources:
  - id: own
    type: knowledge
    source: ./own.md
`,
      'utf8',
    );
    writeFileSync(join(child, 'own.md'), '# own\n', 'utf8');

    const ctx = loadPack(child);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(ctx.manifest.resources.map((r) => r.id).sort()).toEqual(['own', 'shared']);
    expect(ctx.manifest.composition?.env).toEqual({ BASE: '1', CHILD: '2' });
    expect(ctx.manifest.verify).toHaveLength(1);

    const { plan } = planFor(ctx);
    expect(plan).toBeTruthy();
    const project = mkdtempSync(join(tmpdir(), 'packhub-ext-proj-'));
    const result = await installPack(ctx, plan!, { root: project, packRoot: child });
    expect(result.outcomes.every((o) => o.status === 'done' || o.status === 'noop')).toBe(true);
    expect(readFileSync(join(project, '.packhub/knowledge/shared.md'), 'utf8')).toBe('# shared\n');
    expect(readFileSync(join(project, '.packhub/knowledge/own.md'), 'utf8')).toBe('# own\n');
    const config = JSON.parse(readFileSync(join(project, '.packhub/config.json'), 'utf8'));
    expect(config.env).toEqual({ BASE: '1', CHILD: '2' });

    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('成环时报错；远程 extends 交给 runtime 展开（kernel 不报错）', () => {
    const root = mkdtempSync(join(tmpdir(), 'packhub-ext-cycle-'));
    const a = join(root, 'a');
    const b = join(root, 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const oneRes = `resources:
  - id: r
    type: knowledge
    source: ./r.md
`;
    for (const dir of [a, b]) writeFileSync(join(dir, 'r.md'), '# r\n', 'utf8');
    writeFileSync(join(a, 'packhub.yaml'), manifest('demo/a', '0.0.1', `extends: ../b\n${oneRes}`), 'utf8');
    writeFileSync(join(b, 'packhub.yaml'), manifest('demo/b', '0.0.1', `extends: ../a\n${oneRes}`), 'utf8');
    const cyc = loadPack(a);
    expect(cyc.issues.map((i) => i.message).join(' ')).toContain('成环');

    const remote = join(root, 'remote');
    mkdirSync(remote, { recursive: true });
    writeFileSync(join(remote, 'r.md'), '# r\n', 'utf8');
    writeFileSync(
      join(remote, 'packhub.yaml'),
      manifest('demo/r', '0.0.1', `extends: packhub://demo/base@1.0.0\n${oneRes}`),
      'utf8',
    );
    const deferred = loadPack(remote);
    expect(deferred.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(deferred.manifest.extends).toBe('packhub://demo/base@1.0.0');
    rmSync(root, { recursive: true, force: true });
  });
});
