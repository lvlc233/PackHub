import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  adoptInstance,
  cloneInstance,
  createInstance,
  exportTemplate,
  listInstances,
  migrateInstance,
  readBaseline,
  readInstance,
  readTemplate,
  rebaselineInstance,
  removeInstance,
  renameInstance,
  scanInstances,
  updateInstance,
  writeTemplate,
} from '../src/index.ts';
import { isPalError } from '../src/errors.ts';
import { isPidAlive } from '../src/process.ts';
import { isStopping, stoppingMarkFile } from '../src/stopMark.ts';
import { baselineDrift } from '../src/health.ts';
import { archiveRoot, failedRoot, quarantineRoot } from '../src/paths.ts';

const PACK = 'examples/doc-review';

/**
 * 删根失败的现场：只拦「指向指定根的 rmSync/renameSync」，其他路径照常落到真实 fs。
 * 用开关而不是替换整套模块，同文件其他用例不受影响。
 */
const fsBlock = vi.hoisted(() => ({ root: '' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const blocked = (target: unknown) => fsBlock.root !== '' && String(target) === fsBlock.root;
  const busy = () => Object.assign(new Error('EPERM: 目录被占用（测试模拟）'), { code: 'EPERM' });
  return {
    ...actual,
    default: actual,
    rmSync: ((target: string, options?: unknown) => {
      if (blocked(target)) throw busy();
      return actual.rmSync(target, options as never);
    }) as typeof actual.rmSync,
    renameSync: ((from: string, to: string) => {
      if (blocked(from)) throw busy();
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
  };
});

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-instance-'));
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
});

afterEach(() => {
  delete process.env.PACKHUB_INSTANCES;
  rmSync(tmp, { recursive: true, force: true });
});

/** 造一个装着会失败资源的 Pack：安装期真的抛错，用来验证失败清理。 */
function brokenPack(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/broken, version: 0.1.0, targets: [dir] }
resources:
  - id: gone
    type: skill
    source: ./does-not-exist
`,
    'utf8',
  );
  return dir;
}

function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 造一个指定版本、写一组 knowledge 文件的 Pack；同一名字的两个目录就是两个版本。 */
function knowledgePack(dir: string, version: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  const resources = Object.keys(files)
    .map((name) => `  - id: ${name.replace(/[^a-zA-Z0-9]+/g, '-')}\n    type: knowledge\n    source: ./${name}\n`)
    .join('');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8');
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/guard, version: ${version}, targets: [dir] }
resources:
${resources}`,
    'utf8',
  );
  return dir;
}

describe('实例配置', () => {
  it('从 Pack 创建：记录、基线、能列出与删除', async () => {
    const record = await createInstance({ name: 'demo', harness: 'dir', packDir: PACK });
    expect(record.name).toBe('demo');
    expect(record.harness).toBe('dir');
    expect(record.status).toBe('installed');
    expect(record.managed).toBe(true);
    expect(record.pack.name).toBe('lvlc233/doc-review');
    expect(record.pack.version).toBe('0.1.0');
    expect(existsSync(join(record.root, 'instance.json'))).toBe(true);
    expect(existsSync(join(record.root, '.packhub', 'state.json'))).toBe(true);

    const baseline = readBaseline(record.root);
    expect(baseline?.planHash).toBe(record.planHash);
    expect(baseline!.files.length).toBeGreaterThan(0);

    expect(listInstances().map((i) => i.name)).toEqual(['demo']);
    expect(readInstance(record.id)?.name).toBe('demo');

    // 包 key 在删根之后就读不到了，报告必须是删前收集的那份
    const result = await removeInstance('demo');
    expect(result.uninstalled).toEqual(['lvlc233/doc-review@0.1.0']);
    expect(result.removed).toBe(true);
    expect(listInstances()).toEqual([]);
    expect(existsSync(record.root)).toBe(false);
  });

  it('重名、未知宿主、未声明的 target 都有稳定错误码', async () => {
    await createInstance({ name: 'dup', harness: 'dir', packDir: PACK });
    const cases: Array<[() => Promise<unknown>, string]> = [
      [() => createInstance({ name: 'dup', harness: 'dir', packDir: PACK }), 'name-taken'],
      [() => createInstance({ name: 'x', harness: 'nope' as never, packDir: PACK }), 'unknown-harness'],
      [() => createInstance({ name: 'c', harness: 'codex', packDir: PACK }), 'invalid-input'],
    ];
    for (const [run, code] of cases) {
      let caught: unknown;
      try {
        await run();
      } catch (err) {
        caught = err;
      }
      expect(isPalError(caught)).toBe(true);
      if (isPalError(caught)) expect(caught.code).toBe(code);
    }
  });

  it('坏记录移进隔离区，不再静默消失', async () => {
    const good = await createInstance({ name: 'good', harness: 'dir', packDir: PACK });
    const badDir = join(tmp, 'instances', 'broken-one');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'instance.json'), '{ not json', 'utf8');

    const scan = scanInstances();
    expect(scan.broken.map((bad) => bad.dir)).toEqual([badDir]);

    const rows = listInstances();
    expect(rows.map((row) => row.id)).toEqual([good.id]);
    expect(existsSync(badDir)).toBe(false);
    const quarantined = listDirNames(quarantineRoot());
    expect(quarantined).toHaveLength(1);
    const reason = readFileSync(join(quarantineRoot(), quarantined[0]!, 'reason.json'), 'utf8');
    expect(reason).toContain('instance.json');
  });

  it('建实例失败：复用已有目录时不删目录；自己建的根移进失败区', async () => {
    const reuse = join(tmp, 'reuse-root');
    mkdirSync(reuse, { recursive: true });
    writeFileSync(join(reuse, 'keep.txt'), 'user data', 'utf8');

    await expect(
      createInstance({ name: 'reuse', harness: 'dir', packDir: brokenPack(join(tmp, 'p1')), root: reuse }),
    ).rejects.toThrow();
    expect(existsSync(join(reuse, 'keep.txt'))).toBe(true);
    expect(existsSync(join(reuse, 'instance.json'))).toBe(false);
    expect(listInstances()).toEqual([]);

    await expect(
      createInstance({ name: 'fresh', harness: 'dir', packDir: brokenPack(join(tmp, 'p2')) }),
    ).rejects.toThrow();
    expect(listInstances()).toEqual([]);
    const failed = listDirNames(failedRoot());
    expect(failed).toHaveLength(1);
    expect(readFileSync(join(failedRoot(), failed[0]!, 'reason.json'), 'utf8')).toContain('skill 源目录不存在');
  });

  it('删除运行中的实例：先停进程再卸包，不再出现删一半', async () => {
    const record = await createInstance({ name: 'busy-one', harness: 'dsh', packDir: PACK });
    const killed: number[] = [];
    // 让记录看起来在跑：删除必须调 kill 并等进程退出，再卸包、删根
    writeFileSync(
      join(record.root, 'instance.json'),
      JSON.stringify({ ...readInstance(record.id)!, status: 'running', pid: 4242, port: 41234 }, null, 2),
      'utf8',
    );
    let alive = true;
    const result = await removeInstance('busy-one', {
      isAlive: () => alive,
      kill: (pid) => {
        killed.push(pid);
        alive = false;
      },
    });
    expect(killed).toEqual([4242]);
    expect(result.stopped).toBe(4242);
    expect(result.removed).toBe(true);
    expect(result.uninstalled.length).toBe(1);
    expect(existsSync(record.root)).toBe(false);
  });

  it('删除运行中的 on-failure 实例：kill 时带停止标记，删完不留', async () => {
    const record = await createInstance({ name: 'restarting', harness: 'dsh', packDir: PACK });
    // 造一个会被看护重起的记录：删除如果不落标记，serve 里的 onExit 会把它拉起来
    writeFileSync(
      join(record.root, 'instance.json'),
      JSON.stringify(
        { ...readInstance(record.id)!, status: 'running', pid: 4343, port: 41235, restart: 'on-failure' },
        null,
        2,
      ),
      'utf8',
    );
    const markFile = stoppingMarkFile(record.root);
    let alive = true;
    const result = await removeInstance('restarting', {
      isAlive: () => alive,
      kill: (pid) => {
        expect(pid).toBe(4343);
        // 标记必须已经在磁盘上，另一个进程里的看护才认得出这是删除不是崩溃
        expect(existsSync(markFile)).toBe(true);
        alive = false;
      },
    });
    expect(result.stopped).toBe(4343);
    expect(existsSync(markFile)).toBe(false);
    expect(existsSync(record.root)).toBe(false);
  });

  it('删除失败（kill 后进程还活）也要清掉停止标记', async () => {
    const record = await createInstance({ name: 'stuck-remove', harness: 'dsh', packDir: PACK });
    writeFileSync(
      join(record.root, 'instance.json'),
      JSON.stringify(
        { ...readInstance(record.id)!, status: 'running', pid: 4344, port: 41236, restart: 'on-failure' },
        null,
        2,
      ),
      'utf8',
    );
    const markFile = stoppingMarkFile(record.root);
    let caught: unknown;
    try {
      await removeInstance('stuck-remove', {
        isAlive: () => true,
        kill: () => {
          expect(existsSync(markFile)).toBe(true);
        },
        timeoutMs: 150,
      });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('busy');
    // 留着标记会把之后真实的崩溃一直压掉
    expect(existsSync(markFile)).toBe(false);
    expect(isStopping(record.root, 4344)).toBe(false);
    // 删除没成：记录和根都还在
    expect(readInstance(record.id)?.status).toBe('running');
    expect(existsSync(record.root)).toBe(true);
  });

  it('keepData 搬根不把停止标记带进归档', async () => {
    const record = await createInstance({ name: 'archive-marked', harness: 'dsh', packDir: PACK });
    writeFileSync(
      join(record.root, 'instance.json'),
      JSON.stringify(
        { ...readInstance(record.id)!, status: 'running', pid: 4345, port: 41237, restart: 'on-failure' },
        null,
        2,
      ),
      'utf8',
    );
    let alive = true;
    const result = await removeInstance('archive-marked', {
      keepData: true,
      isAlive: () => alive,
      kill: () => {
        alive = false;
      },
    });
    expect(result.archivedTo).toBeDefined();
    // 标记在搬根之前就清了，归档根里不该再有它
    expect(existsSync(stoppingMarkFile(result.archivedTo!))).toBe(false);
    expect(listInstances()).toEqual([]);
  });

  it('保留数据：根挪进归档区，列表里不再有它', async () => {
    const record = await createInstance({ name: 'keep-me', harness: 'dsh', packDir: PACK });
    writeFileSync(join(record.home!, 'session.txt'), 'my session', 'utf8');
    const result = await removeInstance('keep-me', { keepData: true });
    expect(result.removed).toBe(false);
    expect(existsSync(record.root)).toBe(false);
    expect(listInstances()).toEqual([]);
    const archived = listDirNames(archiveRoot());
    expect(archived).toHaveLength(1);
    const keep = join(archiveRoot(), archived[0]!, 'home', 'dsh', 'session.txt');
    expect(readFileSync(keep, 'utf8')).toBe('my session');
  });

  it('删根失败（目录占用且归档也失败）：包没卸、state 与记录原样留着，可以重试', async () => {
    const record = await createInstance({ name: 'root-busy', harness: 'dsh', packDir: PACK });
    const stateFile = join(record.root, '.packhub', 'state.json');
    const before = readFileSync(stateFile, 'utf8');
    const packs = (JSON.parse(before) as { packs: Record<string, { written: string[] }> }).packs;
    const keys = Object.keys(packs);
    expect(keys).toEqual(['lvlc233/doc-review@0.1.0']);
    const written = packs[keys[0]!]!.written;
    expect(written.length).toBeGreaterThan(0);

    fsBlock.root = record.root;
    let caught: unknown;
    try {
      await removeInstance('root-busy');
    } catch (err) {
      caught = err;
    } finally {
      fsBlock.root = '';
    }

    expect(isPalError(caught) && caught.code).toBe('busy');
    // 旧的顺序会留下「包已卸、目录和记录还在」；现在根删不掉就整根不动
    expect(readInstance(record.id)?.status).toBe('installed');
    expect(readFileSync(stateFile, 'utf8')).toBe(before);
    for (const rel of written) expect(existsSync(join(record.root, rel))).toBe(true);
    expect(listInstances().map((row) => row.id)).toContain(record.id);
    expect(listDirNames(archiveRoot())).toEqual([]);
  });

  it('接管来的目录删除时只摘记录，不按 state 卸包', async () => {
    const dir = join(tmp, 'existing-env');
    const written = join(dir, 'home', 'dsh', 'skills', 'doc-review', 'SKILL.md');
    mkdirSync(join(dir, 'home', 'dsh', 'skills', 'doc-review'), { recursive: true });
    writeFileSync(written, '# 用户的 skill\n', 'utf8');
    writeFileSync(join(dir, 'mine.txt'), 'keep', 'utf8');
    // 接管目录里本来就有 Pack 的 state：删除时不能拿它去 removePack
    mkdirSync(join(dir, '.packhub'), { recursive: true });
    writeFileSync(
      join(dir, '.packhub', 'state.json'),
      JSON.stringify(
        {
          apiVersion: 'packhub.dev/state/v0',
          packs: {
            'lvlc233/doc-review@0.1.0': {
              pack: 'lvlc233/doc-review',
              version: '0.1.0',
              planHash: 'adopted',
              installedAt: new Date().toISOString(),
              actions: [],
              written: ['home/dsh/skills/doc-review/SKILL.md'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    const record = adoptInstance({ dir, name: 'adopted', harness: 'dsh' });
    expect(record.managed).toBe(false);
    expect(record.home).toBe(join(dir, 'home', 'dsh'));

    const result = await removeInstance('adopted');
    expect(result.removed).toBe(false);
    expect(result.uninstalled).toEqual([]);
    expect(readFileSync(written, 'utf8')).toBe('# 用户的 skill\n');
    expect(existsSync(join(dir, '.packhub', 'state.json'))).toBe(true);
    expect(existsSync(join(dir, 'mine.txt'))).toBe(true);
    expect(existsSync(join(dir, 'instance.json'))).toBe(false);
    expect(listInstances()).toEqual([]);
  });

  it('接管来的目录 keepData 删除也不搬走，归档区不新增', async () => {
    const dir = join(tmp, 'existing-env-keep');
    mkdirSync(join(dir, 'home', 'dsh'), { recursive: true });
    writeFileSync(join(dir, 'mine.txt'), 'keep', 'utf8');
    adoptInstance({ dir, name: 'adopted-keep', harness: 'dsh' });

    const result = await removeInstance('adopted-keep', { keepData: true });
    expect(result.removed).toBe(false);
    expect(result.archivedTo).toBeUndefined();
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(join(dir, 'mine.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(dir, 'instance.json'))).toBe(false);
    expect(listInstances()).toEqual([]);
    expect(listDirNames(archiveRoot())).toEqual([]);
  });

  it('接管时按 Pack 个数定身份：多 Pack / 单 Pack / 空环境', () => {
    const stateEntry = (pack: string, version: string, planHash: string) => ({
      pack,
      version,
      planHash,
      installedAt: new Date().toISOString(),
      actions: [],
      written: [],
    });
    const writeState = (dir: string, packs: Record<string, unknown>): string => {
      mkdirSync(join(dir, '.packhub'), { recursive: true });
      const file = join(dir, '.packhub', 'state.json');
      writeFileSync(file, JSON.stringify({ apiVersion: 'packhub.dev/state/v0', packs }, null, 2), 'utf8');
      return file;
    };

    // 两个 Pack：谁都不是「这个实例的 Pack」，不能拿第一个冒充
    const multi = join(tmp, 'adopt-multi');
    mkdirSync(multi, { recursive: true });
    writeFileSync(join(multi, 'mine.txt'), 'keep', 'utf8');
    const multiState = writeState(multi, {
      'lvlc233/doc-review@0.1.0': stateEntry('lvlc233/doc-review', '0.1.0', 'hash-a'),
      'demo/guard@0.2.0': stateEntry('demo/guard', '0.2.0', 'hash-b'),
    });
    const multiBefore = readFileSync(multiState, 'utf8');
    const multiRecord = adoptInstance({ dir: multi, name: 'adopt-multi', harness: 'dsh' });
    expect(multiRecord.pack).toEqual({ name: 'external', version: '0.0.0' });
    expect(multiRecord.planHash).toBe('');
    expect(multiRecord.managed).toBe(false);
    expect(multiRecord.origin).toEqual({ kind: 'adopted', dir: multi });
    // 用户目录保持原样：state 没被改写，业务文件也在
    expect(readFileSync(multiState, 'utf8')).toBe(multiBefore);
    expect(readFileSync(join(multi, 'mine.txt'), 'utf8')).toBe('keep');

    // 单个 Pack：仍然沿用它的名字与 planHash
    const single = join(tmp, 'adopt-single');
    mkdirSync(single, { recursive: true });
    writeState(single, { 'lvlc233/doc-review@0.1.0': stateEntry('lvlc233/doc-review', '0.1.0', 'hash-a') });
    const singleRecord = adoptInstance({ dir: single, name: 'adopt-single', harness: 'dsh' });
    expect(singleRecord.pack).toEqual({ name: 'lvlc233/doc-review', version: '0.1.0' });
    expect(singleRecord.planHash).toBe('hash-a');

    // 一个 Pack 都没有：external
    const empty = join(tmp, 'adopt-empty');
    mkdirSync(empty, { recursive: true });
    writeState(empty, {});
    const emptyRecord = adoptInstance({ dir: empty, name: 'adopt-empty', harness: 'dsh' });
    expect(emptyRecord.pack).toEqual({ name: 'external', version: '0.0.0' });
    expect(emptyRecord.planHash).toBe('');
  });

  it('复制、改名、导出模板', async () => {
    const source = await createInstance({
      name: 'src',
      harness: 'dsh',
      packDir: PACK,
      packRef: PACK,
    });
    writeFileSync(join(source.home!, 'note.txt'), 'hello', 'utf8');

    const copy = await cloneInstance('src', { name: 'copy' });
    expect(copy.id).not.toBe(source.id);
    expect(copy.root).not.toBe(source.root);
    expect(readFileSync(join(copy.home!, 'note.txt'), 'utf8')).toBe('hello');
    expect(copy.status).toBe('installed');
    expect(copy.pid).toBeUndefined();

    const renamed = renameInstance('copy', 'copy-2');
    expect(renamed.name).toBe('copy-2');

    const template = exportTemplate('src');
    expect(template.reproducible).toBe(true);
    expect(template.pack.name).toBe('lvlc233/doc-review');
    const file = writeTemplate(template, join(tmp, 'src.pal.json'));
    expect(readTemplate(file).name).toBe('src');
  });

  it('复制接管来的实例：克隆体归 PAL 管，来源记成 copy 且不可复现', async () => {
    const dir = join(tmp, 'adopt-src');
    mkdirSync(join(dir, 'home', 'dsh'), { recursive: true });
    writeFileSync(join(dir, 'mine.txt'), 'keep', 'utf8');
    const src = adoptInstance({ dir, name: 'adopt-src', harness: 'dsh' });
    expect(src.managed).toBe(false);
    expect(src.origin?.kind).toBe('adopted');

    const copy = await cloneInstance('adopt-src', { name: 'adopt-copy' });
    expect(copy.managed).toBe(true);
    expect(copy.origin).toEqual({ kind: 'copy', from: src.id });
    // 落盘记录与返回值一致
    expect(readInstance(copy.id)?.managed).toBe(true);
    expect(readInstance(copy.id)?.origin).toEqual({ kind: 'copy', from: src.id });
    const template = exportTemplate('adopt-copy');
    expect(template.reproducible).toBe(false);
    expect(template.origin?.kind).toBe('copy');

    // 克隆体是 PAL 建的目录：删除时整个根都消失，而不是像接管源那样留下
    await removeInstance('adopt-copy');
    expect(existsSync(copy.root)).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it('复制 Pack 实例：克隆体来源是 copy，不带 pack 引用，导出模板不可复现', async () => {
    const source = await createInstance({
      name: 'pack-src',
      harness: 'dsh',
      packDir: PACK,
      packRef: PACK,
    });
    expect(source.origin?.kind).toBe('pack');
    expect(source.origin?.ref).toBe(PACK);

    const copy = await cloneInstance('pack-src', { name: 'pack-copy' });
    expect(copy.managed).toBe(true);
    expect(copy.origin).toEqual({ kind: 'copy', from: source.id });
    // pack 元数据还在（它是什么版本），但来源不能再冒充 Pack
    expect(copy.pack.ref).toBe(PACK);

    const template = exportTemplate('pack-copy');
    expect(template.reproducible).toBe(false);
    const file = writeTemplate(template, join(tmp, 'pack-copy.pal.json'));
    expect(() => readTemplate(file)).toThrow('不可复现');
  });

  it('迁移：记录跟到新路径，旧路径不存在，锁不留在新根', async () => {
    const rec = await createInstance({ name: 'mover', harness: 'dir', packDir: PACK });
    const target = join(tmp, 'moved-root');

    const moved = migrateInstance('mover', target);

    expect(moved.id).toBe(rec.id);
    expect(moved.root).toBe(target);
    expect(existsSync(rec.root)).toBe(false);
    expect(existsSync(target)).toBe(true);
    // 磁盘上的记录与目录一致：列表、按 id 读、instance.json 三处都指向新根
    expect(readInstance(rec.id)?.root).toBe(target);
    expect(listInstances().map((row) => row.root)).toContain(target);
    const onDisk = JSON.parse(readFileSync(join(target, 'instance.json'), 'utf8')) as { root: string; id: string };
    expect(onDisk.id).toBe(rec.id);
    expect(onDisk.root).toBe(target);
    expect(existsSync(join(target, '.pal-lock.json'))).toBe(false);
  });

  it('迁移：目标已存在时拒绝，旧根与记录都不动', async () => {
    const rec = await createInstance({ name: 'occupied', harness: 'dir', packDir: PACK });
    const target = join(tmp, 'occupied-root');
    mkdirSync(target, { recursive: true });

    let caught: unknown;
    try {
      migrateInstance('occupied', target);
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught)).toBe(true);
    if (isPalError(caught)) expect(caught.code).toBe('root-occupied');
    expect(existsSync(rec.root)).toBe(true);
    expect(readInstance(rec.id)?.root).toBe(rec.root);
  });

  it('迁移：锁被另一个活着的进程占着就拒绝，不 rename', async () => {
    const rec = await createInstance({ name: 'locked', harness: 'dir', packDir: PACK });
    const target = join(tmp, 'locked-target');
    // 父进程活着且一定不是自己；拿不到可靠 pid 就不硬造锁冲突
    const holder = process.ppid;
    if (!holder || holder === process.pid || !isPidAlive(holder)) return;
    writeFileSync(
      join(rec.root, '.pal-lock.json'),
      JSON.stringify({ pid: holder, op: 'create', at: new Date().toISOString() }, null, 2),
      'utf8',
    );

    let caught: unknown;
    try {
      migrateInstance('locked', target);
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught)).toBe(true);
    if (isPalError(caught)) expect(caught.code).toBe('busy');
    expect(existsSync(rec.root)).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readInstance(rec.id)?.root).toBe(rec.root);
  });

  it('迁移：写记录失败时把目录回滚，记录仍指旧路径', async () => {
    const rec = await createInstance({ name: 'rollback', harness: 'dir', packDir: PACK });
    const target = join(tmp, 'rollback-target');
    // 固定临时文件后缀，再把这个路径做成目录：writeInstance 写临时文件就会失败
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    mkdirSync(join(rec.root, `instance.json.tmp-${process.pid}-i`));
    try {
      expect(() => migrateInstance('rollback', target)).toThrow('已回滚');
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(rec.root)).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readInstance(rec.id)?.root).toBe(rec.root);
    expect(JSON.parse(readFileSync(join(rec.root, 'instance.json'), 'utf8')).root).toBe(rec.root);
    expect(existsSync(join(rec.root, '.pal-lock.json'))).toBe(false);
  });

  it('更新到新版本：换掉旧文件、清掉上一版独有的文件、刷新基线与记录', async () => {
    const v1 = join(tmp, 'pack-v1');
    mkdirSync(v1, { recursive: true });
    writeFileSync(join(v1, 'a.md'), '# a1\n', 'utf8');
    writeFileSync(join(v1, 'b.md'), '# b\n', 'utf8');
    writeFileSync(
      join(v1, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/upd, version: 0.1.0, targets: [dir] }
resources:
  - id: a
    type: knowledge
    source: ./a.md
  - id: b
    type: knowledge
    source: ./b.md
`,
      'utf8',
    );
    const rec = await createInstance({ name: 'upd', harness: 'dir', packDir: v1, packRef: v1 });
    const aPath = join(rec.root, '.packhub', 'knowledge', 'a.md');
    const bPath = join(rec.root, '.packhub', 'knowledge', 'b.md');
    expect(existsSync(aPath)).toBe(true);

    const v2 = join(tmp, 'pack-v2');
    mkdirSync(v2, { recursive: true });
    writeFileSync(join(v2, 'a.md'), '# a2\n', 'utf8');
    writeFileSync(join(v2, 'c.md'), '# c\n', 'utf8');
    writeFileSync(
      join(v2, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/upd, version: 0.2.0, targets: [dir] }
resources:
  - id: a
    type: knowledge
    source: ./a.md
  - id: c
    type: knowledge
    source: ./c.md
`,
      'utf8',
    );

    const result = await updateInstance('upd', { packDir: v2 });
    expect(result.changed).toBe(true);
    expect(result.to).toBe('demo/upd@0.2.0');
    expect(readFileSync(aPath, 'utf8')).toBe('# a2\n');
    expect(existsSync(bPath)).toBe(false);
    expect(existsSync(join(rec.root, '.packhub', 'knowledge', 'c.md'))).toBe(true);
    expect(result.removedFiles).toContain('.packhub/knowledge/b.md');
    expect(readInstance(rec.id)?.pack.version).toBe('0.2.0');
    expect(readBaseline(rec.root)?.version).toBe('0.2.0');
  });

  it('本地改过 Pack 写的文件：不带 force 拒绝更新且不写盘，带 force 才覆盖', async () => {
    const v1 = knowledgePack(join(tmp, 'guard-v1'), '0.1.0', { 'a.md': '# a1\n' });
    const v2 = knowledgePack(join(tmp, 'guard-v2'), '0.2.0', { 'a.md': '# a2\n', 'c.md': '# c\n' });
    const rec = await createInstance({ name: 'guard', harness: 'dir', packDir: v1, packRef: v1 });
    const aPath = join(rec.root, '.packhub', 'knowledge', 'a.md');
    const cPath = join(rec.root, '.packhub', 'knowledge', 'c.md');
    expect(existsSync(aPath)).toBe(true);
    writeFileSync(aPath, '# 本地改的\n', 'utf8');

    let caught: unknown;
    try {
      await updateInstance('guard', { packDir: v2 });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught)).toBe(true);
    if (isPalError(caught)) {
      expect(caught.code).toBe('invalid-input');
      expect(caught.message).toContain('.packhub/knowledge/a.md');
      expect(caught.message).toContain('--force');
    }
    // 拒绝时一个文件都不写：内容、记录、基线都停在旧版本
    expect(readFileSync(aPath, 'utf8')).toBe('# 本地改的\n');
    expect(existsSync(cPath)).toBe(false);
    expect(readInstance(rec.id)?.pack.version).toBe('0.1.0');
    expect(readBaseline(rec.root)?.version).toBe('0.1.0');

    const result = await updateInstance('guard', { packDir: v2, force: true });
    expect(result.changed).toBe(true);
    expect(result.to).toBe('demo/guard@0.2.0');
    expect(result.localChanges).toContain('.packhub/knowledge/a.md');
    expect(readFileSync(aPath, 'utf8')).toBe('# a2\n');
    expect(existsSync(cPath)).toBe(true);
    expect(readInstance(rec.id)?.pack.version).toBe('0.2.0');
    expect(readBaseline(rec.root)?.version).toBe('0.2.0');
  });

  it('同一版本重跑且有本地改动：不拦截、changed=false、文件与基线都不动', async () => {
    const v1 = knowledgePack(join(tmp, 'noop-v1'), '0.1.0', { 'a.md': '# a1\n' });
    const rec = await createInstance({ name: 'noop', harness: 'dir', packDir: v1, packRef: v1 });
    const aPath = join(rec.root, '.packhub', 'knowledge', 'a.md');
    writeFileSync(aPath, '# 本地改的\n', 'utf8');
    const before = readBaseline(rec.root);

    const result = await updateInstance('noop', { packDir: v1 });
    expect(result.changed).toBe(false);
    expect(result.localChanges).toContain('.packhub/knowledge/a.md');
    expect(readFileSync(aPath, 'utf8')).toBe('# 本地改的\n');
    expect(readInstance(rec.id)?.pack.version).toBe('0.1.0');
    expect(readBaseline(rec.root)).toEqual(before);
  });

  it('运行中的实例拒绝更新', async () => {
    const rec = await createInstance({ name: 'run-upd', harness: 'dsh', packDir: 'examples/doc-review' });
    writeFileSync(
      join(rec.root, 'instance.json'),
      JSON.stringify({ ...readInstance(rec.id)!, status: 'running', pid: process.pid }, null, 2),
      'utf8',
    );
    await expect(updateInstance('run-upd', { packDir: 'examples/doc-review' })).rejects.toThrow('先停掉再更新');
  });

  it('重新基准化：本地改动被接受，漂移消失', async () => {
    const rec = await createInstance({ name: 'base', harness: 'dir', packDir: 'examples/doc-review' });
    const baseline = readBaseline(rec.root)!;
    const file = join(rec.root, baseline.files[0]!.path);
    writeFileSync(file, 'locally edited', 'utf8');
    expect(baselineDrift(rec)?.changed.length).toBe(1);

    rebaselineInstance('base');
    expect(baselineDrift(readInstance(rec.id)!)?.changed).toEqual([]);
  });

  it('重新基准化：保留 baseline.json 里已有的 ignore，同时刷新 files', async () => {
    const rec = await createInstance({ name: 'keep-ignore', harness: 'dir', packDir: PACK });
    const before = readBaseline(rec.root)!;
    const rel = before.files[0]!.path;
    writeFileSync(join(rec.root, rel), 'locally edited', 'utf8');
    // 手工写一份带 ignore 的基线，模拟运行时前缀已经被记录过
    writeFileSync(
      join(rec.root, 'baseline.json'),
      JSON.stringify({ ...before, ignore: ['logs/'] }, null, 2) + '\n',
      'utf8',
    );

    const next = rebaselineInstance('keep-ignore');
    expect(next.ignore).toEqual(['logs/']);

    const onDisk = JSON.parse(readFileSync(join(rec.root, 'baseline.json'), 'utf8')) as {
      ignore?: string[];
      files: { path: string; sha256: string }[];
    };
    expect(onDisk.ignore).toEqual(['logs/']);
    const refreshed = onDisk.files.find((file) => file.path === rel);
    expect(refreshed?.sha256).toBe(createHash('sha256').update('locally edited').digest('hex'));
    expect(onDisk.files).not.toEqual(before.files);
  });

  it('接管来的实例导不出可复现模板', async () => {
    const dir = join(tmp, 'env2');
    mkdirSync(dir, { recursive: true });
    adoptInstance({ dir, name: 'env2', harness: 'dir' });
    const template = exportTemplate('env2');
    expect(template.reproducible).toBe(false);
    const file = writeTemplate(template, join(tmp, 'env2.pal.json'));
    expect(() => readTemplate(file)).toThrow('不可复现');
  });

  it('沿用已有 home：凭据带过来，会话不搬，Pack 写的文件不被覆盖', async () => {
    const source = join(tmp, 'global-dsh');
    mkdirSync(join(source, 'sessions'), { recursive: true });
    mkdirSync(join(source, 'skills', 'doc-review'), { recursive: true });
    writeFileSync(join(source, '.credentials.yaml'), 'apiKey: sk-test\n', 'utf8');
    writeFileSync(join(source, 'AGENTS.md'), '# 全局指令\n', 'utf8');
    writeFileSync(join(source, 'sessions', 'a.jsonl'), '{}\n', 'utf8');
    // 全局 home 里同名 skill：不能盖掉 Pack 装进来的那份
    writeFileSync(join(source, 'skills', 'doc-review', 'SKILL.md'), '# 全局版\n', 'utf8');

    const record = await createInstance({
      name: 'seeded',
      harness: 'dsh',
      packDir: 'examples/doc-review',
      seedFrom: source,
    });
    const home = record.home!;
    expect(readFileSync(join(home, '.credentials.yaml'), 'utf8')).toContain('sk-test');
    expect(readFileSync(join(home, 'AGENTS.md'), 'utf8')).toContain('全局指令');
    expect(existsSync(join(home, 'sessions'))).toBe(false);
    expect(readFileSync(join(home, 'skills', 'doc-review', 'SKILL.md'), 'utf8')).not.toContain('全局版');
    expect(record.origin?.seededFrom).toBe(source);
  });
});
