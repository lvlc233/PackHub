import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadPack, planFor, buildMcpSpec, interpolate, type PackContext, type Plan, type ResourceSpec } from '@packhub/kernel';
import { applyPlan, loadState, saveState, removePack, type ActionOutcome } from './install.ts';
import { doctorPack, type DoctorReport } from './doctor.ts';
import { readSkillFrontmatter } from './skill-meta.ts';
import { assertHarnessRoot, harnessRoot, harnessSpec, type SyncTarget } from './harnesses.ts';
import {
  addClaudeMcp,
  claudeAvailable,
  claudeHasMcp,
  removeClaudeMcp,
  type HostMcpResult,
  type HostMcpSpec,
} from './host-mcp.ts';

export type { SyncTarget } from './harnesses.ts';

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
  /** 面板用：这张表里的落点能力 */
  label?: string;
  homeEnv?: string;
  supportsMcp?: boolean;
}

/**
 * 全局同步的路径表：root 是 harness home，skills 直接落在它的 skills/ 下。
 * 具体落点从 harness 注册表读：config.toml（toml 宿主）或 .packhub/config.json，指令块文件名也由表决定。
 */
export function globalTargetVars(target: SyncTarget = 'dsh'): Record<string, string> {
  const spec = harnessSpec(target);
  return {
    root: '.packhub',
    cacheDir: '.packhub/cache',
    skillsDir: spec.skillsDir,
    knowledgeDir: 'knowledge',
    promptsDir: 'prompts',
    binDir: 'bin',
    configFile: spec.mcp === 'toml' ? 'config.toml' : '.packhub/config.json',
    instructionFile: spec.instructionFile,
  };
}

export { readSkillFrontmatter, type SkillFrontmatter } from './skill-meta.ts';

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
    const spec = harnessSpec(target);
    if (mcp.length > 0 && spec.mcp === 'none') {
      throw new Error(
        `${target}: ${spec.mcpReason ?? '没有可依赖的全局 MCP 契约'}；${mcp.map((r) => r.id).join(', ')} 需要项目级安装，或同步到声明了 MCP 落点的宿主`,
      );
    }
  }
  if (ctx.manifest.install?.exec?.length) {
    throw new Error('全局同步不会执行 install.exec');
  }
  if (ctx.manifest.overlays?.length) {
    throw new Error('全局同步不支持 overlays（会写 skills/ 之外的文件）');
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
    if (harnessSpec(target).mcp === 'toml' && mcp.length > 0) {
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
    if (harnessSpec(target).mcp === 'claude-cli' && mcp.length > 0) {
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
    const spec = harnessSpec(target);
    const { plan } = planFor(ctx, {
      target,
      targetVars: globalTargetVars(target),
      // claude 的全局 MCP 交给它自己的 CLI，计划里只落 skills 与指令块
      ...(spec.mcp === 'claude-cli' ? { skipResourceTypes: ['mcp' as const] } : {}),
    });
    if (!plan) throw new Error(`${target}: 生成不了计划`);
    if (opts.dryRun) {
      results.push({
        target,
        root,
        planHash: plan.planHash,
        ...(mcp.length > 0 && spec.mcp === 'claude-cli'
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
      if (spec.mcp === 'claude-cli') {
        mcpResults = registerClaudeMcp(ctx, mcp, target, root);
      } else {
        // toml 宿主：register.mcp 已经写进 config.toml，按动作结果判 added / kept
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
    const spec = harnessSpec(target);
    const base = {
      target,
      root: harnessRoot(target),
      label: spec.label,
      homeEnv: spec.homeEnv,
      supportsMcp: spec.mcp !== 'none',
    };
    if (!existsSync(base.root)) {
      return { ...base, skipped: true, error: `${target} 的 home 不存在：${base.root}（设 ${spec.homeEnv} 可指定）` };
    }
    try {
      assertHarnessRoot(target, base.root);
      return { ...base, report: doctorPack(base.root) };
    } catch (err) {
      return { ...base, error: (err as Error).message };
    }
  });
}

export type { Plan };

