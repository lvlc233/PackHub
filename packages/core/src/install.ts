import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Plan, PlanAction } from './types.ts';
import { canonicalize, deepMerge, sha256 } from './util.ts';

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
  packs: Record<
    string,
    { planHash: string; installedAt: string; actions: ActionOutcome[]; written: string[] }
  >;
}

const STATE_DIR = '.packhub';
const STATE_FILE = '.packhub/state.json';

export function applyPlan(plan: Plan, opts: ApplyOptions): ApplyResult {
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
      outcomes.push(applyAction(action, plan, opts, written));
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

function applyAction(
  action: PlanAction,
  plan: Plan,
  opts: ApplyOptions,
  written: string[],
): ActionOutcome {
  switch (action.op) {
    case 'fetch':
      return {
        actionId: action.actionId,
        op: action.op,
        status: 'skipped',
        message: 'v0.0.1 的 dir adapter 不联网：远程资源留给 v0.0.2（本地资源可完整闭环）',
      };

    case 'exec':
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
        message: 'v0.0.1 先不实装 exec 执行，仅保留审批语义',
      };

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
        message: 'v0.0.1 不解包归档（依赖 fetch）',
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
  if (!existsSync(file)) return { packs: {} };
  return JSON.parse(readFileSync(file, 'utf8')) as State;
}

/** 原子替换，供后续 adapter 复用。 */
export function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}
