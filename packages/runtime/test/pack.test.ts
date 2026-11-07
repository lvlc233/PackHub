import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSourceNotVendoredError, packArchive, unpackArchive } from '../src/index.ts';

function manifest(name: string, version: string, body: string): string {
  return `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: ${name}, version: ${version}, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
${body}`;
}

describe('pack 归档', () => {
  it('reference 模式遇到本地来源直接拒绝，并说清怎么打', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packhub-pack-local-'));
    writeFileSync(
      join(root, 'packhub.yaml'),
      manifest(
        'demo/local',
        '1.0.0',
        `resources:
  - id: rules
    type: knowledge
    source: ./resources/rules.md
`,
      ),
      'utf8',
    );
    mkdirSync(join(root, 'resources'), { recursive: true });
    writeFileSync(join(root, 'resources/rules.md'), '# rules\n', 'utf8');

    await expect(packArchive(root, { out: join(root, 'x.phub') })).rejects.toBeInstanceOf(
      LocalSourceNotVendoredError,
    );
    await expect(packArchive(root, { out: join(root, 'x.phub') })).rejects.toThrow(/--vendored/);

    rmSync(root, { recursive: true, force: true });
  });

  it('vendored 归档带上本地文件，解包后内容一致', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packhub-pack-v-'));
    writeFileSync(
      join(root, 'packhub.yaml'),
      manifest(
        'demo/vendored',
        '1.0.0',
        `resources:
  - id: rules
    type: knowledge
    source: ./resources/rules.md
`,
      ),
      'utf8',
    );
    mkdirSync(join(root, 'resources'), { recursive: true });
    writeFileSync(join(root, 'resources/rules.md'), '# rules\n', 'utf8');

    const out = join(root, 'pack.phub');
    const res = await packArchive(root, { vendored: true, out });
    expect(res.entries).toContain('resources');

    const dest = mkdtempSync(join(tmpdir(), 'packhub-pack-out-'));
    await unpackArchive(out, dest);
    expect(existsSync(join(dest, 'resources/rules.md'))).toBe(true);
    expect(readFileSync(join(dest, 'resources/rules.md'), 'utf8')).toBe('# rules\n');

    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it('本地 extends 的资源落在包目录外时也拒绝：归档只带包目录', async () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-pack-ext-'));
    const baseDir = join(base, 'base');
    const child = join(base, 'child');
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(child, { recursive: true });
    writeFileSync(
      join(baseDir, 'packhub.yaml'),
      manifest(
        'demo/base',
        '1.0.0',
        `resources:
  - id: shared
    type: knowledge
    source: ./shared.md
`,
      ),
      'utf8',
    );
    writeFileSync(join(baseDir, 'shared.md'), '# shared\n', 'utf8');
    writeFileSync(
      join(child, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
extends: ../base
metadata: { name: demo/child, version: 1.0.0, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: own
    type: knowledge
    source: ./own.md
`,
      'utf8',
    );
    writeFileSync(join(child, 'own.md'), '# own\n', 'utf8');

    // 合并后的父包来源被改写成 ../base/shared.md：安装时读得到，归档里带不上，必须先在 flatten 里搬进来。
    await expect(
      packArchive(child, { vendored: true, out: join(child, 'pack.phub') }),
    ).rejects.toThrow(/包目录外/);

    rmSync(base, { recursive: true, force: true });
  });
});
