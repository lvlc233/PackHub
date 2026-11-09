import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { planFor, type PackContext, type TargetId } from '@packhub/kernel';
import { installPack, loadLock, loadPack, loadState, withLockPins } from '@packhub/runtime';
import { ADAPTERS, targetVarsFor } from './layout.ts';
import { baselineFromState, writeBaseline } from './baseline.ts';
import { withInstanceLock } from './lock.ts';
import { API_VERSION, readRecord, recordFile, type InstanceRecord } from './records.ts';
import { assertIsolationSupported, parseIsolation, type Isolation } from './isolation.ts';
import { readPalConfig } from './config.ts';
import { dropActive, readActiveMap, writeActiveMap } from './catalog.ts';
import { failInstance } from './quarantine.ts';
import { writeInstance } from './recordWrite.ts';
import { instancesRoot, newId } from './paths.ts';
import { nowIso } from './time.ts';
import { PalError } from './errors.ts';
import { assertHarness, assertExternalRoot, assertNameFree } from './validators.ts';

/**
 * 建实例与接管：出计划、装 Pack、写记录与基线；接管只写指针，不动用户目录。
 * 从 index.ts 搬出来；不 import index.ts（避免循环），依赖只走 kernel/runtime 与包内底层模块。
 * 名字/宿主的校验在 validators.ts，这里只 import 使用，不重新导出。
 */

export interface CreateInstanceOptions {
  name: string;
  harness: TargetId;
  /** 已经落到本地的 Pack 目录 */
  packDir: string;
  /**
   * 实例根；不写就建在 instances 根下的新目录里。
   * 写了只接受绝对路径，且不能是盘符根/文件系统根、不能落在 instances 根里（见 validators.assertExternalRoot）。
   */
  root?: string;
  /** 记录来源（materialize 前的原始引用），供导出模板与排障 */
  packRef?: string;
  /** 建完是否设为该宿主的当前实例；默认 true */
  activate?: boolean;
  /** 已经探测到的宿主版本；不写就留空 */
  harnessVersion?: string;
  /**
   * 从一个已有的宿主 home 里带来模型凭据与用户指令（不覆盖 Pack 装的东西）。
   * 新 home 是空的：不接这一步，实例起来也没有模型可用。
   */
  seedFrom?: string;
  /**
   * 显式指定这份实例的隔离策略（优先于配置文件）。
   * 不写就用 readPalConfig().isolation；写了必须是合法的五层策略。
   */
  isolation?: Isolation;
  /**
   * 非致命问题的一行说明（目前只有 seedHome 里单个文件没带过来）。
   * 建实例不因此失败；CLI 把它写到 stderr，--json 时不打。
   */
  onWarn?: (line: string) => void;
}

/** 从已有 home 带过来时不搬的东西：会话、缓存、附件、运行时、库文件、profile（带绝对路径）。 */
const SEED_SKIP = new Set(['sessions', 'cache', 'attachments', 'dsh-runtimes', 'storages', 'profiles', 'logs']);

/**
 * 单个 fs 操作失败的原因文字：优先 code/syscall（不带路径），
 * 退回错误消息时把绝对路径截成 …，警告行只回显相对路径，不暴露宿主目录结构。
 */
export function fsProblem(err: unknown): string {
  const e = err as NodeJS.ErrnoException | undefined;
  const head = [
    typeof e?.code === 'string' ? e.code : '',
    typeof e?.syscall === 'string' ? e.syscall : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (head) return head;
  const message = typeof e?.message === 'string' && e.message ? e.message : String(err);
  return message.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s'"]+/g, '…') || '未知原因';
}

/**
 * 把已有 home 里的凭据/指令补进实例 home：只补空缺，已存在的路径一律不动。
 * 先装 Pack 再 seed，所以 Pack 写好的 AGENTS.md、skills 不会被全局那份盖掉。
 * 单个文件搬不过来不阻断建实例，但要收集起来经 onProblem 报告：不然用户只看到「凭据没生效」。
 * 返回顶层条目名（沿用原有语义）。
 */
export function seedHome(from: string, to: string, onProblem?: (line: string) => void): string[] {
  const source = resolve(from);
  if (!existsSync(source)) {
    throw new PalError('not-found', '要导入凭据的 home 目录不存在', {
      hint: '检查 --seed-from 指向的目录；不需要导入就删掉这个参数',
      details: { home: source },
    });
  }
  const copied: string[] = [];
  const problems: string[] = [];
  const walk = (src: string, dest: string): void => {
    const stat = statSync(src);
    if (stat.isDirectory()) {
      if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
      for (const entry of readdirSync(src, { withFileTypes: true })) {
        if (SEED_SKIP.has(entry.name)) continue;
        walk(join(src, entry.name), join(dest, entry.name));
      }
      return;
    }
    if (existsSync(dest)) return;
    try {
      cpSync(src, dest, { force: false, errorOnExist: false });
    } catch (err) {
      // 单个文件搬不过来不影响建实例，但要让人看到少了哪个文件、为什么
      // 相对路径统一用 /，和 update 的 removedFiles 写法一致
      problems.push(`没带过来：${relative(to, dest).split(sep).join('/')}（${fsProblem(err)}）`);
    }
  };
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (SEED_SKIP.has(entry.name)) continue;
    const before = existsSync(join(to, entry.name));
    walk(join(source, entry.name), join(to, entry.name));
    if (!before || entry.isDirectory()) copied.push(entry.name);
  }
  if (onProblem) for (const line of problems) onProblem(line);
  return copied;
}

/**
 * 一份新实例该用哪套隔离策略：显式给的最优先（照样过一遍 parseIsolation），
 * 没给就用全局配置里的默认。配置坏/策略坏/策略还没实现都在建目录之前抛，不留半份实例。
 */
function isolationFor(explicit: Isolation | undefined): Isolation {
  if (explicit === undefined) {
    const configured = readPalConfig().isolation;
    assertIsolationSupported(configured);
    return configured;
  }
  const parsed = parseIsolation(explicit);
  if (!parsed) {
    throw new PalError('invalid-input', '隔离策略不合法：五层必须齐全，每层只能是 instance / shared', {
      hint: '可选层：assembly / session / credentials / cache / runtime；可选模式：instance / shared',
      details: { isolation: explicit },
    });
  }
  assertIsolationSupported(parsed);
  return parsed;
}

/* ---------- 创建 ---------- */

/**
 * 从一个 Pack 目录创建实例：出计划、装进实例根、写实例记录与基线。
 * 失败时只清理我们自己造的根：先把现场移到 .failed，绝不 rm 一个已存在的目录。
 */
export async function createInstance(opts: CreateInstanceOptions): Promise<InstanceRecord> {
  const name = opts.name.trim();
  if (!name) throw new PalError('invalid-input', '实例名不能为空');
  const harness = assertHarness(opts.harness);
  assertNameFree(name);
  // 先定策略：配置读不了就在这里失败，不往下建目录
  const isolation = isolationFor(opts.isolation);

  const id = newId();
  // 默认根由系统分配；显式给的根只用于外部目录，先过校验再落盘任何东西
  const root = opts.root === undefined ? join(instancesRoot(), id) : assertExternalRoot(opts.root);
  const existed = existsSync(root);
  if (existsSync(recordFile(root))) {
    throw new PalError('root-occupied', '这个目录已经是一份实例', {
      hint: '换个目录，或从列表里操作它',
      details: { root },
    });
  }

  const packDir = resolve(opts.packDir);
  const loaded = loadPack(packDir);
  if (!loaded.manifest) {
    const detail = loaded.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ');
    throw new PalError('invalid-input', `清单有问题${detail ? `：${detail}` : ''}`, {
      hint: '确认 Pack 目录里有 packhub.yaml，且清单能被解析',
      details: { packDir },
    });
  }
  const lock = loadLock(packDir);
  const ctx: PackContext = withLockPins(loaded, lock);
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new PalError('invalid-input', `清单有问题：${errors.map((i) => i.message).join('; ')}`);
  }
  if (!ctx.manifest.metadata.targets.includes(harness)) {
    throw new PalError(
      'invalid-input',
      `这个包没有声明 target ${harness}；声明了：${ctx.manifest.metadata.targets.join(', ')}`,
      { details: { pack: ctx.manifest.metadata.name, declared: ctx.manifest.metadata.targets } },
    );
  }

  const adapter = ADAPTERS[harness];
  const targetVars = targetVarsFor(harness);
  const { plan, issues } = planFor(ctx, { target: harness, ...(targetVars ? { targetVars } : {}) });
  if (!plan) {
    throw new PalError('invalid-input', `生成不了计划：${issues.map((i) => i.message).join('; ')}`);
  }

  const home = adapter.homeDir ? join(root, adapter.homeDir) : undefined;
  mkdirSync(root, { recursive: true });
  if (home) mkdirSync(home, { recursive: true });

  const draft: InstanceRecord = {
    apiVersion: API_VERSION,
    id,
    name,
    harness,
    ...(opts.harnessVersion ? { harnessVersion: opts.harnessVersion } : {}),
    root,
    ...(home ? { home } : {}),
    isolation,
    pack: {
      name: ctx.manifest.metadata.name,
      version: ctx.manifest.metadata.version,
      ...(opts.packRef ? { ref: opts.packRef } : {}),
    },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'installing',
    managed: true,
    origin: { kind: 'pack', ...(opts.packRef ? { ref: opts.packRef } : {}), dir: packDir },
    ports: [],
    restart: 'never',
    maxRestarts: 3,
  };
  // 先落 installing：中途崩溃时列表里能看到它，能删能查，不是凭空消失
  writeInstance(draft);

  try {
    await withInstanceLock(root, 'create', async () => {
      const result = await installPack(ctx, plan, { root, packRoot: packDir });
      const failed = result.outcomes.filter((o) => o.status === 'failed');
      if (failed.length > 0) {
        throw new PalError(
          'install-failed',
          `安装未完成：${failed
            .map((o) => `${o.actionId}=${o.status}${o.message ? `（${o.message}）` : ''}`)
            .join(', ')}`,
          { details: { outcomes: failed } },
        );
      }
      writeBaseline(root, {
        pack: draft.pack.name,
        version: draft.pack.version,
        harness,
        planHash: plan.planHash,
        files: baselineFromState(root),
      });
      if (opts.seedFrom && home) {
        // 先装 Pack，再补凭据：Pack 写好的文件不被覆盖
        seedHome(opts.seedFrom, home, opts.onWarn);
        draft.origin = { ...(draft.origin ?? { kind: 'pack' }), seededFrom: resolve(opts.seedFrom) };
      }
      writeInstance({ ...draft, status: 'installed' });
    });
  } catch (err) {
    const reason =
      err instanceof PalError
        ? { code: err.code, message: err.message }
        : { code: 'install-failed', message: (err as Error).message };
    const record = readRecord(root);
    if (record) writeInstance({ ...record, status: 'failed', lastError: { ...reason, at: nowIso() } });
    if (existed) {
      // 复用已有目录：只把配置摘掉，目录本身和里面的东西一概不动
      try {
        rmSync(recordFile(root), { force: true });
      } catch {
        /* 摘不掉就留着 failed 记录，至少能查能删 */
      }
    } else {
      failInstance(root, reason);
    }
    dropActive(id);
    throw err;
  }

  const record = readRecord(root)!;
  if (opts.activate !== false) {
    const map = readActiveMap();
    map[harness] = record.id;
    writeActiveMap(map);
  }
  return record;
}

/* ---------- 接管 ---------- */

export interface AdoptOptions {
  dir: string;
  name: string;
  harness: TargetId;
  /** 接管后是否设为当前实例 */
  activate?: boolean;
}

/**
 * 接管一个已经存在的环境：目录原样不动，只写一份记录指过去。
 * managed=false：删除时只摘记录，绝不删用户目录。
 */
export function adoptInstance(opts: AdoptOptions): InstanceRecord {
  const dir = resolve(opts.dir);
  if (!existsSync(dir)) {
    throw new PalError('not-found', '这个目录不存在', {
      hint: '确认目录还在；接管不会替你创建它',
      details: { dir },
    });
  }
  const harness = assertHarness(opts.harness);
  assertNameFree(opts.name.trim());
  // 接管来的目录不动，但记录里的默认策略跟新建实例一样看全局配置；
  // 配置里写了还没实现的语义（凭据 shared）同样在写记录之前拒绝。
  const isolation = readPalConfig().isolation;
  assertIsolationSupported(isolation);
  if (existsSync(recordFile(dir))) {
    throw new PalError('root-occupied', '这个目录已经是一份实例', {
      hint: '换个目录，或先删掉它的旧记录',
      details: { dir },
    });
  }
  const adapter = ADAPTERS[harness];
  const home = adapter.homeDir && existsSync(join(dir, adapter.homeDir)) ? join(dir, adapter.homeDir) : undefined;
  let pack = { name: 'external', version: '0.0.0' };
  try {
    const entries = Object.values(loadState(dir).packs);
    // 只有恰好一个 Pack 时它的名字才能代表这个实例；多个 Pack 里「第一个」只是对象顺序，
    // 拿来当身份会让记录撒谎，updateInstance 也会把别的 Pack 当成同一个。此时记 external。
    const only = entries.length === 1 ? entries[0] : undefined;
    if (only?.pack) pack = { name: only.pack, version: only.version ?? '0.0.0' };
  } catch {
    /* 没有 state 就是空环境 */
  }
  const record: InstanceRecord = {
    apiVersion: API_VERSION,
    id: newId(),
    name: opts.name.trim(),
    harness,
    root: dir,
    ...(home ? { home } : {}),
    isolation,
    pack,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'installed',
    managed: false,
    origin: { kind: 'adopted', dir },
    ports: [],
    restart: 'never',
    maxRestarts: 3,
  };
  writeInstance(record);
  if (opts.activate !== false) {
    const map = readActiveMap();
    map[harness] = record.id;
    writeActiveMap(map);
  }
  return record;
}
