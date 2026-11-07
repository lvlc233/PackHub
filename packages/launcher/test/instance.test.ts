import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { join } from 'node:path';
import {
  adoptInstance,
  cloneInstance,
  createInstance,
  exportTemplate,
  listInstances,
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
import { baselineDrift } from '../src/health.ts';
import { archiveRoot, failedRoot, quarantineRoot } from '../src/paths.ts';

const PACK = 'examples/doc-review';

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

    await removeInstance('demo');
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

  it('接管来的目录删除时只摘记录', async () => {
    const dir = join(tmp, 'existing-env');
    mkdirSync(join(dir, 'home', 'dsh'), { recursive: true });
    writeFileSync(join(dir, 'mine.txt'), 'keep', 'utf8');
    const record = adoptInstance({ dir, name: 'adopted', harness: 'dsh' });
    expect(record.managed).toBe(false);
    expect(record.home).toBe(join(dir, 'home', 'dsh'));

    const result = await removeInstance('adopted');
    expect(result.removed).toBe(false);
    expect(existsSync(join(dir, 'mine.txt'))).toBe(true);
    expect(listInstances()).toEqual([]);
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
