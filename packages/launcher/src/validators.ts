import { homedir } from 'node:os';
import { isAbsolute, parse, resolve, sep } from 'node:path';
import { harnessIds, isHarnessId, type HarnessId } from '@packhub/kernel';
import { instanceKinds, isInstanceKind, type InstanceKind } from './layout.ts';
import { listInstances } from './catalog.ts';
import { instancesRoot } from './paths.ts';
import { PalError } from './errors.ts';

/**
 * 建实例之前的校验：名字不能撞车、宿主必须是已知的那几个、显式实例根得是外部绝对路径。
 * 从 create.ts 搬出来；create / adopt / migrate / cli / server 共用，不从 index.ts 对外导出。
 */

/* ---------- 校验 ---------- */

function nameTaken(name: string): boolean {
  return listInstances().some((i) => i.name === name);
}

/** 名字不能撞上已有实例。建实例、接管、复制、改名都要过这一关，所以从这里导出共用。 */
export function assertNameFree(name: string): void {
  if (nameTaken(name)) {
    throw new PalError('name-taken', `实例名已存在：${name}`, { hint: '换一个名字，或先删掉旧实例' });
  }
}

export function assertHarness(value: string): InstanceKind {
  if (!isInstanceKind(value)) {
    throw new PalError('unknown-harness', `没有这个实例形态：${value}`, {
      hint: `可选：${instanceKinds().join(' / ')}（dir 是项目目录实例，其余是宿主）`,
      details: { harness: value, choices: instanceKinds() },
    });
  }
  return value;
}

/**
 * `--host` 的取值：只认注册表里的宿主名（dir 不是宿主）。
 * `what` 是命令名，用在 missing 的文案里（install / adopt）。
 */
export function hostArg(raw: unknown, what: string): HarnessId {
  const value = String(raw ?? '').trim();
  if (!value) {
    throw new PalError('invalid-input', `${what} 需要 --host`, {
      hint: `按哪个宿主的落点：${harnessIds().join(' / ')}`,
    });
  }
  if (!isHarnessId(value)) {
    throw new PalError('invalid-input', `未知宿主：${value}`, {
      hint: `可选 ${harnessIds().join(' / ')}`,
      details: { host: value, choices: harnessIds() },
    });
  }
  return value;
}

/**
 * 命名 home 的冲突：默认名 / `--name` 撞上已有 home 是用法错（退出 2），不是服务器冲突。
 * 提示直接给下一步：换版本 / 直接跑 / 换个名字。
 */
export function assertHomeNameFree(name: string): void {
  if (nameTaken(name)) {
    throw new PalError('invalid-input', `同名 home 已存在：${name}`, {
      hint: `pal update ${name} 换版本，pal run ${name} 直接跑，或用 --name 换个名字`,
      details: { name },
    });
  }
}

/**
 * attached home 的名字：默认名冲突时自动改用 `<base>-attached`，再冲突才退 2。
 *
 * 只对「没写 --name」的默认名生效：显式起的名字是用户的选择，冲突就该退 2 让他改，
 * 不能背着他换成另一个名字。managed 默认名不走这里（冲突保持原样退 2）。
 */
export function resolveAttachedName(
  base: string,
  explicit: boolean,
): { name: string; base: string; adjusted: boolean } {
  if (explicit || !nameTaken(base)) {
    assertHomeNameFree(base);
    return { name: base, base, adjusted: false };
  }
  const alternative = `${base}-attached`;
  if (nameTaken(alternative)) {
    throw new PalError('invalid-input', `同名 home 已存在：${base}（${alternative} 也被占用）`, {
      hint: '默认名与自动区分名都被占用；用 --name 换一个名字，pal list 看现有 home',
      details: { name: base, tried: [base, alternative] },
    });
  }
  return { name: alternative, base, adjusted: true };
}

/**
 * 危险动作（clone / backup / restore / migrate）只对 managed home 开放：
 * attached home 是宿主的目录，PAL 不搬、不整根备份。remove 不在其中——它只摘记录、不删目录；
 * 要卸包用 uninstall --home。
 */
export function assertNotAttached(home: { attached?: boolean; root: string }): void {
  if (home.attached !== true) return;
  throw new PalError(
    'invalid-input',
    `attached home 不归 PAL：clone / backup / restore / migrate 只对 managed home 开放；remove 只摘记录、不删目录，卸包用 pal uninstall --home ${home.root}`,
    { details: { root: home.root } },
  );
}

/* ---------- dsh attached 的 profile ---------- */

/**
 * profile 名会拼进 `<home>/profiles/<名字>/cordis.patch.yml`，所以只收一段目录名：
 * 字母 / 数字 / `.` `_` `-`，首字符必须是字母或数字（`..` 这类名字随之被拒）。
 */
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 校验 `--profile` 的名字；空值与带路径分隔符的名字都是用法错（退出 2）。 */
export function assertProfileName(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new PalError('invalid-input', '--profile 不能为空', {
      hint: '写 dsh 的 profile 名，例如 --profile web；不写 = 所有已有 profile',
    });
  }
  if (!PROFILE_NAME_PATTERN.test(text)) {
    throw new PalError('invalid-input', `--profile 的名字不合法：${text}`, {
      hint: '只能是一段目录名：字母、数字、. _ -，不能带路径分隔符或 ..',
      details: { profile: text },
    });
  }
  return text;
}

/**
 * `update --profile all` 的显式「全部」取值：dsh 的 profile 名不会是 `all`（它自己用
 * web / desktop / headless 这类），所以能当保留值。记录里不写 profile 就是 all。
 */
export const PROFILE_ALL = 'all';

/**
 * `update --profile` 的目标：`all` 是显式切回全部已有 profile（返回 undefined，记录里不写
 * profile），其余先过安全边界（会拼进落点路径）。不写 flag 的「沿用记录」由调用方决定，
 * 这里不接 undefined。
 */
export function updateProfileTarget(value: unknown): string | undefined {
  const name = assertProfileName(value);
  return name === PROFILE_ALL ? undefined : name;
}

/**
 * `--profile` 只对 dsh 的 attached home 有意义：MCP 是 per-profile 的，只有它按 profile 分叉。
 * 项目落点、managed home、其它宿主都没有这层语义；传了就是用法错（退出 2），不静默忽略。
 */
export function assertProfileTarget(kind: string, attached: boolean): void {
  if (kind === 'dsh' && attached) return;
  throw new PalError(
    'invalid-input',
    '--profile 只对 --host dsh 的 attached home（--home <路径>）有意义',
    {
      hint:
        'profile 是 dsh 的全局子空间：项目落点、managed home 与其它宿主没有 per-profile 的 MCP 配置；' +
        '不带 --profile 就是 dsh attached 的缺省（所有已有 profile）',
      details: { harness: kind, attached },
    },
  );
}

/* ---------- 路径输入 ---------- */

/**
 * 路径输入的公共门槛：只要绝对路径，`~` 不展开，UNC（`\\server\share` / `//server/share`）不收。
 *
 * 不解析 cwd 相对路径：CLI、别的进程算出来的「当前目录」可能不是一个地方，
 * 猜错了就把实例指到意想不到的目录里。UNC 会被 PAL 当成普通目录，跨机行为不可控；
 * `~` 在这边也不是 shell，展开不了。失败一律 invalid-input；message 不回显完整路径，
 * 排障看 details（键名由 field 决定，保持各接口原有的 details 形状）。
 */
function absolutePath(value: unknown, what: string, field: string): string {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new PalError('invalid-input', `${what}不能为空`, {
      hint: '给一个绝对路径',
      details: { [field]: text },
    });
  }
  if (text.startsWith('~')) {
    throw new PalError('invalid-input', `${what}不收 ~ 开头的路径`, {
      hint: 'PAL 不展开 ~；请写完整绝对路径',
      details: { [field]: text },
    });
  }
  if (/^[\\/]{2}/.test(text)) {
    throw new PalError('invalid-input', `${what}不收 UNC 路径`, {
      hint: '网络盘请先映射成本地盘符，或复制到本地目录再操作',
      details: { [field]: text },
    });
  }
  if (!isAbsolute(text)) {
    throw new PalError('invalid-input', `${what}必须是绝对路径`, {
      hint: 'PAL 不解析相对路径（不替你猜当前目录）；请给完整路径',
      details: { [field]: text },
    });
  }
  return resolve(text);
}

/**
 * 只要绝对路径的输入（adopt 的目录、import 的模板与 root、clone 的 root、migrate 的目标、export 的输出）。
 * what 会写进错误文案，field 是 details 里的键名。
 */
export function assertAbsolutePath(value: unknown, what: string, field: string): string {
  return absolutePath(value, what, field);
}

/**
 * `--home` 的路径输入：宿主全局目录的写法常见 `~/.config/opencode`，这里把开头的 `~`
 * 展开成本机 home，其余仍要求绝对路径（PAL 不猜 cwd）。`--project` 仍走 assertAbsolutePath。
 * `what` 只用于错误文案（`--from-home` 也走这一条，同样接受 `~`）。
 */
export function homePathInput(value: unknown, what = 'attached home'): string {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new PalError('invalid-input', `${what} 不能为空`, {
      hint: '给一个绝对路径或 ~/ 开头的宿主全局目录，例如 ~/.config/opencode',
      details: { home: text },
    });
  }
  const expanded = /^~([\\/]|$)/.test(text) ? resolve(homedir(), `.${text.slice(1)}`) : text;
  return absolutePath(expanded, what, 'home');
}

/* ---------- 显式实例根 ---------- */

/**
 * 显式给的实例根（CLI `--root` / API `body.root`）：只接受绝对路径，返回规范化后的路径。
 *
 * 相对路径、`~`、UNC 一律拒绝（同 assertAbsolutePath）。也不接受盘符根 / 文件系统根，
 * 以及 PAL 自己的 instances 根——那里不给 root 时按 id 分配，显式 root 只用于外部目录。
 * 失败一律 invalid-input；message 不回显完整路径，排障看 details。
 */
export function assertExternalRoot(value: unknown): string {
  const target = absolutePath(value, '实例根', 'root');
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
