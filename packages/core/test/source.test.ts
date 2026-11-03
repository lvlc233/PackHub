import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitArchiveUrl, packArchive, resolveAddSource } from '../src/index.ts';

describe('gitArchiveUrl', () => {
  it('GitHub 映射到 codeload', () => {
    expect(gitArchiveUrl('git+https://github.com/o/r@v1.2.0')).toBe(
      'https://codeload.github.com/o/r/tar.gz/v1.2.0',
    );
  });

  it('GitLab 映射到 archive 端点', () => {
    expect(gitArchiveUrl('git+https://gitlab.corp/g/p@abc123')).toBe(
      'https://gitlab.corp/g/p/-/archive/abc123/p-abc123.tar.gz',
    );
  });

  it('带 .git 后缀也能处理', () => {
    expect(gitArchiveUrl('git+https://github.com/o/r.git@main')).toBe(
      'https://codeload.github.com/o/r/tar.gz/main',
    );
  });
});

describe('resolveAddSource', () => {
  it('本地 .phub 解包后能找到 pack 根', async () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-src-'));
    const pack = join(base, 'p');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, 'rules.md'), '# r\n', 'utf8');
    writeFileSync(
      join(pack, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/src, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`,
      'utf8',
    );
    const out = join(base, 'demo.phub');
    await packArchive(pack, { vendored: true, out });

    const dest = join(base, 'unpacked');
    const resolved = await resolveAddSource(out, dest);
    expect(resolved.kind).toBe('archive');
    expect(existsSync(join(resolved.dir, 'packhub.yaml'))).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('无法识别的来源直接报错', async () => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-src2-'));
    await expect(resolveAddSource('something-weird', join(base, 'x'))).rejects.toThrow(
      /无法识别的来源/,
    );
    rmSync(base, { recursive: true, force: true });
  });
});
