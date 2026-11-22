import { isAbsolute, relative } from 'node:path';
import {
  HARNESSES,
  type HarnessId,
  type LayoutVars,
  type StartTemplate,
} from '@packhub/kernel';

/**
 * 实例形态：`dir` 是普通项目目录实例（不是宿主），其余是宿主名。
 *
 * 这几个值是 PAL 自己的概念，不是 kernel 的安装参数枚举——kernel 的 `--harness`
 * 只有宿主名；PAL 在建实例时把 `dir` 映射成「不传 harness（平铺目录）」。
 * 宿主名单从 kernel 的 `HARNESSES` 表派生：加宿主只改表。
 */
export type InstanceKind = 'dir' | HarnessId;

export const INSTANCE_KINDS: readonly InstanceKind[] = [
  'dir',
  ...(Object.keys(HARNESSES) as HarnessId[]),
];

/** 每个宿主在实例根里怎么放 home 段、用哪个环境变量指过去、能不能直接起。 */
export interface HarnessAdapter {
  label: string;
  /** 实例内的 home 目录（相对实例根）；dir 没有 */
  homeDir?: string;
  /** 把宿主指到这个 home 的环境变量 */
  homeEnv?: string;
  /** 启动这个宿主时带的 profile 名（宿主能力的一部分）；没有就不带 --profile */
  startProfile?: string;
  /** 宿主可执行文件名 */
  executable?: string;
  /** 探测版本用的参数 */
  versionArgs?: string[];
  /**
   * 宿主自己的凭据文件（相对 homeDir 的文件名，可含子路径）。
   * 只用于备份/归档时剥离，**不是安装落点**：PAL 不往这些位置写东西，也不在这列表里找什么。
   */
  credentialFiles?: string[];
  /** 启动模板；没有就说明这个宿主没有可托管的常驻服务 */
  start?: StartTemplate;
  /** 不能启动时给用户看的原因（不是错误码，是能力说明） */
  noStartReason?: string;
}

/**
 * 由 kernel 的宿主描述表派生一个适配器：PAL 只把它拍平成
 * homeDir / homeEnv 这类字段，值本身不在 launcher 再抄一遍。
 */
function adapterFrom(id: HarnessId): HarnessAdapter {
  const harness = HARNESSES[id];
  return {
    label: harness.label,
    ...(harness.home ? { homeDir: harness.home.dir, homeEnv: harness.home.env } : {}),
    ...(harness.startProfile ? { startProfile: harness.startProfile } : {}),
    ...(harness.executable ? { executable: harness.executable } : {}),
    ...(harness.versionArgs ? { versionArgs: [...harness.versionArgs] } : {}),
    ...(harness.credentialFiles ? { credentialFiles: [...harness.credentialFiles] } : {}),
    ...(harness.start ? { start: harness.start } : {}),
    ...(harness.noStartReason ? { noStartReason: harness.noStartReason } : {}),
  };
}

const HOST_ADAPTERS = Object.fromEntries(
  (Object.keys(HARNESSES) as HarnessId[]).map((id) => [id, adapterFrom(id)]),
) as Record<HarnessId, HarnessAdapter>;

export const ADAPTERS: Record<InstanceKind, HarnessAdapter> = {
  dir: {
    label: '普通项目',
    noStartReason: 'dir 实例是一个项目目录，没有可启动的宿主进程；用 packhub 直接在这个目录里工作。',
  },
  ...HOST_ADAPTERS,
};

export function isInstanceKind(value: string): value is InstanceKind {
  return (INSTANCE_KINDS as readonly string[]).includes(value);
}

/**
 * 装进实例时把资源落到实例自己的 home 段，而不是项目内的 .packhub/。
 * 这样宿主读的是这个实例的 skills，不是全局那一份。`dir` 实例没有 home 段，返回 undefined。
 *
 * 返回值直接作为 kernel `planFor(ctx, { layoutVars })` 的落点覆盖；键必须是 LayoutVars 的键，
 * 名字也只留一份（旧的 targetVars 键 kernel 已不认，传了会被静默忽略）。
 */
export function layoutVarsFor(kind: InstanceKind): Partial<LayoutVars> | undefined {
  const adapter = ADAPTERS[kind];
  if (!adapter.homeDir) return undefined;
  return {
    skillsDir: `${adapter.homeDir}/skills`,
    knowledgeDir: `${adapter.homeDir}/knowledge`,
    promptsDir: `${adapter.homeDir}/prompts`,
  };
}

/**
 * 实例 home 相对实例根的段（统一 /）。home 缺失、就在根上、或落在根外（接管来的外部 home）
 * 时用适配器声明的 homeDir 兜底 —— 它本来就是「相对实例根」的约定。
 */
export function instanceHomeRel(kind: InstanceKind, root: string, home?: string): string | undefined {
  if (home) {
    const rel = relative(root, home).replace(/\\/g, '/').replace(/\/+$/, '');
    if (rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) return rel;
  }
  return ADAPTERS[kind].homeDir;
}

/**
 * 宿主凭据文件在实例根里的相对路径：`<实例 home 段>/<credentialFiles 里的文件名>`。
 * 备份默认排除与 keepData 归档前删除都读这一份，不另立第二份清单。
 * 只按适配器的 home 段匹配：实例根上或别的子目录里的同名文件不在范围里。
 */
export function credentialRels(kind: InstanceKind, root: string, home?: string): string[] {
  const files = ADAPTERS[kind].credentialFiles ?? [];
  const dir = instanceHomeRel(kind, root, home);
  if (!dir) return [];
  return files.map((file) => `${dir}/${file.replace(/\\/g, '/').replace(/^\.?\//, '')}`);
}

/** 从启动输出里取 URL 与端口；取不到就返回 undefined。 */
export function parseStartUrl(text: string, kind: InstanceKind): { url: string; port?: number } | undefined {
  const pattern = ADAPTERS[kind].start?.url;
  if (!pattern) return undefined;
  const hit = text.match(pattern);
  if (!hit?.[1]) return undefined;
  const url = hit[1].replace(/[),.;]+$/, '');
  try {
    const port = Number(new URL(url).port);
    return Number.isFinite(port) && port > 0 ? { url, port } : { url };
  } catch {
    return { url };
  }
}
