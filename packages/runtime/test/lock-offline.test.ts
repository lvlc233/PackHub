import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack } from '@packhub/kernel';
import { lockPack } from '../src/index.ts';

// https 引用按 schema 必须自带 integrity，离线没得解析，这里改用 npm / github 两种
const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/offline, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
  - id: floating-npm
    type: knowledge
    source: npm:@demo/floating
  - id: pinned-npm
    type: knowledge
    source: npm:@demo/pinned@1.2.3
  - id: repo-file
    type: knowledge
    source: github:demo/repo/rules.md@main
`;

describe('lock --offline', () => {
  it('本地引用照解析，远程原样写进锁（integrity=null）并逐条 warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-offline-'));
    writeFileSync(join(dir, 'packhub.yaml'), MANIFEST, 'utf8');
    writeFileSync(join(dir, 'rules.md'), '# r\n', 'utf8');

    // 没有注入任何网络替身：真去取 npm / github 会失败，能跑通就说明没出网
    const res = await lockPack(loadPack(dir), { offline: true });
    const byId = Object.fromEntries(res.lock.resolved.map((r) => [r.id, r]));

    expect(byId.rules?.source).toBe('./rules.md');
    expect(res.warnings.some((w) => w.startsWith('rules'))).toBe(false);

    // 已 pin 的也不解析：源照抄、integrity 仍是 null
    expect(byId['pinned-npm']?.source).toBe('npm:@demo/pinned@1.2.3');
    expect(byId['pinned-npm']?.integrity).toBeNull();

    // 未 pin 的同样原样留下，靠 warning 让人知道锁里没钉住
    expect(byId['floating-npm']?.source).toBe('npm:@demo/floating');
    expect(byId['floating-npm']?.integrity).toBeNull();
    expect(byId['repo-file']?.source).toBe('github:demo/repo/rules.md@main');

    for (const id of ['floating-npm', 'pinned-npm', 'repo-file']) {
      expect(res.warnings.some((w) => w.includes(`${id}: --offline`))).toBe(true);
    }

    // 锁仍为声明的 target 生成了计划
    expect(res.lock.plan?.planHash).toBe(res.plan.planHash);

    rmSync(dir, { recursive: true, force: true });
  });
});
