// env.ts	PACKHUB_* 环境变量名的唯一来源
//
// 只收口「名字」：读取、默认值、校验都留在各自消费方，这里不做任何 process.env 访问。

/**
 * 所有 PACKHUB_* 环境变量名。改名字只改这张表。
 * 键名说用途，值就是变量名本身。
 */
export const PACKHUB_ENV = {
  /** 数据目录根；不给时各消费方回落到 ~/.packhub 之类的默认 */
  home: 'PACKHUB_HOME',
  /** registry 索引（本地路径或 URL） */
  index: 'PACKHUB_INDEX',
  /** PAL 实例根 */
  instances: 'PACKHUB_INSTANCES',
  /** location.json 的覆盖位置，只给测试/多环境用 */
  locationFile: 'PACKHUB_LOCATION_FILE',
  /** hub 的静态鉴权 token */
  hubToken: 'PACKHUB_HUB_TOKEN',
  /** 资源目录文件或 URL */
  catalog: 'PACKHUB_CATALOG',
  /** harness 探针超时（毫秒） */
  probeTimeout: 'PACKHUB_PROBE_TIMEOUT',
  /** 全局同步：dsh 的 home */
  dshHome: 'PACKHUB_DSH_HOME',
  /** 全局同步：Claude Code 的 home */
  claudeHome: 'PACKHUB_CLAUDE_HOME',
  /** 全局同步：Codex 的 home */
  codexHome: 'PACKHUB_CODEX_HOME',
  /** claude 可执行文件 */
  claudeBin: 'PACKHUB_CLAUDE_BIN',
  /** bench 每次的耗时预算（毫秒） */
  benchBudgetMs: 'PACKHUB_BENCH_BUDGET_MS',
  /** registry 全量重锁用的私钥路径 */
  relockKey: 'PACKHUB_RELOCK_KEY',
} as const;
