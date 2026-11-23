// dsh（DeepSeek Harness）的宿主描述与探针配方。
//
// dsh 的 headless 探针固定用 `--profile headless --json`，输出是逐行 JSON；命令行预览与真实 argv
// 都从这里的常量取，免得同一个值在两处各写一份。
//
// 落点：项目里只写指令块（技能与 MCP 挂在全局 profile，见 project: 'pointer'）；managed 范围
// 把技能与知识落进实例自己的 home 段，MCP 仍是 `.packhub` 里的登记文件。

import { destinationsOf } from '../destinations.ts';
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

/** 项目：只有指令面是 dsh 认的位置，其余都落在 `.packhub`。 */
const PROJECT = destinationsOf({ instruction: 'AGENTS.md' });

/** managed：技能 / 知识 / 提示词进实例 home；MCP 仍登记在 `.packhub`。 */
const HOME = destinationsOf({
  skill: `${HOME_DIR}/skills`,
  knowledge: `${HOME_DIR}/knowledge`,
  prompt: `${HOME_DIR}/prompts`,
  instruction: 'AGENTS.md',
});

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
  // DSH 的 skills 与 MCP 目前挂在 profile（全局）；项目落点只有指令块
  destination: (kind, ctx) => {
    if (ctx.scope === 'attached') {
      throw new Error('宿主 dsh 没有 attached 落点：launcher 应在写盘前拒绝');
    }
    return ctx.scope === 'project' ? PROJECT(kind) : HOME(kind);
  },
  home: { dir: HOME_DIR, env: 'DSH_HOME' },
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
