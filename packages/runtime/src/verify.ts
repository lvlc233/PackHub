import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Plan, VerifyCheck } from '@packhub/kernel';

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface CheckResult {
  index: number;
  type: VerifyCheck['type'];
  status: CheckStatus;
  detail: string;
}

export interface VerifyOptions {
  root: string;
  /** register.mcp 的启动规格：resource id → spec，mcp-ready 用 */
  servers?: Record<string, unknown>;
}

/** 从计划里取出 MCP 的启动规格：resource id → spec，供 mcp-ready 探活。 */
export function serverSpecs(plan: Plan): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const action of plan.actions) {
    if (action.op === 'register.mcp' && action.resource) out[action.resource] = action.spec;
  }
  return out;
}

export function runChecks(checks: VerifyCheck[], opts: VerifyOptions): CheckResult[] {  return checks.map((check, index) => {
    try {
      return { index, type: check.type, ...evaluate(check, opts) };
    } catch (err) {
      return { index, type: check.type, status: 'fail' as CheckStatus, detail: (err as Error).message };
    }
  });
}

function evaluate(check: VerifyCheck, opts: VerifyOptions): { status: CheckStatus; detail: string } {
  switch (check.type) {
    case 'file-exists': {
      const file = safe(opts.root, check.path);
      return existsSync(file)
        ? { status: 'pass', detail: check.path }
        : { status: 'fail', detail: `不存在：${check.path}` };
    }
    case 'config-key': {
      const file = safe(opts.root, check.path);
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
    case 'command': {
      const [command, ...args] = check.run;
      if (!command) return { status: 'fail', detail: 'command 检查缺少 run' };
      const res = spawnSync(command, args, {
        cwd: opts.root,
        encoding: 'utf8',
        timeout: (check.timeout ?? 30) * 1000,
        shell: process.platform === 'win32',
        windowsHide: true,
      });
      const expected = check.expectExit ?? 0;
      const tail = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().split(/\r?\n/).slice(-1)[0] ?? '';
      return res.status === expected
        ? { status: 'pass', detail: `退出码 ${String(res.status)}${tail ? ` · ${tail}` : ''}` }
        : {
            status: 'fail',
            detail: `退出码 ${String(res.status)}（期望 ${expected}）${tail ? ` · ${tail}` : ''}`,
          };
    }
    case 'mcp-ready': {
      const spec = opts.servers?.[check.resource];
      if (!spec || typeof spec !== 'object') {
        return { status: 'skipped', detail: `计划里没有 ${check.resource} 的启动规格` };
      }
      const server = spec as { command?: unknown; args?: unknown; url?: unknown };
      if (server.url) return { status: 'skipped', detail: 'http 传输的探活还没做（需要真实网络端点）' };
      if (typeof server.command !== 'string') {
        return { status: 'skipped', detail: '这个 MCP 没有可启动的 command' };
      }
      const args = Array.isArray(server.args) ? server.args.map(String) : [];
      const init = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'packhub', version: '0.0.1' },
        },
      });
      const res = spawnSync(server.command, args, {
        cwd: opts.root,
        input: `${init}\n`,
        encoding: 'utf8',
        timeout: (check.timeout ?? 10) * 1000,
        shell: process.platform === 'win32',
        windowsHide: true,
      });
      const out = `${res.stdout ?? ''}`;
      if (/"result"\s*:/.test(out) || /"protocolVersion"\s*:/.test(out)) {
        return { status: 'pass', detail: `${check.resource} 完成 initialize 握手` };
      }
      const tail = `${res.stderr ?? ''}`.trim().split(/\r?\n/).slice(-1)[0] ?? '';
      return {
        status: 'fail',
        detail: `${check.resource} 没有回应 initialize${tail ? `：${tail}` : '（可能没装或起了就退出）'}`,
      };
    }
    case 'knowledge-integrity': {
      if (!check.integrity) {
        return { status: 'skipped', detail: `资源 ${check.resource} 没有 integrity，无法校验内容` };
      }
      const hit = findFileWithHash(opts.root, check.integrity);
      return hit
        ? { status: 'pass', detail: `${hit} 的哈希与资源一致` }
        : { status: 'fail', detail: `没有找到哈希为 ${check.integrity.slice(0, 16)}… 的文件` };
    }
    default:
      return { status: 'skipped', detail: '未知检查类型' };
  }
}

/** 在安装产物里找第一个 sha256 匹配的文件（只看 .packhub 下的物化结果，跳过缓存/快照/包副本）。 */
function findFileWithHash(root: string, integrity: string): string | null {
  const start = existsSync(join(root, '.packhub')) ? join(root, '.packhub') : root;
  const skip = new Set(['.git', 'node_modules', 'cache', 'snapshots', 'backups', 'packs']);
  const walk = (dir: string, rel: string): string | null => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const found = walk(abs, next);
        if (found) return found;
      } else if (entry.isFile()) {
        if (statSync(abs).size > 8 * 1024 * 1024) continue;
        const digest = `sha256-${createHash('sha256').update(readFileSync(abs)).digest('base64')}`;
        if (digest === integrity) return next;
      }
    }
    return null;
  };
  return walk(start, '');
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
