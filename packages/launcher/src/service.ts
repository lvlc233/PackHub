import type { TargetId } from '@packhub/kernel';
import { createInstance } from './create.ts';
import { PalError } from './errors.ts';
import type { Isolation } from './isolation.ts';
import { materializePack } from './materialize.ts';
import type { InstanceRecord } from './records.ts';
import { readTemplate } from './template.ts';
import { updateInstance, type UpdateInstanceResult } from './update.ts';

/**
 * C9：CLI 与 HTTP handler 共用的编排层。
 *
 * 两边原本各写一遍「取包 → 建/更新实例」：参数解析、json 输出、错误展示仍归各自，
 * 这里只收共用的取包与装配顺序。参数语义按调用方现状分别透传，不在这里统一
 * （例如 import 的 name 默认值：CLI 直接给 args.name，server 先 trim 再兜模板名）。
 *
 * 不 import index.ts（避免与入口的再导出绕圈）；依赖只走包内底层模块。
 */

export interface CreateFromRefOptions {
  /** 原始 Pack 引用：本地目录、.phub、git+，或配合 index 用 registry 名 */
  packRef: string;
  version?: string;
  /** registry 索引：路径、URL 或配置里的名字 */
  index?: string;
  name: string;
  harness: TargetId;
  /** 实例根；调用方已按自己的规则校验（CLI --root / API body.root），这里原样透传 */
  root?: string;
  /** 从已有宿主 home 带模型凭据与指令（CLI --from-home / API body.fromHome） */
  seedFrom?: string;
  /** 显式隔离策略；不写就用配置里的默认（CLI --isolation 解析后传入） */
  isolation?: Isolation;
  /** 已探测到的宿主版本；CLI 会传，HTTP 面不探测（与现状一致） */
  harnessVersion?: string;
  /**
   * 取包进度（含缓存命中提示）与建实例时的非致命警告。
   * CLI 接到 stderr（--json 时不打）；HTTP 面不传，保持不输出。
   */
  log?: (line: string) => void;
}

/**
 * 取 Pack → 建实例。取包失败时不会留下实例；建实例失败由 createInstance 自己清现场。
 */
export async function createFromRef(opts: CreateFromRefOptions): Promise<InstanceRecord> {
  const packDir = await materializePack(opts.packRef, {
    ...(opts.index ? { index: opts.index } : {}),
    ...(opts.version ? { version: opts.version } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  return createInstance({
    name: opts.name,
    harness: opts.harness,
    packDir,
    packRef: opts.packRef,
    ...(opts.root ? { root: opts.root } : {}),
    ...(opts.seedFrom ? { seedFrom: opts.seedFrom } : {}),
    ...(opts.isolation ? { isolation: opts.isolation } : {}),
    ...(opts.harnessVersion ? { harnessVersion: opts.harnessVersion } : {}),
    // CLI 现在就把取包日志函数当 onWarn 用；HTTP 面不传 onWarn，语义不变
    ...(opts.log ? { onWarn: opts.log } : {}),
  });
}

export interface UpdateFromRefOptions {
  /** 实例 id 或名字 */
  idOrName: string;
  /** 这次要装的 Pack 引用；调用方从记录里取 ref ?? name */
  packRef: string;
  version?: string;
  index?: string;
  /** 覆盖本地改过的文件；不写时由 updateInstance 拒绝 */
  force?: boolean;
  log?: (line: string) => void;
}

/** 取 Pack → 更新实例：与 createFromRef 同一条取包路径，换的是写盘目标。 */
export async function updateFromRef(opts: UpdateFromRefOptions): Promise<UpdateInstanceResult> {
  const packDir = await materializePack(opts.packRef, {
    ...(opts.index ? { index: opts.index } : {}),
    ...(opts.version ? { version: opts.version } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  return updateInstance(opts.idOrName, {
    packDir,
    packRef: opts.packRef,
    ...(opts.force ? { force: true } : {}),
  });
}

export interface ImportFromFileOptions {
  /** 模板文件路径；相对路径按进程 cwd 解析（HTTP 面自己先要求绝对路径） */
  file: string;
  /**
   * 新实例名；不写用模板里的名字。
   * 给了空串也原样交给 createInstance（CLI 现状：空名报 invalid-input；HTTP 面自己先兜模板名）。
   */
  name?: string;
  index?: string;
  /** 实例根；调用方已校验，这里原样透传 */
  root?: string;
  /** 取包进度；与 CLI import 现状一致，不当 onWarn 用 */
  log?: (line: string) => void;
}

/**
 * 模板 → 取包 → 建实例：与 CLI import 现有逻辑一致。
 * 模板没有 Pack 引用时无法重建，抛 invalid-input；取包与建实例的失败照常上抛。
 */
export async function importFromFile(opts: ImportFromFileOptions): Promise<InstanceRecord> {
  const template = readTemplate(opts.file);
  const ref = template.origin?.ref;
  if (!ref) {
    throw new PalError('invalid-input', '模板里没有 Pack 引用，重建不了', {
      hint: '用 pal create 重新建，或从 Pack 引用建的实例导出模板',
      details: { file: opts.file },
    });
  }
  const packDir = await materializePack(ref, {
    ...(opts.index ? { index: opts.index } : {}),
    version: template.pack.version,
    ...(opts.log ? { log: opts.log } : {}),
  });
  return createInstance({
    name: opts.name ?? template.name,
    harness: template.harness,
    packDir,
    packRef: ref,
    ...(opts.root ? { root: opts.root } : {}),
  });
}
