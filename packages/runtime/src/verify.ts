import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Plan, VerifyCheck } from '@packhub/kernel';
import { askHarness } from './harness-probe.ts';

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

export async function runChecks(checks: VerifyCheck[], opts: VerifyOptions): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const [index, check] of checks.entries()) {
    try {
      out.push({ index, type: check.type, ...(await evaluate(check, opts)) });
    } catch (err) {
      out.push({
        index,
        type: check.type,
        status: 'fail',
        detail: (err as Error).message,
      });
    }
  }
  return out;
}

async function evaluate(
  check: VerifyCheck,
  opts: VerifyOptions,
): Promise<{ status: CheckStatus; detail: string }> {
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
      if (typeof server.url === 'string' && server.url) {
        // MCP Streamable HTTP：POST 一条 initialize，响应可能是 JSON 或 SSE
        const timeoutMs = (check.timeout ?? 10) * 1000;
        let body = '';
        let status = 0;
        try {
          const response = await fetch(server.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: init,
            signal: AbortSignal.timeout(timeoutMs),
          });
          status = response.status;
          body = await response.text();
        } catch (err) {
          return {
            status: 'fail',
            detail: `${check.resource} 的 http 探活失败：${(err as Error).message}（${server.url}）`,
          };
        }
        const payload = body.includes('data:')
          ? body
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('\n')
          : body;
        if ((/"result"\s*:/.test(payload) || /"protocolVersion"\s*:/.test(payload)) && status < 400) {
          return { status: 'pass', detail: `${check.resource} 完成 http initialize 握手（${server.url}）` };
        }
        return {
          status: 'fail',
          detail: `${check.resource} 的 http 端点没有回应 initialize（HTTP ${status}）`,
        };
      }
      if (typeof server.command !== 'string') {
        return { status: 'skipped', detail: '这个 MCP 没有可启动的 command 或 url' };
      }
      const args = Array.isArray(server.args) ? server.args.map(String) : [];
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
    case 'scenario': {
      const wants =
        typeof check.expectOutput === 'string'
          ? [check.expectOutput]
          : Array.isArray(check.expectOutput)
            ? check.expectOutput
            : [];
      if (check.harness) {
        if (!check.prompt) return { status: 'skipped', detail: 'scenario 用 harness 时必须写 prompt' };
        const asked = askHarness({
          target: check.harness,
          projectDir: opts.root,
          prompt: check.prompt,
          ...(check.timeout ? { timeoutMs: check.timeout * 1000 } : {}),
        });
        if (!asked.ok) {
          return { status: 'fail', detail: `harness 没跑通：${asked.reason ?? '未知原因'}` };
        }
        const missing = wants.filter((w) => !asked.answer.includes(w));
        if (missing.length > 0) {
          return {
            status: 'fail',
            detail: `回答里缺：${missing.join('、')}（回答：${asked.answer.replace(/\s+/g, ' ').slice(0, 120)}）`,
          };
        }
        return {
          status: 'pass',
          detail: `${check.harness} 回答里出现了期望内容（${asked.answer.replace(/\s+/g, ' ').slice(0, 80)}）`,
        };
      }
      if (!check.run || check.run.length === 0) {
        return { status: 'skipped', detail: 'scenario 需要 run 或 harness 之一' };
      }
      const [command, ...args] = check.run;
      if (!command) return { status: 'fail', detail: 'scenario 的 run 为空' };
      const cwd = check.cwd ? safe(opts.root, check.cwd) : opts.root;
      const res = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        timeout: (check.timeout ?? 120) * 1000,
        shell: process.platform === 'win32',
        windowsHide: true,
      });
      const expected = check.expectExit ?? 0;
      const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
      if (res.status !== expected) {
        const tail = combined.trim().split(/\r?\n/).slice(-1)[0] ?? '';
        return {
          status: 'fail',
          detail: `退出码 ${String(res.status)}（期望 ${expected}）${tail ? ` · ${tail}` : ''}`,
        };
      }
      const missing = wants.filter((w) => !combined.includes(w));
      if (missing.length > 0) {
        return { status: 'fail', detail: `输出里缺：${missing.join('、')}` };
      }
      const missingFiles = (check.expectFiles ?? []).filter((f) => !existsSync(safe(opts.root, f)));
      if (missingFiles.length > 0) {
        return { status: 'fail', detail: `跑完没有产出文件：${missingFiles.join('、')}` };
      }
      return {
        status: 'pass',
        detail: `退出码 ${String(res.status)}${wants.length ? `，输出含 ${wants.join('、')}` : ''}`,
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
  // versions/ 是版本镜像，不是活文件：否则「文件被改过」会被镜像里的原始副本掩盖
  const skip = new Set(['.git', 'node_modules', 'cache', 'snapshots', 'backups', 'packs', 'versions']);
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
