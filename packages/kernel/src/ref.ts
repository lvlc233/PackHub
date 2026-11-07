// 做资源来源解析

import type { Issue } from './types.ts';

export type SourceKind = 'npm' | 'pypi' | 'github' | 'http' | 'packhub' | 'local';

export interface ParsedSource {
  kind: SourceKind;
  raw: string;
  /** 不含 pin 的规范定位符，例如 `npm:@scope/pkg`、`github:owner/repo` */
  locator: string;
  /** 不可变 pin：版本号 / commit / tag / 范围（packhub 用） */
  pin?: string;
  /** github 的子路径，例如 `skills/code-review` */
  subpath?: string;
}

/** 这些 pin 不算「锁住」：解析时会漂移。 */
const VOLATILE = new Set(['latest', 'main', 'master', 'HEAD', '*', '']);
/** 版本范围同样会漂：今天解析到 1.4.0，明天可能是 1.5.0。 */
const RANGE = /[\^~<>]|\|\||\s|\bx\b/i;

export function parseSource(raw: string): ParsedSource {
  if (raw.startsWith('./') || raw.startsWith('../')) {
    return { kind: 'local', raw, locator: raw };
  }
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return { kind: 'http', raw, locator: raw };
  }
  if (raw.startsWith('npm:')) {
    const [name, pin] = splitPin(raw.slice(4));
    return { kind: 'npm', raw, locator: `npm:${name}`, pin };
  }
  if (raw.startsWith('pypi:')) {
    const [name, pin] = splitPin(raw.slice(5));
    return { kind: 'pypi', raw, locator: `pypi:${name}`, pin };
  }
  if (raw.startsWith('packhub://')) {
    const [name, pin] = splitPin(raw.slice('packhub://'.length));
    return { kind: 'packhub', raw, locator: `packhub:${name}`, pin };
  }
  if (raw.startsWith('github:')) {
    const [target, pin] = splitPin(raw.slice('github:'.length));
    const [owner, repo, ...rest] = target.split('/');
    const subpath = rest.length ? rest.join('/') : undefined;
    return {
      kind: 'github',
      raw,
      locator: `github:${owner}/${repo}`,
      pin,
      ...(subpath ? { subpath } : {}),
    };
  }
  throw new Error(
    `无法识别的 source：${raw}（支持的形态：npm: pypi: github: packhub:// https:// ./）`,
  );
}

/** 在最后一个 `@` 处切分；scoped 包名开头的 `@` 不算。 */
function splitPin(body: string): [string, string | undefined] {
  const i = body.lastIndexOf('@');
  if (i <= 0) return [body, undefined];
  return [body.slice(0, i), body.slice(i + 1)];
}

export function isVolatilePin(pin: string | undefined): boolean {
  if (pin === undefined) return true;
  if (VOLATILE.has(pin)) return true;
  return RANGE.test(pin);
}

/** 检查一个 source 是否足以复现：发布版要求可锁、https 要求 integrity。 */
export function checkSource(
  parsed: ParsedSource,
  integrity: string | undefined,
  path: string,
): Issue[] {
  const issues: Issue[] = [];
  if (parsed.kind === 'http') {
    if (!integrity) {
      issues.push({
        code: 'http-missing-integrity',
        severity: 'error',
        message: `https 资源必须带 integrity（${parsed.locator}）`,
        path,
      });
    }
    return issues;
  }
  if (parsed.kind === 'local') return issues;
  if (isVolatilePin(parsed.pin)) {
    issues.push({
      code: 'unpinned-source',
      severity: 'error',
      message: `source 未锁定到不可变 pin：${parsed.raw}（发布版必须写成 @<版本|commit>）`,
      path,
    });
  }
  return issues;
}
