import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packArchive, unpackArchive } from '@packhub/runtime';
import { buildIndex, publishPack, writeIndex } from '../src/index.ts';

function makePack(
  overrides: {
    version?: string;
    visibility?: string;
    verifyFail?: boolean;
    targets?: string[];
  } = {},
): string {
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
  license: MIT
  homepage: https://example.com/demo
  authors: [{ name: 测试作者 }]
  targets: [${(overrides.targets ?? ['dir']).join(', ')}]
  visibility: ${overrides.visibility ?? 'public'}
requires: { packhub: ">=0.0.1 <0.1", agent: dsh }
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
      packs: {
        name: string;
        trust: string;
        latest: string;
        license: string | null;
        homepage: string | null;
        authors: { name: string }[];
        requiresAgent: string | null;
      }[];
    };
    expect(index.packs[0]!.name).toBe('demo/published');
    expect(index.packs[0]!.trust).toBe('verified');
    expect(index.packs[0]!.latest).toBe('0.1.0');
    expect(index.packs[0]!.license).toBe('MIT');
    expect(index.packs[0]!.homepage).toBe('https://example.com/demo');
    expect(index.packs[0]!.authors[0]!.name).toBe('测试作者');
    expect(index.packs[0]!.requiresAgent).toBe('dsh');
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

  it('版本目录里的锁与归档被改过，索引门禁都会指出（只在 git 里有历史时）', async () => {
    const pack = makePack();
    const reg = registry();
    const res = await publishPack(pack, { registry: reg });

    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.email=ci@example.com', '-c', 'user.name=ci', ...args], {
        cwd: reg,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    git('init');
    git('add', '-A');
    git('commit', '-m', 'publish');
    expect(buildIndex(reg).errors).toEqual([]);

    const lockFile = join(res.dir, 'packhub.lock.json');
    const lockText = readFileSync(lockFile, 'utf8');
    writeFileSync(lockFile, `${lockText}\n`, 'utf8');

    const after = buildIndex(reg);
    expect(after.errors.length).toBeGreaterThan(0);
    expect(after.errors.join('\n')).toContain('packhub.lock.json 已被修改');

    // 锁归位，改归档：归档字节也要核
    writeFileSync(lockFile, lockText, 'utf8');
    expect(buildIndex(reg).errors).toEqual([]);

    const archive = join(reg, 'packs/demo/published/0.1.0.phub');
    writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from('x')]));
    expect(buildIndex(reg).errors.join('\n')).toContain('0.1.0.phub 已被修改');

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
    await expect(publishPack(pack, { registry: reg })).rejects.toThrow(/visibility=private/);
    expect(existsSync(join(reg, 'packs/demo/published/0.1.0'))).toBe(false);
    rmSync(pack, { recursive: true, force: true });
    rmSync(reg, { recursive: true, force: true });
  });

  it('多 target：锁覆盖全部声明的 target，归档从版本目录打（锁与报告同一份）', async () => {
    const pack = makePack({ targets: ['dir', 'dsh', 'claude-code'] });
    const reg = registry();
    const res = await publishPack(pack, { registry: reg });

    const lock = JSON.parse(readFileSync(join(res.dir, 'packhub.lock.json'), 'utf8')) as {
      planHash: string;
      plans?: Record<string, { target: string; planHash: string }>;
    };
    expect(Object.keys(lock.plans ?? {}).sort()).toEqual(['claude-code', 'dir', 'dsh']);
    expect(lock.plans!.dir!.planHash).toBe(lock.planHash);

    // 归档里的锁 / 报告就是版本目录那一份（不是从包源目录打的旧锁）
    const unpacked = mkdtempSync(join(tmpdir(), 'packhub-pub-unpack-'));
    await unpackArchive(join(reg, 'packs/demo/published/0.1.0.phub'), unpacked);
    const archivedLock = JSON.parse(readFileSync(join(unpacked, 'packhub.lock.json'), 'utf8')) as {
      planHash: string;
      plans?: Record<string, { target: string; planHash: string }>;
    };
    expect(archivedLock.planHash).toBe(lock.planHash);
    expect(Object.keys(archivedLock.plans ?? {}).sort()).toEqual(['claude-code', 'dir', 'dsh']);
    expect(existsSync(join(unpacked, 'verify.json'))).toBe(true);

    expect(buildIndex(reg).errors).toEqual([]);
    rmSync(pack, { recursive: true, force: true });
    rmSync(reg, { recursive: true, force: true });
    rmSync(unpacked, { recursive: true, force: true });
  });

  it('清单声明了 target 但锁里没有快照：索引门禁报错（不再 continue 放过）', async () => {
    const pack = makePack({ targets: ['dir', 'dsh'] });
    const reg = registry();
    const res = await publishPack(pack, { registry: reg });

    const lockPath = join(res.dir, 'packhub.lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { plans?: unknown };
    delete lock.plans;
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');

    const errors = buildIndex(reg).errors.join('\n');
    expect(errors).toContain('锁里没有 dsh 的计划快照');
    rmSync(pack, { recursive: true, force: true });
    rmSync(reg, { recursive: true, force: true });
  });

  it('归档里缺锁：索引门禁报错', async () => {
    const pack = makePack();
    const reg = registry();
    const res = await publishPack(pack, { registry: reg });

    // 从版本目录的副本重打归档，但去掉锁——模拟「归档与版本目录不同源」
    const staged = mkdtempSync(join(tmpdir(), 'packhub-pub-stage-'));
    cpSync(res.dir, staged, { recursive: true });
    rmSync(join(staged, 'packhub.lock.json'));
    await packArchive(staged, { vendored: true, out: join(reg, 'packs/demo/published/0.1.0.phub') });

    const errors = buildIndex(reg).errors.join('\n');
    expect(errors).toContain('归档里缺 packhub.lock.json');
    rmSync(pack, { recursive: true, force: true });
    rmSync(reg, { recursive: true, force: true });
    rmSync(staged, { recursive: true, force: true });
  });

  it('归档里的锁与版本目录不一致：索引门禁报错（比 planHash，不比字节）', async () => {
    const pack = makePack();
    const reg = registry();
    const res = await publishPack(pack, { registry: reg });

    const staged = mkdtempSync(join(tmpdir(), 'packhub-pub-stage-'));
    cpSync(res.dir, staged, { recursive: true });
    const stagedLock = JSON.parse(readFileSync(join(staged, 'packhub.lock.json'), 'utf8')) as {
      planHash?: string;
    };
    stagedLock.planHash = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    writeFileSync(join(staged, 'packhub.lock.json'), `${JSON.stringify(stagedLock, null, 2)}\n`, 'utf8');
    await packArchive(staged, { vendored: true, out: join(reg, 'packs/demo/published/0.1.0.phub') });

    const errors = buildIndex(reg).errors.join('\n');
    expect(errors).toContain('归档里的锁与版本目录不一致');
    rmSync(pack, { recursive: true, force: true });
    rmSync(reg, { recursive: true, force: true });
    rmSync(staged, { recursive: true, force: true });
  });
});
