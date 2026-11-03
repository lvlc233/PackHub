import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, publishPack, writeIndex } from '../src/index.ts';

function makePack(overrides: { version?: string; visibility?: string; verifyFail?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-pub-pack-'));
  writeFileSync(join(dir, 'rules.md'), '# r\n', 'utf8');
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/published
  version: ${overrides.version ?? '0.1.0'}
  title: 发布会用
  description: 发布流程测试。
  targets: [dir]
  visibility: ${overrides.visibility ?? 'public'}
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
verify:
  - type: file-exists
    path: \${target.skillsDir}/../knowledge/${overrides.verifyFail ? 'nope.md' : 'rules.md'}
`,
    'utf8',
  );
  return dir;
}

function registry(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-pub-reg-'));
  mkdirSync(join(dir, 'packs'), { recursive: true });
  return dir;
}

describe('publish', () => {
  it('干净安装通过后写版本目录、归档与索引，索引标 verified', async () => {
    const pack = makePack();
    const reg = registry();
    const res = await publishPack(pack, { registry: reg });

    expect(res.version).toBe('0.1.0');
    expect(existsSync(join(res.dir, 'packhub.yaml'))).toBe(true);
    expect(existsSync(join(res.dir, 'packhub.lock.json'))).toBe(true);
    expect(existsSync(join(res.dir, 'verify.json'))).toBe(true);
    expect(existsSync(join(reg, 'packs/demo/published/0.1.0.phub'))).toBe(true);

    const idx = writeIndex(reg);
    expect(idx.ok).toBe(true);
    const index = JSON.parse(readFileSync(join(reg, 'index.json'), 'utf8')) as {
      packs: { name: string; trust: string; latest: string }[];
    };
    expect(index.packs[0]!.name).toBe('demo/published');
    expect(index.packs[0]!.trust).toBe('verified');
    expect(index.packs[0]!.latest).toBe('0.1.0');
    rmSync(pack, { recursive: true, force: true });
    rmSync(reg, { recursive: true, force: true });
  });

  it('校验不过时拒绝发布', async () => {
    const pack = makePack({ verifyFail: true });
    const reg = registry();
    await expect(publishPack(pack, { registry: reg })).rejects.toThrow(/未通过|阻止发布/);
    expect(existsSync(join(reg, 'packs/demo/published/0.1.0'))).toBe(false);
    rmSync(pack, { recursive: true, force: true });
    rmSync(reg, { recursive: true, force: true });
  });

  it('同一版本重复发布会拒绝（不可变），--force 才覆盖', async () => {
    const pack = makePack();
    const reg = registry();
    await publishPack(pack, { registry: reg });
    await expect(publishPack(pack, { registry: reg })).rejects.toThrow(/已存在/);
    await expect(publishPack(pack, { registry: reg, force: true })).resolves.toBeTruthy();
    rmSync(pack, { recursive: true, force: true });
    rmSync(reg, { recursive: true, force: true });
  });

  it('dry-run 只跑校验，不落盘', async () => {
    const pack = makePack();
    const reg = registry();
    const res = await publishPack(pack, { registry: reg, dryRun: true });
    expect(res.report.ok).toBe(true);
    expect(existsSync(res.dir)).toBe(false);
    expect(existsSync(join(reg, 'index.json'))).toBe(false);
    rmSync(pack, { recursive: true, force: true });
    rmSync(reg, { recursive: true, force: true });
  });

  it('private 的包进不了公共 registry', async () => {
    const pack = makePack({ visibility: 'private' });
    const reg = registry();
    await publishPack(pack, { registry: reg });
    const res = buildIndex(reg);
    expect(res.errors.some((e) => /visibility=private/.test(e))).toBe(true);
    rmSync(pack, { recursive: true, force: true });
    rmSync(reg, { recursive: true, force: true });
  });
});
