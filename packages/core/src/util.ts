import { createHash } from 'node:crypto';

/** 规范化 JSON：递归排序键，供哈希与快照使用。 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return 'sha256-' + createHash('sha256').update(text, 'utf8').digest('base64');
}

/** `${vars.x}` / `${target.y}` / `${resources.<id>.config.<path>}` 插值。
 *  只替换字符串里的占位符；找不到的键保持原样并记录到 missing 中。 */
export function interpolate(
  value: unknown,
  scope: Record<string, unknown>,
  missing: string[] = [],
): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (whole, expr: string) => {
      const resolved = lookup(scope, expr.trim());
      if (resolved === undefined) {
        missing.push(expr.trim());
        return whole;
      }
      return String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, scope, missing));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolate(v, scope, missing);
    }
    return out;
  }
  return value;
}

function lookup(scope: Record<string, unknown>, expr: string): unknown {
  let cur: unknown = scope;
  for (const part of expr.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** JSON merge（深合并，数组整体替换），用于 merge.config 的 json-merge 策略。 */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
