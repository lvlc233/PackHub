import { isAbsolute, relative } from 'node:path';
import {
  harness,
  harnesses,
  harnessIds,
  isHarnessId,
  type HarnessId,
  type HarnessSpec,
  type LayoutVars,
  type StartTemplate,
} from '@packhub/kernel';
import { PalError } from './errors.ts';

/**
 * 实例形态：`dir` 是普通项目目录实例（不是宿主），其余是宿主名。
 *
 * 这些是 PAL 自己的概念：kernel 的 `--harness` / PAL 的 `--host` 只有宿主名，PAL 建实例时把 `dir`
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

/** dir 实例不是宿主：没有 home、没有启动模板，只有一句能力说明。 */
const DIR_ADAPTER: HarnessAdapter = {
  label: '普通项目',
  noStartReason: 'dir 实例是一个项目目录，没有可启动的宿主进程；用 packhub 直接在这个目录里工作。',
};

/** 由注册表里的宿主描述派生适配器：PAL 只把它拍平成 homeDir / homeEnv 这类字段。 */
function adapterFromSpec(spec: HarnessSpec): HarnessAdapter {
  return {
    label: spec.label,
    ...(spec.home ? { homeDir: spec.home.dir, homeEnv: spec.home.env } : {}),
    ...(spec.startProfile ? { startProfile: spec.startProfile } : {}),
    ...(spec.executable ? { executable: spec.executable } : {}),
    ...(spec.versionArgs ? { versionArgs: [...spec.versionArgs] } : {}),
    ...(spec.credentialFiles ? { credentialFiles: [...spec.credentialFiles] } : {}),
    ...(spec.start ? { start: spec.start } : {}),
    ...(spec.noStartReason ? { noStartReason: spec.noStartReason } : {}),
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
 * 装进实例时把资源落到实例自己的 home 段，而不是项目内的 .packhub/。
 * 这样宿主读的是这个实例的 skills，不是全局那一份。`dir` 实例没有 home 段，返回 undefined。
 *
 * 默认 skills/knowledge/prompts 落在 `<home>/…`；宿主可以用 spec.instanceLayout 改
 * （例如 opencode 的 XDG 目录多一层 `opencode/`、hermes 的 MCP 配置是 home 里的 config.yaml）。
 * 返回值直接作为 kernel `planFor(ctx, { layoutVars })` 的落点覆盖；键必须是 LayoutVars 的键。
 *
 * 传 `attachedHome` 时改用宿主的 attached 落点（装进真实的全局目录）：值的基准是那个 home，
 * 与 managed 的 `home/<宿主>` 基准不同。
 */
export function layoutVarsFor(
  kind: InstanceKind,
  attachedHome?: string,
): Partial<LayoutVars> | undefined {
  const spec = kind === 'dir' ? undefined : harness(kind);
  if (!spec?.home) return undefined;
  if (attachedHome !== undefined) return spec.attachedLayout?.(attachedHome);
  const home = spec.home.dir;
  return {
    skillsDir: `${home}/skills`,
    knowledgeDir: `${home}/knowledge`,
    promptsDir: `${home}/prompts`,
    ...(spec.instanceLayout ? spec.instanceLayout(home) : {}),
  };
}

/** 宿主有没有已验证的全局布局（attached home）。dir 不是宿主，永远没有。 */
export function supportsAttached(kind: InstanceKind): boolean {
  return kind !== 'dir' && harness(kind)?.attachedLayout !== undefined;
}

/**
 * attached home 只对已验证全局布局的宿主开放：写错地方比拒绝更贵。
 * 统一在这里报用法错（退出 2），命令层与 create 都从这一条走。
 */
export function assertAttachedSupported(kind: InstanceKind): void {
  if (supportsAttached(kind)) return;
  throw new PalError(
    'invalid-input',
    `宿主 ${kind} 暂不支持 attached home（全局布局未验证）；用默认命名 home 或 --project`,
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

/** 从启动输出里取 URL 与端口；取不到就返回 undefined。 */
export function parseStartUrl(text: string, kind: InstanceKind): { url: string; port?: number } | undefined {
  const pattern = adapterFor(kind)?.start?.url;
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
