import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLock, loadPack, planFor } from '@packhub/kernel';
import { lockPack, withLockPins } from '../src/index.ts';

const SHA = 'a'.repeat(40);

const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/resolve, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: repo-skill
    type: skill
    source: github:demo/repo/skills/review@main
  - id: search
    type: mcp
    source: npm:@scope/search@^1.0.0
    transport: stdio
  - id: rules
    type: knowledge
    source: ./rules.md
`;

function pack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-res-'));
  writeFileSync(join(dir, 'packhub.yaml'), MANIFEST, 'utf8');
  writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
  return dir;
}

describe('引用解析', () => {
  it('github 分支锁到 commit，npm 范围锁到具体版本，本地原样', async () => {
    const dir = pack();
    const res = await lockPack(loadPack(dir), {
      lsRemote: () => SHA,
      npmMeta: async () => ({ version: '1.4.0', integrity: 'sha512-abc' }),
      hashUrl: async () => 'sha256-nope',
    });

    const byId = new Map(res.lock.resolved.map((r) => [r.id, r]));
    expect(byId.get('repo-skill')!.source).toBe(`github:demo/repo/skills/review@${SHA}`);
    expect(byId.get('search')!.source).toBe('npm:@scope/search@1.4.0');
    expect(byId.get('search')!.integrity).toBe('sha512-abc');
    expect(byId.get('rules')!.source).toBe('./rules.md');

    // 锁里的计划基于钉死后的清单：fetch 的 uri 带 commit，micro 也带版本
    const uris = res.plan.actions.filter((a) => a.op === 'fetch').map((a) => ('uri' in a ? a.uri : ''));
    expect(uris).toContain(`github:demo/repo/skills/review@${SHA}`);
    expect(res.lock.planHash).toBe(res.plan.planHash);

    rmSync(dir, { recursive: true, force: true });
  });

  it('解析不到时保留原引用并给 warning，不假装锁住', async () => {
    const dir = pack();
    const res = await lockPack(loadPack(dir), {
      lsRemote: () => null,
      npmMeta: async () => {
        throw new Error('registry 404');
      },
      hashUrl: async () => 'sha256-x',
    });
    expect(res.warnings.length).toBeGreaterThan(0);
    const byId = new Map(res.lock.resolved.map((r) => [r.id, r]));
    expect(byId.get('repo-skill')!.source).toContain('@main');
    expect(byId.get('search')!.integrity).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('withLockPins 让「清单写 tag、锁写 commit」的包能正常出计划', () => {
    const dir = pack();
    const ctx = loadPack(dir);
    expect(ctx.issues.map((i) => i.code)).toContain('unpinned-source');

    const pinned = withLockPins(ctx, {
      ...buildLock(ctx.manifest!, planFor({ ...ctx, issues: [] }).plan!),
      resolved: [
        { id: 'repo-skill', type: 'skill', source: `github:demo/repo/skills/review@${SHA}`, integrity: null, resolvedAt: '' },
        { id: 'search', type: 'mcp', source: 'npm:@scope/search@1.4.0', integrity: 'sha512-abc', resolvedAt: '' },
        { id: 'rules', type: 'knowledge', source: './rules.md', integrity: null, resolvedAt: '' },
      ],
    });
    expect(pinned.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const { plan } = planFor(pinned);
    const uris = plan!.actions.filter((a) => a.op === 'fetch').map((a) => ('uri' in a ? a.uri : ''));
    expect(uris).toContain(`github:demo/repo/skills/review@${SHA}`);

    rmSync(dir, { recursive: true, force: true });
  });
});
