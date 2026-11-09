import { isAbsolute, parse, resolve, sep } from 'node:path';
import type { TargetId } from '@packhub/kernel';
import { HARNESS_IDS } from './layout.ts';
import { listInstances } from './catalog.ts';
import { instancesRoot } from './paths.ts';
import { PalError } from './errors.ts';

/**
 * 建实例之前的校验：名字不能撞车、宿主必须是已知的那几个、显式实例根得是外部绝对路径。
 * 从 create.ts 搬出来；create / adopt / migrate / cli / server 共用，不从 index.ts 对外导出。
 */

/* ---------- 校验 ---------- */

/** 名字不能撞上已有实例。建实例、接管、复制、改名都要过这一关，所以从这里导出共用。 */
export function assertNameFree(name: string): void {
  if (listInstances().some((i) => i.name === name)) {
    throw new PalError('name-taken', `实例名已存在：${name}`, { hint: '换一个名字，或先删掉旧实例' });
  }
}

export function assertHarness(value: string): TargetId {
  if (!(HARNESS_IDS as string[]).includes(value)) {
    throw new PalError('unknown-harness', `没有这个宿主：${value}`, {
      hint: `可选：${HARNESS_IDS.join(' / ')}`,
      details: { harness: value, choices: HARNESS_IDS },
    });
  }
  return value as TargetId;
}

/* ---------- 显式实例根 ---------- */

/**
 * 显式给的实例根（CLI `--root` / API `body.root`）：只接受绝对路径，返回规范化后的路径。
 *
 * 不解析 cwd 相对路径：CLI、界面、别的进程算出来的「当前目录」可能不是一个地方，
 * 猜错了就把实例建到意想不到的目录里。也不接受盘符根 / 文件系统根，以及 PAL 自己的
 * instances 根——那里不给 root 时按 id 分配，显式 root 只用于外部目录。
 * 失败一律 invalid-input；message 不回显完整路径，排障看 details。
 */
export function assertExternalRoot(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new PalError('invalid-input', '实例根不能为空', { hint: '给一个外部目录的绝对路径' });
  }
  if (!isAbsolute(text)) {
    throw new PalError('invalid-input', '实例根必须是绝对路径', {
      hint: 'PAL 不解析相对路径（不替你猜当前目录）；请给完整路径',
      details: { root: text },
    });
  }
  const target = resolve(text);
  if (target === parse(target).root) {
    throw new PalError('invalid-input', '实例根不能是盘符根或文件系统根', {
      hint: '给一个具体目录；PAL 会按需创建它',
      details: { root: target },
    });
  }
  // Windows 上同一个目录换个大小写还是同一个：比较前统一小写
  const norm = (input: string): string => (process.platform === 'win32' ? input.toLowerCase() : input);
  const base = resolve(instancesRoot());
  if (norm(target) === norm(base) || norm(target).startsWith(norm(base) + sep)) {
    throw new PalError('invalid-input', '实例根不能落在 PAL 的实例目录里', {
      hint: '不给 --root 时实例本来就建在那里；显式 root 只用于外部目录',
      details: { root: target, instancesRoot: base },
    });
  }
  return target;
}
