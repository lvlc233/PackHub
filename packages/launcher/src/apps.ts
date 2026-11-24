// app 可执行文件的通用解析：环境变量优先，其次按适配器给的候选路径找。
//
// 每个宿主的 app 在哪安装只有它自己知道（dsh 是 Windows 常见安装位置，codex 没有可靠默认、
// 只能靠环境变量）：候选路径写在 `LaunchMode.app.candidates`，这里只执行同一套顺序与报错。
import { existsSync } from 'node:fs';
import { PalError } from './errors.ts';

/** 解析 app 时可注入的事实（测试用；缺省读 process）。 */
export interface AppLookup {
  /** 读环境变量的来源；缺省 process.env */
  env?: Record<string, string | undefined>;
  /** 只在 Windows 上按候选路径找；缺省 process.platform */
  platform?: NodeJS.Platform;
  /** 文件存在判断；缺省 existsSync */
  exists?: (file: string) => boolean;
  /** 交给 `candidates(home)` 的实例 home 段（app 不在 home 里的宿主不写） */
  home?: string;
  /** 报错里给人看的名字，例如「桌面窗口（Electron app）」 */
  label?: string;
}

/** 名字按大小写不敏感读：Windows 的 process.env 就是，测试里给的对象也照同一套规则。 */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper) return value;
  }
  return undefined;
}

/**
 * 解析 app 可执行文件：`app.env` 优先（显式给了就不用猜），其次 Windows 上的候选路径。
 * 两条都找不到（或显式变量指向的文件不存在）报 invalid-input（退出 2），提示设置环境变量。
 */
export function resolveAppBin(
  app: { env: string; candidates: (home: string) => string[] },
  lookup: AppLookup = {},
): string {
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  const exists = lookup.exists ?? existsSync;
  const label = lookup.label ?? 'app';

  const explicit = envValue(env, app.env)?.trim();
  if (explicit) {
    if (exists(explicit)) return explicit;
    throw new PalError('invalid-input', `${app.env} 指向的文件不存在：${explicit}`, {
      hint: `把它指向${label}的实际路径；清掉这个变量则按常见安装位置查找`,
      details: { env: app.env, path: explicit },
    });
  }

  const candidates = platform === 'win32' ? app.candidates(lookup.home ?? '') : [];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }

  throw new PalError('invalid-input', `找不到${label}的可执行文件`, {
    hint:
      `设置 ${app.env} 指向它` +
      (candidates.length ? '；或者按常见安装位置安装它' : '（这个宿主没有可靠的默认安装位置）'),
    details: { env: app.env, candidates },
  });
}
