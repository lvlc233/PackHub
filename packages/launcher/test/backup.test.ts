import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInstance, listInstances, readInstance, type InstanceRecord } from '../src/index.ts';
import {
  BACKUP_API_VERSION,
  BACKUP_FILE,
  backupInstance,
  restoreBackup,
  type BackupMeta,
} from '../src/backup.ts';
import { backupsRoot, instancesRoot } from '../src/paths.ts';
import { isPalError } from '../src/errors.ts';

const PACK = 'examples/doc-review';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pal-backup-'));
  // 实例根与 PAL home 都指到临时目录：别读到开发机上的真实例与真配置
  process.env.PACKHUB_HOME = join(tmp, 'home');
  process.env.PACKHUB_INSTANCES = join(tmp, 'instances');
});

afterEach(() => {
  delete process.env.PACKHUB_HOME;
  delete process.env.PACKHUB_INSTANCES;
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * 建一份带运行痕迹的源实例：home 里放业务文件，根里放日志、凭据、锁与停止标记。
 * 这几样正是备份要区别对待的：业务文件带走，运行痕迹与凭据按规则处理。
 */
async function makeSource(): Promise<InstanceRecord> {
  const source = await createInstance({ name: 'src', harness: 'dsh', packDir: PACK });
  mkdirSync(join(source.home!, 'skills'), { recursive: true });
  writeFileSync(join(source.home!, 'note.txt'), 'hello\n', 'utf8');
  writeFileSync(join(source.home!, 'skills', 'SKILL.md'), '# skill\n', 'utf8');
  mkdirSync(join(source.root, 'logs'), { recursive: true });
  writeFileSync(join(source.root, 'logs', 'start.log'), 'started\n', 'utf8');
  writeFileSync(join(source.root, 'secrets.json'), JSON.stringify({ token: 'sk-test' }), 'utf8');
  writeFileSync(
    join(source.root, '.pal-lock.json'),
    JSON.stringify({ pid: process.pid, op: 'create', at: new Date().toISOString() }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(source.root, '.pal-stopping'),
    JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    'utf8',
  );
  return source;
}

function readMeta(dir: string): BackupMeta {
  return JSON.parse(readFileSync(join(dir, BACKUP_FILE), 'utf8')) as BackupMeta;
}

describe('整实例备份', () => {
  it('默认不带 secrets：复制 home 与数据，排除锁、停止标记与 logs/，写 backup.json', async () => {
    const source = await makeSource();
    const result = backupInstance('src');

    // 默认落在 <PACKHUB_HOME>/backups/<名字>-<时间戳>
    expect(result.dir.startsWith(backupsRoot())).toBe(true);
    expect(result.dir).toMatch(/[\\/]backups[\\/]src-\d{14}$/);

    const meta = readMeta(result.dir);
    expect(meta.apiVersion).toBe(BACKUP_API_VERSION);
    expect(meta.instance.id).toBe(source.id);
    expect(meta.instance.name).toBe('src');
    expect(meta.instance.harness).toBe('dsh');
    expect(meta.instance.pack).toBe('lvlc233/doc-review');
    expect(meta.instance.version).toBe('0.1.0');
    expect(meta.instance.createdAt).toBe(source.createdAt);
    expect(meta.includesSecrets).toBe(false);
    expect(meta.fileCount).toBe(result.meta.fileCount);
    expect(meta.fileCount).toBeGreaterThan(0);

    // 实例内容在：记录与 home 文件都能从备份里读到
    expect(existsSync(join(result.dir, 'instance.json'))).toBe(true);
    expect(readFileSync(join(result.dir, 'home', 'dsh', 'note.txt'), 'utf8')).toBe('hello\n');
    expect(readFileSync(join(result.dir, 'home', 'dsh', 'skills', 'SKILL.md'), 'utf8')).toBe('# skill\n');
    // 凭据与运行痕迹不在
    expect(existsSync(join(result.dir, 'secrets.json'))).toBe(false);
    expect(existsSync(join(result.dir, '.pal-lock.json'))).toBe(false);
    expect(existsSync(join(result.dir, '.pal-stopping'))).toBe(false);
    expect(existsSync(join(result.dir, 'logs'))).toBe(false);

    // 不覆盖已有目录
    let caught: unknown;
    try {
      backupInstance('src', { out: result.dir });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('root-occupied');
  });

  it('includeSecrets 才带 secrets.json（要显式）', async () => {
    await makeSource();
    const out = join(tmp, 'with-secrets');
    const result = backupInstance('src', { includeSecrets: true, out });

    expect(result.dir).toBe(out);
    expect(result.meta.includesSecrets).toBe(true);
    expect(readMeta(out).includesSecrets).toBe(true);
    expect(readFileSync(join(out, 'secrets.json'), 'utf8')).toContain('sk-test');
    // 锁与停止标记仍然不搬
    expect(existsSync(join(out, '.pal-lock.json'))).toBe(false);
    expect(existsSync(join(out, '.pal-stopping'))).toBe(false);
  });

  it('宿主凭据文件按 ADAPTERS.credentialFiles 剥离：默认不带，includeSecrets 才带', async () => {
    const source = await makeSource();
    const home = source.home!;
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ token: 'host-token' }), 'utf8');
    writeFileSync(join(home, '.credentials.yaml'), 'apiKey: sk-host\n', 'utf8');
    // 别处同名文件不是宿主凭据：剥离只按适配器 home 段匹配，不能误删
    writeFileSync(join(source.root, 'auth.json'), JSON.stringify({ token: 'root-token' }), 'utf8');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(join(home, 'sessions', 'auth.json'), JSON.stringify({ token: 'session-token' }), 'utf8');

    const plain = backupInstance('src', { out: join(tmp, 'cred-plain') });
    expect(existsSync(join(plain.dir, 'home', 'dsh', 'auth.json'))).toBe(false);
    expect(existsSync(join(plain.dir, 'home', 'dsh', '.credentials.yaml'))).toBe(false);
    // 根上与 home 子目录里的同名文件照常备份
    expect(readFileSync(join(plain.dir, 'auth.json'), 'utf8')).toContain('root-token');
    expect(readFileSync(join(plain.dir, 'home', 'dsh', 'sessions', 'auth.json'), 'utf8')).toContain(
      'session-token',
    );

    const withSecrets = backupInstance('src', { includeSecrets: true, out: join(tmp, 'cred-with') });
    expect(readFileSync(join(withSecrets.dir, 'home', 'dsh', 'auth.json'), 'utf8')).toContain('host-token');
    expect(readFileSync(join(withSecrets.dir, 'home', 'dsh', '.credentials.yaml'), 'utf8')).toContain('sk-host');
  });

  it('运行中的实例拒绝备份（拷一份正在写的 home 没有意义）', async () => {
    const source = await makeSource();
    writeFileSync(
      join(source.root, 'instance.json'),
      JSON.stringify({ ...readInstance(source.id)!, status: 'running', pid: process.pid }, null, 2),
      'utf8',
    );
    let caught: unknown;
    try {
      backupInstance('src');
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('already-running');
    expect(existsSync(join(backupsRoot(), 'src'))).toBe(false);
  });
});

describe('从备份恢复', () => {
  it('恢复成新名字 + 显式新根：内容回来，instance.json 指向新位置', async () => {
    const source = await makeSource();
    const backup = backupInstance('src', { includeSecrets: true });
    const targetRoot = join(tmp, 'restored-root');

    const rec = restoreBackup(backup.dir, { name: 'restored', root: targetRoot });

    expect(rec.id).not.toBe(source.id);
    expect(rec.name).toBe('restored');
    expect(rec.root).toBe(targetRoot);
    expect(rec.home).toBe(join(targetRoot, 'home', 'dsh'));
    expect(rec.status).toBe('installed');
    expect(rec.managed).toBe(true);
    expect(rec.origin).toEqual({ kind: 'copy', from: source.id });
    // 运行痕迹作废：恢复出来的实例没在跑
    expect(rec.pid).toBeUndefined();
    expect(rec.port).toBeUndefined();
    expect(rec.url).toBeUndefined();
    expect(rec.ports).toEqual([]);

    // 文件按相对位置回来了
    expect(readFileSync(join(rec.home!, 'note.txt'), 'utf8')).toBe('hello\n');
    expect(readFileSync(join(rec.home!, 'skills', 'SKILL.md'), 'utf8')).toBe('# skill\n');
    // 备份里带着凭据，所以恢复出来也有
    expect(existsSync(join(rec.root, 'secrets.json'))).toBe(true);
    // 旧锁与旧停止标记不回填，备份信封也不进实例根
    expect(existsSync(join(rec.root, '.pal-lock.json'))).toBe(false);
    expect(existsSync(join(rec.root, '.pal-stopping'))).toBe(false);
    expect(existsSync(join(rec.root, BACKUP_FILE))).toBe(false);
    // 备份本身没被改动
    expect(existsSync(join(backup.dir, BACKUP_FILE))).toBe(true);

    // 磁盘上的记录与返回值一致：id / name / root / home 全部重写
    const disk = JSON.parse(readFileSync(join(targetRoot, 'instance.json'), 'utf8')) as InstanceRecord;
    expect(disk.id).toBe(rec.id);
    expect(disk.name).toBe('restored');
    expect(disk.root).toBe(targetRoot);
    expect(disk.home).toBe(join(targetRoot, 'home', 'dsh'));
    expect(disk.status).toBe('installed');
    expect(disk.managed).toBe(true);
    expect(disk.origin).toEqual({ kind: 'copy', from: source.id });
    // 外部根靠 .links 进列表
    expect(readInstance(rec.id)?.root).toBe(targetRoot);
    expect(listInstances().map((row) => row.id)).toContain(rec.id);
  });

  it('不写 root 时按新 id 分配在实例根下，home 跟着新根走', async () => {
    await makeSource();
    const backup = backupInstance('src');
    const rec = restoreBackup(backup.dir, { name: 'auto' });

    expect(rec.root).toBe(join(instancesRoot(), rec.id));
    expect(rec.home).toBe(join(rec.root, 'home', 'dsh'));
    expect(readInstance(rec.id)?.home).toBe(rec.home);
    expect(readFileSync(join(rec.home!, 'note.txt'), 'utf8')).toBe('hello\n');
    expect(existsSync(join(rec.root, 'secrets.json'))).toBe(false);
  });

  it('重复恢复同名/同根都报错，不覆盖已有实例', async () => {
    await makeSource();
    const backup = backupInstance('src');
    const root = join(tmp, 'dup-root');
    const first = restoreBackup(backup.dir, { name: 'dup', root });

    let caught: unknown;
    try {
      restoreBackup(backup.dir, { name: 'dup', root: join(tmp, 'dup-root-2') });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('name-taken');
    expect(existsSync(join(tmp, 'dup-root-2'))).toBe(false);

    let caught2: unknown;
    try {
      restoreBackup(backup.dir, { name: 'dup-2', root });
    } catch (err) {
      caught2 = err;
    }
    expect(isPalError(caught2) && caught2.code).toBe('root-occupied');
    // 已恢复的那份没被动过
    expect(readInstance(first.id)?.name).toBe('dup');
    expect(readFileSync(join(root, 'instance.json'), 'utf8')).toContain(first.id);
  });

  it('路径安全：.. 段、非备份目录、不存在的目录都有稳定错误码', async () => {
    await makeSource();
    const backup = backupInstance('src');

    // 用 .. 绕回同一层也不行：备份目录必须直接就是 backup.json 所在的那一层
    let escaped: unknown;
    try {
      restoreBackup(`${backup.dir}/../${basename(backup.dir)}`, { name: 'escape' });
    } catch (err) {
      escaped = err;
    }
    expect(isPalError(escaped) && escaped.code).toBe('invalid-input');
    if (isPalError(escaped)) expect(escaped.message).toContain('..');

    const cases: Array<[string, string]> = [
      // 备份根下面没有 backup.json
      [backupsRoot(), 'invalid-input'],
      // 备份里的 home 段不是备份（有文件，没有 backup.json）
      [join(backup.dir, 'home', 'dsh'), 'invalid-input'],
      [join(tmp, 'no-such-backup'), 'not-found'],
    ];
    for (const [dir, code] of cases) {
      let caught: unknown;
      try {
        restoreBackup(dir, { name: `safe-${code}` });
      } catch (err) {
        caught = err;
      }
      expect(isPalError(caught), dir).toBe(true);
      if (isPalError(caught)) expect(caught.code).toBe(code);
    }
    // 拒绝之后没有凭空建出实例
    expect(listInstances().filter((row) => row.name.startsWith('safe-'))).toEqual([]);

    // apiVersion 不对的目录不算备份
    const fake = join(tmp, 'fake-backup');
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, BACKUP_FILE), JSON.stringify({ apiVersion: 'other/v1' }), 'utf8');
    let caught: unknown;
    try {
      restoreBackup(fake, { name: 'fake' });
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code).toBe('invalid-input');
  });
});
