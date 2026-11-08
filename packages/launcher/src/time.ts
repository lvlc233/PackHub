/**
 * 时间戳：全仓统一用 ISO 8601（UTC）。
 * 单独成一个模块，是为了让 lock.ts / baseline.ts 取时间时不必反过来 import index.ts（避免循环）。
 */
export function nowIso(): string {
  return new Date().toISOString();
}
