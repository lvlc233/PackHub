import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { VerifyCheck } from './types.ts';

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface CheckResult {
  index: number;
  type: VerifyCheck['type'];
  status: CheckStatus;
  detail: string;
}

export interface VerifyOptions {
  root: string;
}

export function runChecks(checks: VerifyCheck[], opts: VerifyOptions): CheckResult[] {
  return checks.map((check, index) => {
    try {
      return { index, type: check.type, ...evaluate(check, opts.root) };
    } catch (err) {
      return { index, type: check.type, status: 'fail' as CheckStatus, detail: (err as Error).message };
    }
  });
}

function evaluate(check: VerifyCheck, root: string): { status: CheckStatus; detail: string } {
  switch (check.type) {
    case 'file-exists': {
      const file = safe(root, check.path);
      return existsSync(file)
        ? { status: 'pass', detail: check.path }
        : { status: 'fail', detail: `不存在：${check.path}` };
    }
    case 'config-key': {
      const file = safe(root, check.path);
      if (!existsSync(file)) return { status: 'fail', detail: `配置文件不存在：${check.path}` };
      const data = readStructured(file);
      const actual = getPath(data, check.key);
      if (check.equals === undefined) {
        return actual === undefined
          ? { status: 'fail', detail: `缺少键：${check.key}` }
          : { status: 'pass', detail: `${check.key} = ${JSON.stringify(actual)}` };
      }
      return JSON.stringify(actual) === JSON.stringify(check.equals)
        ? { status: 'pass', detail: `${check.key} = ${JSON.stringify(actual)}` }
        : {
            status: 'fail',
            detail: `${check.key} 期望 ${JSON.stringify(check.equals)}，实际 ${JSON.stringify(actual)}`,
          };
    }
    case 'command':
    case 'mcp-ready':
    case 'knowledge-integrity':
      return {
        status: 'skipped',
        detail: 'v0.0.1 只做只读的文件/配置检查；进程探活与内容哈希校验在 v0.0.2',
      };
    default:
      return { status: 'skipped', detail: '未知检查类型' };
  }
}

function safe(root: string, relPath: string): string {
  const base = resolve(root);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`路径越界：${relPath}`);
  }
  return target;
}

function readStructured(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  return extname(file).toLowerCase() === '.json' ? JSON.parse(text) : (parseYaml(text) ?? {});
}

function getPath(data: unknown, key: string): unknown {
  let cur: unknown = data;
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
