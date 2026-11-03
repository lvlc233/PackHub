import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLicenses, parseManifest } from '../src/index.ts';

const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/lic, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: mit-skill
    type: skill
    source: ./skills/mit
  - id: no-license
    type: knowledge
    source: ./docs
  - id: remote
    type: knowledge
    source: https://example.com/a.md
    integrity: sha256-CtMPyOdCbw/DtVRSFoKxJ4FbnhiPq2f92mvzzF5MR5Q=
`;

describe('许可证检查', () => {
  it('认出 MIT、标出缺失、远程跳过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-lic-'));
    mkdirSync(join(dir, 'skills/mit'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(
      join(dir, 'skills/mit/LICENSE'),
      'MIT License\n\nPermission is hereby granted, free of charge...\n',
      'utf8',
    );

    const manifest = parseManifest(MANIFEST).manifest!;
    const findings = inspectLicenses(dir, manifest);
    const byId = Object.fromEntries(findings.map((f) => [f.resource, f]));

    expect(byId['mit-skill']?.spdx).toBe('MIT');
    expect(byId['mit-skill']?.file).toContain('LICENSE');
    expect(byId['no-license']?.file).toBeUndefined();
    expect(byId.remote?.vendored).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
