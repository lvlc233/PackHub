// `pal start` 的 profile 解析：`--profile` > 记录里的 profile（且不是 all）> 宿主默认（dsh 是 web）。
//
// profile 只对有 profile 子空间的宿主有意义（现在只有 dsh）。attached home 下它是 dsh 自己建的
// `<home>/profiles/<名字>`，启动前核对一次，免得拿拼错的名字起一个空壳 profile；managed home 不核对
// （实例 home 第一次启动时由 dsh 生成）。
//
// `all` 是安装范围（install / update 的「所有已有 profile」），不是可启动的 profile：一次启动只跑一个。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PalError } from './errors.ts';
import { requireAdapter } from './layout.ts';
import type { InstanceRecord } from './records.ts';
import { PROFILE_ALL, PROFILE_NAME_PATTERN } from './validators.ts';

/** 最终 profile 的来源：命令行 / 记录 / 宿主默认。 */
export type StartProfileSource = 'flag' | 'record' | 'default';

export interface StartProfileChoice {
  /** 写进 `StartContext.profile` 的名字；undefined = 这个宿主没有 profile 概念（不带 --profile） */
  name?: string;
  source: StartProfileSource;
}

/** dsh 的 profile 目录（相对 home）：与 kernel dsh 模块的落点同一份形状。 */
const PROFILES_DIR = 'profiles';

/**
 * profile 名会拼进 `<home>/profiles/<名字>`，只收一段目录名（`..`、路径分隔符随之被拒）。
 * 规则与 install / update 的 `--profile` 同一份（`PROFILE_NAME_PATTERN`），这里只是换成本命令的文案。
 */
function profileName(value: string, label: string): string {
  const text = value.trim();
  if (!text) {
    throw new PalError('invalid-input', `${label} 不能为空`, {
      hint: '写 dsh 的 profile 名，例如 --profile desktop；不写 = 用记录里的 profile（记录是 all 时用 web）',
    });
  }
  if (!PROFILE_NAME_PATTERN.test(text)) {
    throw new PalError('invalid-input', `${label} 名字不合法：${text}`, {
      hint: '只能是一段目录名：字母、数字、. _ -，不能带路径分隔符或 ..',
      details: { profile: text },
    });
  }
  return text;
}

/** attached dsh 的 profile 必须已经在 home 里（dsh 启动时才会建它）；managed 不核对。 */
function assertProfileDir(rec: InstanceRecord, name: string): void {
  // 只有 dsh 的 profile 落点是 `<home>/profiles/<名字>`；别的宿主即使声明了默认 profile 也不套这个目录
  if (rec.harness !== 'dsh' || rec.attached !== true) return;
  const home = rec.home ?? rec.root;
  const dir = join(home, PROFILES_DIR, name);
  if (existsSync(dir)) return;
  throw new PalError('invalid-input', `profile「${name}」不存在：${dir}`, {
    hint: `先启动一次 dsh 生成这个 profile（dsh --profile ${name}），或用 --profile 换一个已有的 profile`,
    details: { profile: name, home },
  });
}

/**
 * 解析并核对这次启动用的 profile。纯读，不建目录、不写记录。
 *
 * - 没有 `startProfile` 的宿主（非 dsh / dir）：传了 `--profile` 是用法错（退出 2），不静默忽略；
 * - 显式 `--profile` 只能用具体名字，`all` 退 2；
 * - 否则用记录里的 profile，记录是 all / 没记就用宿主默认；
 * - 最终名字是具体 profile 时，attached dsh 核对 `<home>/profiles/<名字>` 存在。
 */
export function resolveStartProfile(rec: InstanceRecord, requested?: string): StartProfileChoice {
  const adapter = requireAdapter(rec.harness);
  const explicit = requested === undefined ? undefined : profileName(requested, '--profile');
  if (adapter.startProfile === undefined) {
    if (explicit !== undefined) {
      throw new PalError('invalid-input', `--profile 只对 dsh 有意义：${adapter.label} 没有 profile`, {
        hint: 'profile 是 dsh 的全局子空间（web / desktop 这类）；其他宿主直接 pal start <home>',
        details: { harness: rec.harness },
      });
    }
    return { source: 'default' };
  }
  if (explicit === PROFILE_ALL) {
    throw new PalError('invalid-input', '--profile all 不能用于启动：一次只起一个 profile', {
      hint: '要指定就写具体名字（例如 --profile web）；不写 = 用记录里的 profile，记录是 all 时用 web',
    });
  }

  const recorded =
    rec.profile === undefined || rec.profile === PROFILE_ALL
      ? undefined
      : profileName(rec.profile, '记录里的 profile');
  const name = explicit ?? recorded ?? adapter.startProfile;
  assertProfileDir(rec, name);
  return {
    name,
    source: explicit !== undefined ? 'flag' : recorded !== undefined ? 'record' : 'default',
  };
}
