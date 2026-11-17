// 做资源来源解析

import type { Issue } from './types.ts';
import { ISSUE_CODES } from './issueCodes.ts';

export type SourceKind = 'npm' | 'pypi' | 'github' | 'http' | 'local';

export interface ParsedSource {
  kind: SourceKind;
  raw: string;
  /** 不含 pin 的规范定位符，例如 `npm:@scope/pkg`、`github:owner/repo` */
  locator: string;
  /** 不可变 pin：版本号 / commit / tag / 范围 */
  pin?: string;
  /** github 的子路径，例如 `skills/code-review` */
  subpath?: string;
}

/** 这些 pin 不算「锁住」：解析时会漂移。 */
const VOLATILE = new Set(['latest', 'main', 'master', 'HEAD', '*', '']);
/** 版本范围同样会漂：今天解析到 1.4.0，明天可能是 1.5.0。 */
const RANGE = /[\^~<>]|\|\||\s|\bx\b/i;

interface SourceForm {
  /** 错误文案里列出的写法；与接受判断同一份，改这里两处一起变 */
  label: string;
  parse(raw: string): ParsedSource | undefined;
}

/**
 * 能识别的 source 形态，按顺序试。规则与 schema 的 `resource.source.pattern` 是同一套，
 * 两边都由 ref-source-consistency 测试盯着：
 * - 本地只收 `./`，`../` 不算；
 * - http 只收 `http://` / `https://` 且后面还有内容（`http:foo`、`https:x` 不算）；
 * - npm: / pypi: 后面必须还有非空名字（`npm:` 不算）；
 * - github: 必须有 owner/repo 两段，子路径与 @pin 可选（`github:owner` 不算）。
 * 文档层的同一份语法在 schema 里，两边都改才算改完。
 */
const SOURCE_FORMS: readonly SourceForm[] = [
  {
    label: './',
    parse: (raw) => (raw.startsWith('./') ? { kind: 'local', raw, locator: raw } : undefined),
  },
  {
    label: 'http://',
    parse: (raw) =>
      raw.startsWith('http://') && raw.length > 'http://'.length
        ? { kind: 'http', raw, locator: raw }
        : undefined,
  },
  {
    label: 'https://',
    parse: (raw) =>
      raw.startsWith('https://') && raw.length > 'https://'.length
        ? { kind: 'http', raw, locator: raw }
        : undefined,
  },
  {
    label: 'npm:',
    parse: (raw) => {
      if (!raw.startsWith('npm:')) return undefined;
      const [name, pin] = splitPin(raw.slice('npm:'.length));
      if (!name) return undefined;
      return { kind: 'npm', raw, locator: `npm:${name}`, pin };
    },
  },
  {
    label: 'pypi:',
    parse: (raw) => {
      if (!raw.startsWith('pypi:')) return undefined;
      const [name, pin] = splitPin(raw.slice('pypi:'.length));
      if (!name) return undefined;
      return { kind: 'pypi', raw, locator: `pypi:${name}`, pin };
    },
  },
  {
    label: 'github:',
    parse: (raw) => {
      if (!raw.startsWith('github:')) return undefined;
      const [target, pin] = splitPin(raw.slice('github:'.length));
      const [owner, repo, ...rest] = target.split('/');
      if (!owner || !repo) return undefined;
      const subpath = rest.length ? rest.join('/') : undefined;
      return {
        kind: 'github',
        raw,
        locator: `github:${owner}/${repo}`,
        pin,
        ...(subpath ? { subpath } : {}),
      };
    },
  },
];

export function parseSource(raw: string): ParsedSource {
  for (const form of SOURCE_FORMS) {
    const parsed = form.parse(raw);
    if (parsed) return parsed;
  }
  const supported = SOURCE_FORMS.map((form) => form.label).join(' ');
  throw new Error(`无法识别的 source：${raw}（支持的形态：${supported}）`);
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
        code: ISSUE_CODES.httpMissingIntegrity,
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
      code: ISSUE_CODES.unpinnedSource,
      severity: 'error',
      message: `source 未锁定到不可变 pin：${parsed.raw}（发布版必须写成 @<版本|commit>）`,
      path,
    });
  }
  return issues;
}
