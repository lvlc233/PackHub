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

function localPack(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
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
  return root;
}

describe('pack 封装', () => {
  it('默认自包含：本地内容一起进归档，解包后内容一致', async () => {
    const root = localPack('packhub-pack-default-');
    const out = join(root, 'pack.phub');
    const res = await packArchive(root, { out });
    expect(res.entries).toContain('resources');

    const dest = mkdtempSync(join(tmpdir(), 'packhub-pack-out-'));
    await unpackArchive(out, dest);
    expect(existsSync(join(dest, 'resources/rules.md'))).toBe(true);
    expect(readFileSync(join(dest, 'resources/rules.md'), 'utf8')).toBe('# rules\n');

    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it('reference 模式遇到本地来源直接拒绝，并说清怎么改', async () => {
    const root = localPack('packhub-pack-ref-');

    await expect(packArchive(root, { vendored: false, out: join(root, 'x.phub') })).rejects.toBeInstanceOf(
      LocalSourceNotVendoredError,
    );
    await expect(packArchive(root, { vendored: false, out: join(root, 'x.phub') })).rejects.toThrow(
      /--reference/,
    );

    rmSync(root, { recursive: true, force: true });
  });

  it('全部来源都能远程取时，reference 只打清单与锁', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packhub-pack-remote-'));
    writeFileSync(
      join(root, 'packhub.yaml'),
      manifest(
        'demo/remote',
        '1.0.0',
        `resources:
  - id: rules
    type: knowledge
    source: github:owner/repo/rules.md@0123456789abcdef0123456789abcdef01234567
`,
      ),
      'utf8',
    );

    const res = await packArchive(root, { vendored: false, out: join(root, 'x.phub') });
    expect(res.entries).toContain('packhub.yaml');
    expect(res.entries).not.toContain('resources');

    rmSync(root, { recursive: true, force: true });
  });
});
