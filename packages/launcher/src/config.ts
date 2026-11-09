import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PalError } from './errors.ts';
import {
  DEFAULT_ISOLATION,
  ISOLATION_LAYERS,
  parseIsolation,
  type Isolation,
  type IsolationLayer,
  type IsolationMode,
} from './isolation.ts';
import { palConfigFile } from './paths.ts';

/**
 * PAL 的全局配置：目前只有一件事——新实例默认用哪套隔离策略。
 * 默认值的唯一来源仍是 isolation.ts 的 DEFAULT_ISOLATION：文件不存在时照它给。
 * 文件存在但读不了/不合法时直接报错，不静默回落：用户以为改过策略、实际没生效是最坏的坑。
 */

export const CONFIG_VERSION = 1;

export interface PalConfig {
  version: typeof CONFIG_VERSION;
  isolation: Isolation;
}

const LAYER_CHOICES = ISOLATION_LAYERS.join(' / ');
const MODE_CHOICES = 'instance / shared';
const SPEC_HINT = `格式：layer=mode[,layer=mode...]；层：${LAYER_CHOICES}；模式：${MODE_CHOICES}`;

/** 给调用方一份自己的副本：默认值本身是冻结的公共事实，谁也不该拿去就地改。 */
function cloneIsolation(value: Isolation): Isolation {
  return { version: 1, layers: { ...value.layers } };
}

/** 读配置失败：路径与原因都要在 message 里，修法放在 hint 里；不静默回落默认。 */
function configReadError(file: string, reason: string): PalError {
  return new PalError('invalid-input', `配置文件读不了：${file}：${reason}`, {
    hint: '修好它（version 必须是 1，isolation 五层齐全、每层 instance / shared），或删掉这个文件改用内置默认策略',
    details: { file },
  });
}

function assertVersion(value: unknown, file: string): void {
  if (value !== CONFIG_VERSION) {
    throw configReadError(
      file,
      `version 必须是 ${CONFIG_VERSION}，实际是 ${JSON.stringify(value) ?? String(value)}`,
    );
  }
}

function assertIsolation(value: unknown, file: string): Isolation {
  const isolation = parseIsolation(value);
  if (!isolation) {
    throw configReadError(
      file,
      `isolation 不合法：要五层齐全（${LAYER_CHOICES}），每层只能是 ${MODE_CHOICES}`,
    );
  }
  return isolation;
}

/**
 * 读配置：文件不存在就给默认策略的新副本（调用方可以放心改）。
 * JSON 坏、版本不对、isolation 不合法一律抛 invalid-input，message 带路径与原因。
 */
export function readPalConfig(): PalConfig {
  const file = palConfigFile();
  if (!existsSync(file)) return { version: CONFIG_VERSION, isolation: cloneIsolation(DEFAULT_ISOLATION) };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw configReadError(file, `读不了文件（${(err as Error).message}）`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw configReadError(file, `JSON 解析失败（${(err as Error).message}）`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw configReadError(file, '内容不是一个对象');
  }
  const record = data as { version?: unknown; isolation?: unknown };
  assertVersion(record.version, file);
  return { version: CONFIG_VERSION, isolation: assertIsolation(record.isolation, file) };
}

/**
 * 写配置：先校验再原子落盘（临时文件 + rename），写到一半崩掉不会留下半份 JSON。
 * 返回真正落盘的那份（校验过的新副本）。
 */
export function writePalConfig(config: PalConfig): PalConfig {
  const file = palConfigFile();
  if (!config || typeof config !== 'object') {
    throw new PalError('invalid-input', '配置内容不合法：需要一个对象', { hint: SPEC_HINT });
  }
  assertVersion(config.version, file);
  const next: PalConfig = { version: CONFIG_VERSION, isolation: assertIsolation(config.isolation, file) };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 临时文件清不掉不影响结论：真配置没被写坏 */
    }
    throw new PalError('internal', `配置文件写不进去：${file}：${(err as Error).message}`, {
      hint: '看这个路径是否可写、磁盘是否已满',
      details: { file },
      cause: err,
    });
  }
  return next;
}

function specError(reason: string, hint = SPEC_HINT): PalError {
  return new PalError('invalid-input', `隔离策略写法不对：${reason}`, { hint });
}

function isLayer(value: string): value is IsolationLayer {
  return (ISOLATION_LAYERS as string[]).includes(value);
}

/**
 * 解析 `layer=mode,layer=mode`：只覆盖写出来的层，其余沿用 base。
 * 层名/模式不认识、同一层写两次、空项、缺 `=` 都抛 invalid-input，并在 hint 里列出可选值。
 * base 不会被改；返回的是新对象。
 */
export function parseIsolationSpec(text: string, base: Isolation): Isolation {
  const spec = String(text ?? '').trim();
  if (!spec) throw specError('没有内容');
  const layers: Record<IsolationLayer, IsolationMode> = { ...base.layers };
  const seen = new Set<string>();
  for (const raw of spec.split(',')) {
    const item = raw.trim();
    if (!item) throw specError('有空项（多打了逗号？）', `${SPEC_HINT}；例如 cache=shared`);
    const eq = item.indexOf('=');
    if (eq < 0) throw specError(`这一项不是 layer=mode：${item}`, SPEC_HINT);
    const layer = item.slice(0, eq).trim();
    const mode = item.slice(eq + 1).trim();
    if (!layer) throw specError(`这一项缺层名：${item}`, SPEC_HINT);
    if (!isLayer(layer)) {
      throw specError(`没有这一层：${layer}`, `可选层：${LAYER_CHOICES}`);
    }
    if (!mode) throw specError(`这一项缺模式：${item}`, `可选模式：${MODE_CHOICES}`);
    if (mode !== 'instance' && mode !== 'shared') {
      throw specError(`没有这个模式：${mode}`, `可选模式：${MODE_CHOICES}`);
    }
    if (seen.has(layer)) {
      throw specError(`这一层写了两次：${layer}`, '同一层只写一次：后写的不会覆盖前写的');
    }
    seen.add(layer);
    layers[layer] = mode;
  }
  return { version: 1, layers };
}
