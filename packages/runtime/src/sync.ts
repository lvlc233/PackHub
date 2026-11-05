import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadPack, planFor, buildMcpSpec, interpolate, type PackContext, type Plan, type ResourceSpec } from '@packhub/kernel';
import { applyPlan, loadState, saveState, removePack, type ActionOutcome } from './install.ts';
import { doctorPack, type DoctorReport } from './doctor.ts';
import { readSkillFrontmatter } from './skill-meta.ts';
import {
  addClaudeMcp,
  claudeAvailable,
  claudeHasMcp,
  removeClaudeMcp,
  type HostMcpResult,
  type HostMcpSpec,
} from './host-mcp.ts';

export type SyncTarget = 'dsh' | 'codex' | 'claude-code';

export interface SyncOptions {
  targets: SyncTarget[];
  dryRun?: boolean;
  overwrite?: boolean;
}

export interface SyncTargetResult {
  target: SyncTarget;
  root: string;
  planHash?: string;
  outcomes?: ActionOutcome[];
  /** 交给宿主 CLI 的 MCP 结果（目前只有 claude-code 会走这条路） */
  mcp?: HostMcpResult[];
}

export interface SyncRemoveResult {
  target: SyncTarget;
  root: string;
  removed: string[];
  packs: string[];
}

export interface GlobalDoctorResult {
  target: SyncTarget;
  root: string;
  report?: DoctorReport;
  error?: string;
  /** 这个 harness 没装（home 不存在）：默认检查全部目标时不算失败 */
  skipped?: boolean;
}

/** 全局 harness 的落点：优先环境变量，测试与多环境都靠它隔离。 */
export function harnessRoot(target: SyncTarget): string {
  const env =
    target === 'dsh'
      ? process.env.PACKHUB_DSH_HOME
      : target === 'codex'
        ? process.env.PACKHUB_CODEX_HOME
        : process.env.PACKHUB_CLAUDE_HOME;
  if (env) return resolve(env);
  return join(homedir(), target === 'dsh' ? '.dsh' : target === 'codex' ? '.codex' : '.claude');
}

/**
 * 全局同步的路径表：root 是 harness home，skills 直接落在它的 skills/ 下。
 * codex 的 MCP 配置是 TOML；其余 harness 暂只同步 skills 与指令块。
 */
export function globalTargetVars(target: SyncTarget = 'dsh'): Record<string, string> {
  return {
    root: '.packhub',
    cacheDir: '.packhub/cache',
    skillsDir: 'skills',
    knowledgeDir: 'knowledge',
    promptsDir: 'prompts',
    binDir: 'bin',
    configFile: target === 'codex' ? 'config.toml' : '.packhub/config.json',
    instructionFile: target === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md',
  };
}

export { readSkillFrontmatter, type SkillFrontmatter } from './skill-meta.ts';

function assertHarnessRoot(target: SyncTarget, root: string): void {
  if (!existsSync(root)) {
    const hint =
      target === 'codex'
        ? '（先安装 Codex，或设 PACKHUB_CODEX_HOME）'
        : target === 'claude-code'
          ? '（先安装 Claude Code，或设 PACKHUB_CLAUDE_HOME）'
          : '（先安装 DSH，或设 PACKHUB_DSH_HOME）';
    throw new Error(`${target} 的 home 不存在：${root}${hint}`);
  }
  if (!statSync(root).isDirectory()) throw new Error(`${target} 的 home 不是目录：${root}`);
}

/**
 * 把一个 skill-only Pack 同步到各 harness 的全局 skills/。
 * 接受本地 skill 与（仅 codex）mcp；MCP 写入 config.toml 托管块，其他类型仍拒绝。
 */
export async function syncPack(
  packDir: string,
  opts: SyncOptions,
): Promise<{ pack: string; results: SyncTargetResult[] }> {
  const dir = resolve(packDir);
  const ctx = loadPack(dir);
  const errors = ctx.issues.filter((i) => i.severity === 'error');
  if (errors.length) throw new Error(`清单有错：${errors.map((e) => e.message).join('; ')}`);

  const resources = ctx.manifest.resources ?? [];
  if (resources.length === 0) throw new Error('这个 Pack 没有可同步的资源');
  const others = resources.filter((r) => r.type !== 'skill' && r.type !== 'mcp');
  if (others.length) {
    throw new Error(
      `全局同步只支持 skill 与 mcp，拒绝这些资源：${others.map((r) => `${r.id}(${r.type})`).join(', ')}`,
    );
  }
  const mcp = resources.filter((r) => r.type === 'mcp');
  for (const target of opts.targets) {
    if (mcp.length > 0 && target === 'dsh') {
      throw new Error(
        `dsh: 没有可依赖的全局 MCP 配置契约（profile patch 是 DSH 私有的）；${mcp.map((r) => r.id).join(', ')} 需要项目级安装，或同步到 codex / claude-code`,
      );
    }
  }
  if (ctx.manifest.install?.exec?.length) {
    throw new Error('全局同步不会执行 install.exec');
  }
  if (ctx.manifest.overlays?.length) {
    throw new Error('全局同步不支持 overlays（会写 skills/ 之外的文件）');
  }
  if (ctx.manifest.composition?.env && Object.keys(ctx.manifest.composition.env).length > 0) {
    throw new Error('全局同步不支持 composition.env（会写 harness 的配置文件）');
  }

  for (const r of resources.filter((x) => x.type === 'skill')) {
    if (!r.source.startsWith('./')) throw new Error(`全局同步要求本地 skill 源：${r.id} 是 ${r.source}`);
    readSkillFrontmatter(resolve(dir, r.source));
  }

  const pack = `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`;
  // 先把所有目标检查完，避免 dsh 写成功、codex 失败留下半套
  for (const target of opts.targets) {
    const root = harnessRoot(target);
    assertHarnessRoot(target, root);
    const state = loadState(root);
    for (const r of resources) {
      const rel = `skills/${r.id}`;
      const dest = join(root, rel);
      if (!existsSync(dest)) continue;
      const owned = Object.entries(state.packs).some(
        ([key, rec]) => key.startsWith(`${ctx.manifest.metadata.name}@`) && rec.written.includes(rel),
      );
      if (!owned && !opts.overwrite) {
        throw new Error(
          `${target}: ${dest} 已存在，且不是这个包装的；先确认内容，或加 --overwrite`,
        );
      }
    }
    if (target === 'codex' && mcp.length > 0) {
      const configFile = join(root, 'config.toml');
      if (existsSync(configFile)) {
        const text = readFileSync(configFile, 'utf8');
        const ownsConfig = Object.entries(state.packs).some(
          ([key, rec]) => key.startsWith(`${ctx.manifest.metadata.name}@`) && rec.written.includes('config.toml'),
        );
        for (const r of mcp) {
          if (new RegExp(`\\[mcp_servers\\.${r.id}\\]`).test(text) && !ownsConfig && !opts.overwrite) {
            throw new Error(`${target}: config.toml 里已经有 [mcp_servers.${r.id}]，不是这个包装的；确认后加 --overwrite`);
          }
        }
      }
    }
    if (target === 'claude-code' && mcp.length > 0) {
      if (!claudeAvailable()) {
        throw new Error(
          'claude-code: 找不到可用的 claude 命令（先安装 Claude Code，或用 PACKHUB_CLAUDE_BIN 指定），无法注册全局 MCP',
        );
      }
      const owned = new Set(
        Object.entries(state.packs)
          .filter(([key]) => key.startsWith(`${ctx.manifest.metadata.name}@`))
          .flatMap(([, rec]) => rec.hostMcp ?? []),
      );
      for (const r of mcp) {
        if (claudeHasMcp(r.id) && !owned.has(r.id) && !opts.overwrite) {
          throw new Error(
            `${target}: user scope 里已经有 MCP ${r.id}，不是这个包装的；确认后加 --overwrite`,
          );
        }
      }
    }
  }

  const results: SyncTargetResult[] = [];
  for (const target of opts.targets) {
    const root = harnessRoot(target);
    const { plan } = planFor(ctx, {
      target,
      targetVars: globalTargetVars(target),
      // claude 的全局 MCP 交给它自己的 CLI，计划里只落 skills 与指令块
      ...(target === 'claude-code' ? { skipResourceTypes: ['mcp' as const] } : {}),
    });
    if (!plan) throw new Error(`${target}: 生成不了计划`);
    if (opts.dryRun) {
      results.push({
        target,
        root,
        planHash: plan.planHash,
        ...(mcp.length > 0 && target === 'claude-code'
          ? { mcp: mcp.map((r) => ({ id: r.id, status: 'planned' as const })) }
          : {}),
      });
      continue;
    }
    // 预检已经做过；这里只执行，不再重复判断
    const res = await applyPlan(plan, {
      root,
      packRoot: dir,
      dryRun: false,
      overwrite: opts.overwrite === true,
    });
    const bad = res.outcomes.filter((o) => o.status !== 'done' && o.status !== 'noop');
    if (bad.length) {
      throw new Error(`${target}: 同步未完成（${bad.map((o) => `${o.actionId}=${o.status}`).join(', ')}）`);
    }

    let mcpResults: HostMcpResult[] | undefined;
    if (mcp.length > 0) {
      if (target === 'claude-code') {
        mcpResults = registerClaudeMcp(ctx, mcp, target, root);
      } else {
        // codex：register.mcp 已经写进 config.toml，按动作结果判 added / kept
        mcpResults = mcp.map((r) => {
          const outcome = res.outcomes.find((o) => o.op === 'register.mcp' && o.resource === r.id);
          return { id: r.id, status: outcome?.status === 'done' ? 'added' : 'kept' };
        });
      }
    }
    results.push({ target, root, planHash: plan.planHash, outcomes: res.outcomes, ...(mcpResults ? { mcp: mcpResults } : {}) });
  }
  return { pack, results };
}

/** 把 mcp 资源交给 claude 的 user scope；失败时撤掉这次新加的，避免留半套。 */
function registerClaudeMcp(
  ctx: PackContext,
  resources: ResourceSpec[],
  target: SyncTarget,
  root: string,
): HostMcpResult[] {
  const added: string[] = [];
  const out: HostMcpResult[] = [];
  try {
    for (const r of resources) {
      const existed = claudeHasMcp(r.id);
      if (!existed) {
        addClaudeMcp(r.id, launchSpec(ctx, r, target));
        added.push(r.id);
      }
      out.push({ id: r.id, status: existed ? 'kept' : 'added' });
    }
  } catch (err) {
    for (const name of added) {
      try {
        removeClaudeMcp(name);
      } catch {
        /* 回滚尽力而为，原始错误更重要 */
      }
    }
    throw new Error(`${target}: ${(err as Error).message}`);
  }

  const state = loadState(root);
  const key = `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`;
  const record = state.packs[key];
  if (record) {
    record.hostMcp = [...new Set([...(record.hostMcp ?? []), ...resources.map((r) => r.id)])];
    saveState(root, state);
  }
  return out;
}

/** 复用计划层的 MCP 规格推导：npm → npx、pypi → uvx、http → url。 */
function launchSpec(ctx: PackContext, res: ResourceSpec, target: SyncTarget): HostMcpSpec {
  const scope = {
    vars: ctx.manifest.vars ?? {},
    target: globalTargetVars(target),
    paths: ctx.manifest.paths ?? {},
  };
  const config = interpolate(res.config ?? {}, scope) as Record<string, unknown>;
  return buildMcpSpec(res, config) as HostMcpSpec;
}

/** 从各 harness 的 state 里按包名移除所有版本。 */
export function removeSynced(packDir: string, targets: SyncTarget[]): SyncRemoveResult[] {
  const ctx = loadPack(resolve(packDir));
  const name = ctx.manifest?.metadata.name;
  if (!name) throw new Error('清单读不出来');
  const out: SyncRemoveResult[] = [];
  for (const target of targets) {
    const root = harnessRoot(target);
    assertHarnessRoot(target, root);
    const state = loadState(root);
    const keys = Object.keys(state.packs).filter((k) => k.startsWith(`${name}@`));
    const removed: string[] = [];
    for (const key of keys) {
      const res = removePack(root, key);
      removed.push(...res.removed);
    }
    out.push({ target, root, removed, packs: keys });
  }
  return out;
}

/** 全局漂移检查：分别看每个 harness 的 state。 */
export function doctorGlobal(targets: SyncTarget[]): GlobalDoctorResult[] {
  return targets.map((target) => {
    const root = harnessRoot(target);
    if (!existsSync(root)) {
      return { target, root, skipped: true, error: `${target} 的 home 不存在：${root}` };
    }
    try {
      assertHarnessRoot(target, root);
      return { target, root, report: doctorPack(root) };
    } catch (err) {
      return { target, root, error: (err as Error).message };
    }
  });
}

export type { Plan };

