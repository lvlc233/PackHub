import { isAbsolute, relative } from 'node:path';
import type { TargetId } from '@packhub/kernel';

/** 启动时能拿到的上下文，交给适配器拼参数。 */
export interface StartContext {
  /** 本次分配的端口；宿主必须监听它 */
  port: number;
  /** 实例根 */
  root: string;
  /** 实例自己的 home 段（宿主没有则为 undefined） */
  home?: string;
  /** dsh 这类宿主的额外补丁文件（MCP 接线用） */
  patchFile?: string;
}

export interface StartTemplate {
  /** 可执行文件名（走 PATH 发现，或 PAL_<HARNESS>_BIN 覆盖） */
  command: string;
  /** 由上下文拼参数；不经过 shell */
  args: (ctx: StartContext) => string[];
  /** 从启动输出里认地址 */
  url: RegExp;
  /** 等地址的默认超时 */
  readyTimeoutMs?: number;
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

/**
 * 拼 dsh 的启动参数。profile 由适配器的 startProfile 决定，不写死在闭包里；
 * --patch 必须在子命令之前：之后会被当成 web app 自己的参数。
 */
export function dshStartArgs(
  ctx: StartContext,
  adapter: Pick<HarnessAdapter, 'startProfile'>,
): string[] {
  return [
    ...(adapter.startProfile ? ['--profile', adapter.startProfile] : []),
    ...(ctx.patchFile ? ['--patch', ctx.patchFile] : []),
    '--no-open',
    '--port',
    String(ctx.port),
  ];
}

// start.args 要读适配器自己的 startProfile，所以模板挂在具名常量上（闭包自引用）。
const dshAdapter: HarnessAdapter = {
  label: 'DeepSeek Harness',
  homeDir: 'home/dsh',
  homeEnv: 'DSH_HOME',
  startProfile: 'web',
  executable: 'dsh',
  versionArgs: ['--version'],
  credentialFiles: ['.credentials.yaml', 'auth.json'],
  start: {
    command: 'dsh',
    args: (ctx) => dshStartArgs(ctx, dshAdapter),
    url: /(https?:\/\/\S+)/,
    readyTimeoutMs: 30_000,
  },
};

export const ADAPTERS: Record<TargetId, HarnessAdapter> = {
  dir: {
    label: '普通项目',
    noStartReason: 'dir 实例是一个项目目录，没有可启动的宿主进程；用 packhub 直接在这个目录里工作。',
  },
  dsh: dshAdapter,
  'claude-code': {
    label: 'Claude Code',
    homeDir: 'home/claude',
    homeEnv: 'CLAUDE_CONFIG_DIR',
    executable: 'claude',
    versionArgs: ['--version'],
    credentialFiles: ['auth.json', '.credentials.json'],
  },
  codex: {
    label: 'Codex',
    homeDir: 'home/codex',
    homeEnv: 'CODEX_HOME',
    executable: 'codex',
    versionArgs: ['--version'],
    credentialFiles: ['auth.json'],
  },
};

export const HARNESS_IDS = Object.keys(ADAPTERS) as TargetId[];

export function isHarnessId(value: string): value is TargetId {
  return (HARNESS_IDS as string[]).includes(value);
}

/**
 * 装进实例时把资源落到实例自己的 home 段，而不是项目内的 .packhub/。
 * 这样宿主读的是这个实例的 skills，不是全局那一份。
 */
export function targetVarsFor(harness: TargetId): Record<string, string> | undefined {
  const adapter = ADAPTERS[harness];
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
export function instanceHomeRel(harness: TargetId, root: string, home?: string): string | undefined {
  if (home) {
    const rel = relative(root, home).replace(/\\/g, '/').replace(/\/+$/, '');
    if (rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) return rel;
  }
  return ADAPTERS[harness].homeDir;
}

/**
 * 宿主凭据文件在实例根里的相对路径：`<实例 home 段>/<credentialFiles 里的文件名>`。
 * 备份默认排除与 keepData 归档前删除都读这一份，不另立第二份清单。
 * 只按适配器的 home 段匹配：实例根上或别的子目录里的同名文件不在范围里。
 */
export function credentialRels(harness: TargetId, root: string, home?: string): string[] {
  const files = ADAPTERS[harness].credentialFiles ?? [];
  const dir = instanceHomeRel(harness, root, home);
  if (!dir) return [];
  return files.map((file) => `${dir}/${file.replace(/\\/g, '/').replace(/^\.?\//, '')}`);
}

/** 从启动输出里取 URL 与端口；取不到就返回 undefined。 */
export function parseStartUrl(text: string, harness: TargetId): { url: string; port?: number } | undefined {
  const pattern = ADAPTERS[harness].start?.url;
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
