import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import * as tar from 'tar';
import type { Plan, PlanAction } from './types.ts';
import { canonicalize, deepMerge, sha256 } from './util.ts';
import { download } from './download.ts';

export interface ApplyOptions {
  /** Pack 目录（plan 里的相对路径都相对它） */
  root: string;
  /** 允许执行安装期命令（默认拒绝） */
  allowExec?: boolean;
  /** 只计算不落盘 */
  dryRun?: boolean;
}

export type ActionStatus = 'done' | 'noop' | 'failed' | 'skipped' | 'needs-approval';

export interface ActionOutcome {
  actionId: string;
  op: PlanAction['op'];
  status: ActionStatus;
  message?: string;
  target?: string;
}

export interface ApplyResult {
  outcomes: ActionOutcome[];
  statePath: string;
}

interface State {
  apiVersion: 'packhub.dev/state/v0';
  packs: Record<
    string,
    { planHash: string; installedAt: string; actions: ActionOutcome[]; written: string[] }
  >;
}

const STATE_API = 'packhub.dev/state/v0';

const STATE_DIR = '.packhub';
const STATE_FILE = '.packhub/state.json';

export async function applyPlan(plan: Plan, opts: ApplyOptions): Promise<ApplyResult> {
  const outcomes: ActionOutcome[] = [];
  const written: string[] = [];
  const key = `${plan.pack.name}@${plan.pack.version}`;

  for (const action of plan.actions) {
    const blockedBy = (action.dependsOn ?? []).find((id) => {
      const status = outcomes.find((o) => o.actionId === id)?.status;
      return status !== 'done' && status !== 'noop';
    });
    if (blockedBy) {
      outcomes.push({
        actionId: action.actionId,
        op: action.op,
        status: 'skipped',
        message: `依赖 ${blockedBy} 未成功，跳过`,
      });
      continue;
    }
    try {
      outcomes.push(await applyAction(action, plan, opts, written));
    } catch (err) {
      outcomes.push({
        actionId: action.actionId,
        op: action.op,
        status: 'failed',
        message: (err as Error).message,
      });
      break;
    }
  }

  const statePath = join(opts.root, STATE_FILE);
  if (!opts.dryRun && outcomes.every((o) => o.status !== 'failed')) {
    const state = loadState(opts.root);
    state.apiVersion = 'packhub.dev/state/v0';
    const previous = state.packs[key]?.written ?? [];
    state.packs[key] = {
      planHash: plan.planHash,
      installedAt: new Date().toISOString(),
      actions: outcomes,
      // 记录「这个 Pack 拥有哪些文件」而不是「最后一次写了几个」：重复安装时后者会归零
      written: [...new Set([...previous, ...written])],
    };
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  }
  return { outcomes, statePath };
}

async function applyAction(
  action: PlanAction,
  plan: Plan,
  opts: ApplyOptions,
  written: string[],
): Promise<ActionOutcome> {
  switch (action.op) {
    case 'fetch': {
      const dest = within(opts.root, action.dest);
      if (opts.dryRun) {
        return { actionId: action.actionId, op: action.op, status: 'done', target: action.dest };
      }
      const headers: Record<string, string> = {};
      const auth = 'auth' in action ? action.auth : undefined;
      if (auth) {
        const token = process.env[auth.env];
        if (!token) {
          throw new Error(`需要 ${auth.env} 才能下载 ${hostOf(action.uri)}（未设置该环境变量）`);
        }
        const scheme = auth.scheme ?? 'bearer';
        headers.Authorization =
          scheme === 'basic' ? `Basic ${token}` : scheme === 'token' ? `token ${token}` : `Bearer ${token}`;
      }
      const res = await download(action.uri, dest, action.integrity, {
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(auth ? { authHint: auth.env } : {}),
      });
      written.push(action.dest);
      return {
        actionId: action.actionId,
        op: action.op,
        status: 'done',
        target: action.dest,
        message: `${Math.max(1, Math.round(res.bytes / 1024))} KB · ${res.integrity.slice(0, 14)}…`,
      };
    }

    case 'unpack': {
      const from = within(opts.root, action.from);
      const to = within(opts.root, action.to);
      if (!existsSync(from)) throw new Error(`待解包文件不存在：${action.from}`);
      if (!opts.dryRun) {
        mkdirSync(to, { recursive: true });
        await tar.x({
          file: from,
          cwd: to,
          strip: action.strip ?? 0,
          // 归档内部路径不得逃出 to
          filter: (path) => !path.split('/').includes('..'),
        });
      }
      written.push(action.to);
      return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
    }

    case 'exec': {
      if (!opts.allowExec) {
        return {
          actionId: action.actionId,
          op: action.op,
          status: 'needs-approval',
          message: `需要 --allow-exec 才会执行：${action.command} ${action.args.join(' ')}`,
        };
      }
      return {
        actionId: action.actionId,
        op: action.op,
        status: 'skipped',
        message: 'exec 执行还没有实装，只保留审批语义',
      };
    }
    case 'link.skill': {
      const from = within(opts.root, action.from);
      const to = within(opts.root, action.to);
      if (!existsSync(from)) {
        throw new Error(`skill 源目录不存在：${action.from}`);
      }
      if (opts.dryRun) return { actionId: action.actionId, op: action.op, status: 'done' };
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true, force: true });
      written.push(action.to);
      return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
    }

    case 'write': {
      const to = within(opts.root, action.to);
      // 覆盖层可能带二进制文件（图片、字体、脚本），不能一律按 UTF-8 读
      if (action.content === undefined && action.from) {
        const raw = readFileSync(within(opts.root, action.from));
        const binary = raw.subarray(0, 8192).includes(0);
        if (binary) {
          if (existsSync(to) && readFileSync(to).equals(raw)) {
            return { actionId: action.actionId, op: action.op, status: 'noop', target: action.to };
          }
          if (!opts.dryRun) {
            mkdirSync(dirname(to), { recursive: true });
            copyFileSync(within(opts.root, action.from), to);
            written.push(action.to);
          }
          return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
        }
      }
      const content =
        action.content !== undefined
          ? action.content
          : readFileSync(within(opts.root, action.from ?? ''), 'utf8');
      if (existsSync(to) && readFileSync(to, 'utf8') === content) {
        return { actionId: action.actionId, op: action.op, status: 'noop', target: action.to };
      }
      if (!opts.dryRun) {
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, content, 'utf8');
        written.push(action.to);
      }
      return { actionId: action.actionId, op: action.op, status: 'done', target: action.to };
    }

    case 'merge.config': {
      const to = within(opts.root, action.path);
      const patch = action.patch ?? readStructured(within(opts.root, action.patchFrom ?? ''));
      const current = existsSync(to) ? readStructured(to) : {};
      const merged = deepMerge(current, patch);
      const nextText = stringifyFor(to, merged);
      const before = existsSync(to) ? readFileSync(to, 'utf8') : '';
      if (before === nextText) {
        return { actionId: action.actionId, op: action.op, status: 'noop', target: action.path };
      }
      if (!opts.dryRun) {
        mkdirSync(dirname(to), { recursive: true });
        if (before) backup(opts.root, action.path, before);
        writeFileSync(to, nextText, 'utf8');
        written.push(action.path);
      }
      return { actionId: action.actionId, op: action.op, status: 'done', target: action.path };
    }

    case 'register.mcp': {
      const path = '.packhub/config.json';
      const to = within(opts.root, path);
      const current = (existsSync(to) ? readStructured(to) : {}) as Record<string, unknown>;
      const servers = { ...(current.mcpServers as Record<string, unknown> | undefined) } as Record<string, unknown>;
      const key = action.resource ?? 'mcp';
      const nextServer = { ...(servers[key] as object | undefined), ...action.spec };
      const merged = deepMerge(current, { mcpServers: { [key]: nextServer } });
      const nextText = JSON.stringify(merged, null, 2) + '\n';
      const before = existsSync(to) ? readFileSync(to, 'utf8') : '';
      if (before === nextText) {
        return { actionId: action.actionId, op: action.op, status: 'noop', target: path };
      }
      if (!opts.dryRun) {
        mkdirSync(dirname(to), { recursive: true });
        if (before) backup(opts.root, path, before);
        writeFileSync(to, nextText, 'utf8');
        if (!written.includes(path)) written.push(path);
      }
      return { actionId: action.actionId, op: action.op, status: 'done', target: path };
    }

    case 'unpack':
      return {
        actionId: action.actionId,
        op: action.op,
        status: 'skipped',
        message: '这条 unpack 缺少来源',
      };

    default: {
      const unknown = action as { op: PlanAction['op']; actionId: string };
      return {
        actionId: unknown.actionId,
        op: unknown.op,
        status: 'skipped',
        message: '未知动作',
      };
    }
  }
}

/** 报错只留 host + path，不把可能带凭证的查询串打出来。 */
function hostOf(uri: string): string {
  try {
    const u = new URL(uri);
    return `${u.host}${u.pathname}`;
  } catch {
    return uri.split('?')[0] ?? uri;
  }
}

function readStructured(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  return /\.json$/i.test(file) ? JSON.parse(text) : (parseYaml(text) ?? {});
}

function stringifyFor(file: string, value: unknown): string {
  return /\.json$/i.test(file)
    ? JSON.stringify(value, null, 2) + '\n'
    : stringifyYaml(value);
}

function backup(root: string, relPath: string, content: string): void {
  const dest = within(root, join(STATE_DIR, 'backups', sha256(content).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12), relPath));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content, 'utf8');
}

function within(root: string, relPath: string): string {
  const base = resolve(root);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`路径越界，拒绝写入：${relPath}`);
  }
  return target;
}

export function loadState(root: string): State {
  const file = join(root, STATE_FILE);
  if (!existsSync(file)) return { apiVersion: STATE_API, packs: {} };
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<State>;
  // 早期 state 没有 apiVersion：补上而不是拒绝——它是本机缓存，不是发布契约
  return { apiVersion: STATE_API, packs: parsed.packs ?? {} };
}

/** 原子替换，供后续 adapter 复用。 */
export function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}
