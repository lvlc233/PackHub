import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack, planFor } from '../src/index.ts';

const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/profile, version: 0.0.1, targets: [dir, server] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: shared
    type: knowledge
    source: ./shared.md
  - id: desktop-only
    type: knowledge
    source: ./desktop.md
    targets: [dir]
`;

describe('server profile 与资源级 target 裁剪', () => {
  it('server 只装通用资源，client-only 明确进 excluded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-profile-'));
    writeFileSync(join(dir, 'packhub.yaml'), MANIFEST, 'utf8');
    writeFileSync(join(dir, 'shared.md'), '# shared\n', 'utf8');
    writeFileSync(join(dir, 'desktop.md'), '# desktop\n', 'utf8');

    const ctx = loadPack(dir);
    expect(ctx.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const server = planFor(ctx, { target: 'server' }).plan!;
    const serverFiles = server.actions
      .filter((a) => a.op === 'write')
      .map((a) => ('to' in a ? a.to : ''));
    expect(serverFiles).toEqual(['.packhub/knowledge/shared.md']);
    expect(server.excluded).toContainEqual({
      resource: 'desktop-only',
      slot: '',
      reason: 'target-mismatch',
    });
    // server 不接宿主指令面
    expect(server.actions.some((a) => a.op === 'instruction')).toBe(false);

    const client = planFor(ctx, { target: 'dir' }).plan!;
    expect(
      client.actions
        .filter((a) => a.op === 'write')
        .map((a) => ('to' in a ? a.to : ''))
        .sort(),
    ).toEqual(['.packhub/knowledge/desktop.md', '.packhub/knowledge/shared.md']);

    rmSync(dir, { recursive: true, force: true });
  });
});
