import type { TargetId } from '@packhub/kernel';

/** 每个宿主在实例根里怎么放 home 段、用哪个环境变量指过去、能不能直接起。 */
export interface HarnessAdapter {
  /** 实例内的 home 目录（相对实例根）；dir 没有 */
  homeDir?: string;
  /** 把宿主指到这个 home 的环境变量 */
  homeEnv?: string;
  /** 启动命令；没有就说明这一版还不支持直接起 */
  start?: { command: string; args: string[]; url?: RegExp };
}

export const ADAPTERS: Record<TargetId, HarnessAdapter> = {
  dir: {},
  dsh: {
    homeDir: 'home/dsh',
    homeEnv: 'DSH_HOME',
    start: { command: 'dsh', args: ['--profile', 'web', '--no-open', '--port', '0'], url: /(https?:\/\/\S+)/ },
  },
  'claude-code': {
    homeDir: 'home/claude',
    homeEnv: 'CLAUDE_CONFIG_DIR',
  },
  codex: {
    homeDir: 'home/codex',
    homeEnv: 'CODEX_HOME',
  },
};

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

/** 从启动输出里取 URL 与端口；取不到就返回 undefined。 */
export function parseStartUrl(text: string, harness: TargetId): { url: string; port?: number } | undefined {
  const pattern = ADAPTERS[harness].start?.url;
  if (!pattern) return undefined;
  const hit = text.match(pattern);
  if (!hit?.[1]) return undefined;
  const url = hit[1];
  try {
    const port = Number(new URL(url).port);
    return Number.isFinite(port) && port > 0 ? { url, port } : { url };
  } catch {
    return { url };
  }
}
