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
// 所以要写进 `<home>/profiles/*/cordis.patch.yml` 里已有的每一个（枚举在 destination 里做，
// 计划里只留具体文件；安装后新建的 profile 不会被补上）。

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { destinationsOf } from '../destinations.ts';
import { dshMcpLoaderEntry, DSH_MCP_ENTRY_PREFIX, toServerName } from '../mcp.ts';
import type { Destination, DestinationContext, McpDialect } from './contract.ts';
import { registerHarness } from './contract.ts';

/** web 子命令的 profile：启动模板与 startProfile 字段共用一份。 */
const DSH_WEB_PROFILE = 'web';

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
  instruction: 'AGENTS.md',
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
function profilePatches(home: string): string[] {
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
 * attached 的 MCP 落点：所有已有 profile 的 patch 文件（排序后第一个当主文件）。
 *
 * 一个 profile 都没有时退回 `profiles/web/cordis.patch.yml`，让安装把它建出来——
 * `dsh web` 本来就找这个 profile，装完能直接用。没有 home 段（调用方用错了范围）时
 * 给相对 home 的路径，让计划期的 base 校验报 `bad-destination-base`。
 */
function attachedMcp(ctx: DestinationContext): Destination {
  const files = ctx.home ? profilePatches(ctx.home) : [];
  const paths = files.length > 0 ? files : [`${PROFILES_DIR}/${DSH_WEB_PROFILE}/${PROFILE_PATCH}`];
  return {
    path: paths[0]!,
    base: 'home',
    // 只有一个文件时不写 paths：动作与 state 保持单文件形状（旧计划逐字节不变）
    ...(paths.length > 1 ? { paths: paths.map((path) => ({ path, base: 'home' as const })) } : {}),
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
  startProfile: DSH_WEB_PROFILE,
  start: {
    command: 'dsh',
    // --profile 与 --patch 必须在子命令之前：之后会被当成 web app 自己的参数
    args: (ctx) => [
      '--profile',
      DSH_WEB_PROFILE,
      ...(ctx.patchFile ? ['--patch', ctx.patchFile] : []),
      '--no-open',
      '--port',
      String(ctx.port),
    ],
    url: /(https?:\/\/\S+)/,
    readyTimeoutMs: 30_000,
  },
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
