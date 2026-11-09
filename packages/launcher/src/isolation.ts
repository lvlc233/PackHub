/**
 * 隔离策略：五层各自决定「每实例一份（instance）」还是「全局共享（shared）」。
 * 只做模型与校验；按策略复制/链接哪些目录是 A2/A3 的事，这里不碰启动与装配。
 */

export type IsolationLayer = 'assembly' | 'session' | 'credentials' | 'cache' | 'runtime';

/** shared 表示这一层不随实例复制：所有实例共用宿主那一份。 */
export type IsolationMode = 'instance' | 'shared';

export interface Isolation {
  version: 1;
  layers: Record<IsolationLayer, IsolationMode>;
}

/** 五层的固定顺序：解析、界面与日志都按它遍历，保证同一份策略的输出一致。 */
export const ISOLATION_LAYERS: readonly IsolationLayer[] = [
  'assembly',
  'session',
  'credentials',
  'cache',
  'runtime',
];

/**
 * 默认策略：装配（含配置）、会话、凭据每实例一份；缓存与运行时全局共享。
 * 冻结：默认值是一份公共事实，谁都不该就地改它，要改必须走记录/配置里的副本。
 */
export const DEFAULT_ISOLATION: Isolation = Object.freeze({
  version: 1,
  layers: Object.freeze({
    assembly: 'instance',
    session: 'instance',
    credentials: 'instance',
    cache: 'shared',
    runtime: 'shared',
  }),
});

function isMode(value: unknown): value is IsolationMode {
  return value === 'instance' || value === 'shared';
}

/**
 * 校验一份隔离策略：version 必须是 1、五层齐全、每层的值只能是 instance / shared。
 * 不合法一律返回 undefined（调用方回落到默认），不抛异常。
 * 合法的返回新副本：不把外面那个对象存进来，也不受它之后的改动影响。
 */
export function parseIsolation(value: unknown): Isolation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as { version?: unknown; layers?: unknown };
  if (data.version !== 1) return undefined;
  const layers = data.layers;
  if (!layers || typeof layers !== 'object') return undefined;
  const next = {} as Record<IsolationLayer, IsolationMode>;
  for (const layer of ISOLATION_LAYERS) {
    const mode = (layers as Record<string, unknown>)[layer];
    if (!isMode(mode)) return undefined;
    next[layer] = mode;
  }
  return { version: 1, layers: next };
}
