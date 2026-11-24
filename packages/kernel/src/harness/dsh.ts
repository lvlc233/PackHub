// dsh（DeepSeek Harness）的宿主描述与探针配方。
//
// dsh 的 headless 探针固定用 `--profile headless --json`，输出是逐行 JSON；命令行预览与真实 argv
// 都从这里的常量取，免得同一个值在两处各写一份。
//
// 落点：项目里只写指令块（技能与 MCP 挂在全局 profile，见 project: 'pointer'）；managed 范围
// 把技能与知识落进实例自己的 home 段，MCP 仍是 `.packhub` 里的登记文件（启动时由 PAL 生成
// `--patch` 层，见 launcher/src/mcp.ts）。
//
// attached（宿主真实的 `~/.dsh`）：技能 / 知识 / 提示词 / 指令都相对 home；MCP 是 per-profile 的，
// 落点在这里枚举（计划里只留具体文件）：
// - 不带 `--profile`：写进所有已有 profile 的 `cordis.patch.yml`；一个 profile 都没有就报
//   `no-profiles`（不替宿主造 `profiles/web`——dsh 自己启动时才会生成 profile）；
// - 带 `--profile`：只写那一个，文件不存在报 `profile-missing`，不创建。
// 安装后新建的 profile 不会被自动补上；`pal health` 用 `dshProfilePatches` 枚举当前全部 profile
// 报出缺条目，`pal update`（all 记录的）重装即可补。

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { destinationsOf } from '../destinations.ts';
import { ISSUE_CODES } from '../issueCodes.ts';
import { dshMcpLoaderEntry, DSH_MCP_ENTRY_PREFIX, toServerName } from '../mcp.ts';
import type { Destination, DestinationContext, McpDialect, StartContext } from './contract.ts';
import { registerHarness } from './contract.ts';

/** web 模式的默认 profile；没有 home 段时的落点兜底路径也用它。 */
const DSH_WEB_PROFILE = 'web';

/** app 可执行文件名；候选路径按它拼。 */
const DSH_APP_NAME = 'DeepSeek Harness.exe';
/** 指定 app 可执行文件的环境变量；设了就不用猜安装位置。 */
const DSH_APP_ENV = 'PAL_DSH_APP_BIN';

/**
 * 记录 / 安装参数里表示「全部已有 profile」的保留值（`pal install` 不带 `--profile` 就是它）。
 * 它不是 dsh 认识的可启动 profile：一次启动只跑一个，落到默认 web。
 */
const PROFILE_ALL = 'all';

/** headless 探针用的 profile（一次性问答，不进 web 壳）。 */
const DSH_PROBE_PROFILE = 'headless';
const DSH_PROFILE_FLAG = '--profile';
const DSH_PATCH_FLAG = '--patch';
const DSH_JSON_FLAG = '--json';

/** 实例里的 home 段（相对实例根）；`home.dir` 与落点共用这一份。 */
const HOME_DIR = 'home/dsh';

/** profile 段与每个 profile 的 patch 文件名；attached 的 MCP 落点按它们枚举。 */
const PROFILES_DIR = 'profiles';
const PROFILE_PATCH = 'cordis.patch.yml';

/** 项目：只有指令面是 dsh 认的位置，其余都落在 `.packhub`。 */
const PROJECT = destinationsOf({ instruction: 'AGENTS.md' });

/** managed：技能 / 知识 / 提示词进实例 home；MCP 仍登记在 `.packhub`。 */
const HOME = destinationsOf({
  skill: `${HOME_DIR}/skills`,
  knowledge: `${HOME_DIR}/knowledge`,
  prompt: `${HOME_DIR}/prompts`,
  instruction: `${HOME_DIR}/AGENTS.md`,
});

/** attached：root 与 home 同值，技能 / 知识 / 提示词 / 指令都相对 home；MCP 另算（按 profile）。 */
const ATTACHED = destinationsOf({
  skill: { path: 'skills', base: 'home' },
  knowledge: { path: 'knowledge', base: 'home' },
  prompt: { path: 'prompts', base: 'home' },
  instruction: { path: 'AGENTS.md', base: 'home' },
});

/**
 * dsh 的 MCP 方言：profile patch 是 YAML 数组，条目放在某一条的 `insert` 列表里，
 * 每条 loader 有自己的 `id`。我们只认领 `pal-mcp-*`，用户自己的条目一律不动。
 */
const MCP: McpDialect = {
  format: 'yaml',
  list: { field: 'insert', ownerPrefix: DSH_MCP_ENTRY_PREFIX },
  entry: (spec, ctx) => dshMcpLoaderEntry(spec, ctx.serverName ?? toServerName(ctx.resource)),
};

/** `<home>/profiles/<profile>/cordis.patch.yml` 里存在的文件（相对 home 的 posix 路径，字典序）。 */
export function dshProfilePatches(home: string): string[] {
  const dir = join(home, PROFILES_DIR);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, PROFILE_PATCH);
    if (existsSync(file) && statSync(file).isFile()) out.push(`${PROFILES_DIR}/${entry.name}/${PROFILE_PATCH}`);
  }
  return out.sort();
}

/**
 * profile 名只能是一段目录名：拼进落点路径的是用户输入，路径分隔符和 `..` 一律拒绝。
 * dsh 的 profile 名是它自己定的（web / desktop / headless 这类），这里只做安全边界。
 */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `<profiles>/<profile>/cordis.patch.yml`（相对 home）；名字不合法时 undefined。 */
function profilePatch(profile: string): string | undefined {
  return PROFILE_NAME.test(profile) ? `${PROFILES_DIR}/${profile}/${PROFILE_PATCH}` : undefined;
}

/**
 * attached 的 MCP 落点。
 *
 * - 显式 `profile`：只给那一个 patch 文件；不存在就报 `profile-missing`（不创建——profile 由
 *   dsh 自己启动时生成），名字不合法报 `bad-profile`。
 * - 不写：枚举所有已有 profile 的 patch 文件（字典序第一个当主文件）；一个都没有就报
 *   `no-profiles`，不回退 `profiles/web`。
 *
 * 没有 home 段（调用方用错了范围）时给相对 home 的路径，让计划期的 base 校验报
 * `bad-destination-base`。
 */
function attachedMcp(ctx: DestinationContext): Destination {
  if (ctx.profile !== undefined) {
    const rel = profilePatch(ctx.profile);
    if (!rel) {
      return {
        path: '',
        base: 'home',
        mcp: MCP,
        issues: [
          {
            code: ISSUE_CODES.badProfile,
            severity: 'error',
            message: `profile 名不合法：${ctx.profile}（只能是一段目录名：字母、数字、. _ -，不能带路径分隔符或 ..）`,
          },
        ],
      };
    }
    if (!ctx.home) return { path: rel, base: 'home', mcp: MCP };
    if (!existsSync(join(ctx.home, rel))) {
      return {
        path: rel,
        base: 'home',
        mcp: MCP,
        issues: [
          {
            code: ISSUE_CODES.profileMissing,
            severity: 'error',
            message:
              `profile「${ctx.profile}」不存在：${join(ctx.home, rel)}；` +
              `先启动一次 dsh 生成 profile（dsh --profile ${ctx.profile}），或换一个已存在的 --profile`,
          },
        ],
      };
    }
    // 只有一个文件：动作与 state 保持单文件形状（不写 paths）
    return { path: rel, base: 'home', mcp: MCP };
  }

  if (!ctx.home) {
    return { path: `${PROFILES_DIR}/${DSH_WEB_PROFILE}/${PROFILE_PATCH}`, base: 'home', mcp: MCP };
  }
  const files = dshProfilePatches(ctx.home);
  if (files.length === 0) {
    return {
      path: '',
      base: 'home',
      mcp: MCP,
      issues: [
        {
          code: ISSUE_CODES.noProfiles,
          severity: 'error',
          message:
            `${join(ctx.home, PROFILES_DIR)} 下没有任何 profile（profiles/*/cordis.patch.yml）；` +
            '先启动一次 dsh 生成 profile，或显式 --profile <名字>',
        },
      ],
    };
  }
  return {
    path: files[0]!,
    base: 'home',
    // 只有一个文件时不写 paths：动作与 state 保持单文件形状（旧计划逐字节不变）
    ...(files.length > 1 ? { paths: files.map((path) => ({ path, base: 'home' as const })) } : {}),
    mcp: MCP,
  };
}

/** dsh 的 headless 输出是逐行 JSON：取最后一条 `{type:"final",text}`；没有就按普通文本 trim。 */
function parseDshFinal(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!) as { type?: string; text?: string };
      if (event.type === 'final' && typeof event.text === 'string') return event.text;
    } catch {
      /* 非 JSON 行，跳过 */
    }
  }
  return stdout.trim();
}

/**
 * 启动参数里的 profile：显式给的（`StartContext.profile`，来自 `pal start --profile` 或记录）
 * 优先；没给、或给的是 `all` 这种「全部」取值时落回默认 web——dsh 一次只跑一个 profile，
 * `all` 是安装范围，不是可启动的东西。
 */
function startProfileOf(ctx: StartContext): string {
  const profile = ctx.profile?.trim();
  return profile && profile !== PROFILE_ALL ? profile : DSH_WEB_PROFILE;
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
 * Windows 常见安装位置，按查找顺序：
 * `%LOCALAPPDATA%\Programs\...` → `%ProgramFiles%\...` → `%ProgramFiles(x86)%\...` → `%LOCALAPPDATA%\...`。
 * 目录变量没设就跳过；重复的路径只留第一次。
 */
function dshAppCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const localAppData = envValue(env, 'LOCALAPPDATA');
  const roots = [
    localAppData ? join(localAppData, 'Programs') : undefined,
    envValue(env, 'ProgramFiles'),
    envValue(env, 'ProgramFiles(x86)'),
    localAppData,
  ];
  const out: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    const candidate = join(root, 'DeepSeek Harness', DSH_APP_NAME);
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

registerHarness({
  id: 'dsh',
  label: 'DeepSeek Harness',
  // 项目里只写指路块（AGENTS.md），技能不注册进项目；要注册技能得建环境
  project: 'pointer',
  destination: (kind, ctx) => {
    if (ctx.scope === 'attached') return kind === 'mcp' ? attachedMcp(ctx) : ATTACHED(kind);
    return ctx.scope === 'project' ? PROJECT(kind) : HOME(kind);
  },
  home: { dir: HOME_DIR, env: 'DSH_HOME' },
  // attached home 的全局落点已验证（`pal install --home ~/.dsh` 才允许指过来）
  attached: true,
  executable: 'dsh',
  versionArgs: ['--version'],
  credentialFiles: ['.credentials.yaml', 'auth.json'],
  modes: [
    {
      id: 'web',
      label: '网页（web profile）',
      kind: 'server',
      command: 'dsh',
      usesProfile: true,
      // --profile 与 --patch 必须在子命令之前：之后会被当成 web app 自己的参数
      args: (ctx) => [
        DSH_PROFILE_FLAG,
        startProfileOf(ctx),
        ...(ctx.patchFile ? [DSH_PATCH_FLAG, ctx.patchFile] : []),
        '--no-open',
        '--port',
        String(ctx.port),
      ],
      url: /(https?:\/\/\S+)/,
      readyTimeoutMs: 30_000,
    },
    {
      id: 'app',
      label: '桌面窗口（Electron app）',
      kind: 'app',
      // app 自己管 desktop profile，也认不了 --patch：只 spawn 窗口，不接 MCP 层
      available: (ctx) =>
        ctx.attached
          ? true
          : '只支持 attached dsh；managed 的 app 启动要先确认它能用 DSH_HOME 指到实例（目前用 --home 的 attached dsh，或先 pal start 起 web）',
      app: {
        env: DSH_APP_ENV,
        // home 未用：dsh 的 app 不在实例 home 里，按 Windows 常见安装位置找
        candidates: () => dshAppCandidates(),
      },
    },
  ],
  defaultMode: 'web',
  probe: {
    executable: 'dsh',
    args: (ctx) => [
      DSH_PROFILE_FLAG,
      DSH_PROBE_PROFILE,
      ...(ctx.patchFile ? [DSH_PATCH_FLAG, ctx.patchFile] : []),
      DSH_JSON_FLAG,
      ctx.prompt,
    ],
    preview: (ctx) =>
      `dsh ${DSH_PROFILE_FLAG} ${DSH_PROBE_PROFILE}${ctx.patchFile ? ` ${DSH_PATCH_FLAG} ${ctx.patchFile}` : ''} ${DSH_JSON_FLAG} "<prompt>"`,
    answer: parseDshFinal,
    hints: [
      {
        test: /MISSING_CREDENTIAL|no API key/i,
        reason: '缺少凭证：headless 需要环境变量 DEEPSEEK_API_KEY（桌面应用里存的那份读不到）',
      },
    ],
  },
});
