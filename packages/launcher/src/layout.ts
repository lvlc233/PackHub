import { isAbsolute, join, relative } from 'node:path';
import {
  harness,
  harnesses,
  harnessIds,
  isHarnessId,
  type DestinationContext,
  type HarnessId,
  type HarnessSpec,
  type LaunchMode,
} from '@packhub/kernel';
import { PalError } from './errors.ts';

/**
 * 实例形态：`dir` 是普通项目目录实例（不是宿主），其余是宿主名。
 *
 * 这些是 PAL 自己的概念：kernel 侧 plan/verify 的宿主参数与 PAL 的 `--host` 都只有宿主名，PAL 建实例时把 `dir`
 * 映射成「不传 harness（平铺目录）」。宿主名单是运行期注册表（kernel 的 harnessIds()），
 * 加宿主只在 kernel 加模块，launcher 不改。
 */
export type InstanceKind = 'dir' | HarnessId;

/** 当前能建的实例形态：dir + 注册表里的宿主（每次现查，不在模块加载时冻结）。 */
export function instanceKinds(): InstanceKind[] {
  return ['dir', ...harnessIds()];
}

export function isInstanceKind(value: string): value is InstanceKind {
  return value === 'dir' || isHarnessId(value);
}

/** 每个宿主在实例根里怎么放 home 段、用哪个环境变量指过去、能怎么起。 */
export interface HarnessAdapter {
  label: string;
  /** 实例内的 home 目录（相对实例根）；dir 没有 */
  homeDir?: string;
  /** 把宿主指到这个 home 的环境变量 */
  homeEnv?: string;
  /** 宿主可执行文件名（模式的 `command` 缺省用它） */
  executable?: string;
  /** 探测版本用的参数 */
  versionArgs?: string[];
  /**
   * 宿主自己的凭据文件（相对 homeDir 的文件名，可含子路径）。
   * 只用于备份/归档时剥离，**不是安装落点**：PAL 不往这些位置写东西，也不在这列表里找什么。
   */
  credentialFiles?: string[];
  /** 启动方式表；空表 = 这个宿主不能由 PAL 起 */
  modes: LaunchMode[];
  /** 默认启动模式 id（缺省 `modes[0]`） */
  defaultMode?: string;
  /** 不能启动时给用户看的原因（不是错误码，是能力说明） */
  noStartReason?: string;
}

/** dir 实例不是宿主：没有 home、没有启动模式，只有一句能力说明。 */
const DIR_ADAPTER: HarnessAdapter = {
  label: '普通项目',
  modes: [],
  noStartReason: 'dir 实例是一个项目目录，没有可启动的宿主进程；用 packhub 直接在这个目录里工作。',
};

/** 由注册表里的宿主描述派生适配器：PAL 只把它拍平成 homeDir / modes 这类字段。 */
function adapterFromSpec(spec: HarnessSpec): HarnessAdapter {
  return {
    label: spec.label,
    ...(spec.home ? { homeDir: spec.home.dir, homeEnv: spec.home.env } : {}),
    ...(spec.executable ? { executable: spec.executable } : {}),
    ...(spec.versionArgs ? { versionArgs: [...spec.versionArgs] } : {}),
    ...(spec.credentialFiles ? { credentialFiles: [...spec.credentialFiles] } : {}),
    modes: [...spec.modes],
    ...(spec.defaultMode ? { defaultMode: spec.defaultMode } : {}),
  };
}

/** 查一个实例形态的适配器；未注册/未知返回 undefined（调用方决定报错方式）。 */
export function adapterFor(kind: InstanceKind): HarnessAdapter | undefined {
  if (kind === 'dir') return DIR_ADAPTER;
  const spec = harness(kind);
  return spec ? adapterFromSpec(spec) : undefined;
}

/** 查一个实例形态的适配器；没有就抛错（PAL 只在已校验的形态上调用它）。 */
export function requireAdapter(kind: InstanceKind): HarnessAdapter {
  const adapter = adapterFor(kind);
  if (!adapter) throw new Error(`未知实例形态：${kind}（可选 ${instanceKinds().join(' / ')}）`);
  return adapter;
}

/**
 * 一次安装的落点上下文：PAL 只回答「装到哪个范围」，落点本身由宿主模块的 `destination` 回答
 * （kernel 出计划时问它）。`dir` 实例不是宿主，返回 undefined。
 *
 * - 项目：root = 项目目录，没有 home 段；
 * - managed：root = 实例根，home = `<root>/<home.dir>`（资源落进实例自己的 home 段，
 *   宿主读的是这个实例的那一份，不是全局的）；
 * - attached：root 就是宿主的全局目录，home 与 root 同值，落点相对它；`profile` 只在这里传下去
 *   （dsh 的 per-profile MCP 落点；managed / 项目没有 profile 语义）。
 */
export function destinationContext(
  kind: InstanceKind,
  opts: { root?: string; attachedHome?: string; profile?: string } = {},
): DestinationContext | undefined {
  if (kind === 'dir') return undefined;
  const spec = harness(kind);
  if (!spec) return undefined;
  if (opts.attachedHome !== undefined) {
    return {
      root: opts.attachedHome,
      home: opts.attachedHome,
      scope: 'attached',
      ...(opts.profile ? { profile: opts.profile } : {}),
    };
  }
  const root = opts.root ?? '.';
  return {
    root,
    // 计划里的路径统一用 /（安装根之外的调用方也不该看到平台分隔符）
    ...(spec.home ? { home: join(root, spec.home.dir).replaceAll('\\', '/') } : {}),
    scope: 'home',
  };
}

/** 宿主有没有已验证的全局落点（attached home）。dir 不是宿主，永远没有。 */
export function supportsAttached(kind: InstanceKind): boolean {
  return kind !== 'dir' && harness(kind)?.attached === true;
}

/**
 * attached home 只对已验证全局落点的宿主开放：写错地方比拒绝更贵。
 * 统一在这里报用法错（退出 2），命令层与 create 都从这一条走。
 */
export function assertAttachedSupported(kind: InstanceKind): void {
  if (supportsAttached(kind)) return;
  // 支持名单从注册表现查：加宿主只改 kernel 模块，这里的文案不用再抄一份
  const supported = harnesses()
    .filter((spec) => spec.attached === true)
    .map((spec) => spec.id)
    .join(' / ');
  throw new PalError(
    'invalid-input',
    `宿主 ${kind} 暂不支持 attached home（全局落点未验证）；已支持 ${supported}；用默认命名 home 或 --project`,
  );
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
  return adapterFor(kind)?.homeDir;
}

/**
 * 宿主凭据文件在实例根里的相对路径：`<实例 home 段>/<credentialFiles 里的文件名>`。
 * 备份默认排除与 keepData 归档前删除都读这一份，不另立第二份清单。
 * 只按适配器的 home 段匹配：实例根上或别的子目录里的同名文件不在范围里。
 */
export function credentialRels(kind: InstanceKind, root: string, home?: string): string[] {
  const files = adapterFor(kind)?.credentialFiles ?? [];
  const dir = instanceHomeRel(kind, root, home);
  if (!dir) return [];
  return files.map((file) => `${dir}/${file.replace(/\\/g, '/').replace(/^\.?\//, '')}`);
}

/**
 * 从启动输出里取 URL 与端口；取不到就返回 undefined。
 *
 * `modeId` 指定用哪条模式的地址正则；不写 = 该宿主第一条 `server` 模式（前台 / app 模式没有 url）。
 */
export function parseStartUrl(
  text: string,
  kind: InstanceKind,
  modeId?: string,
): { url: string; port?: number } | undefined {
  const modes = adapterFor(kind)?.modes ?? [];
  const mode = modeId === undefined ? modes.find((item) => item.kind === 'server') : modes.find((item) => item.id === modeId);
  const pattern = mode?.url;
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

/** 注册表里的全部宿主描述（诊断/帮助用；顺序即注册顺序）。 */
export function registeredHarnesses(): readonly HarnessSpec[] {
  return harnesses();
}
