import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadPack, planFor, type Plan } from '@packhub/kernel';
import { applyPlan, loadState, removePack, type ActionOutcome } from './install.ts';
import { doctorPack, type DoctorReport } from './doctor.ts';

export type SyncTarget = 'dsh' | 'codex';

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
}

/** 全局 harness 的落点：优先环境变量，测试与多环境都靠它隔离。 */
export function harnessRoot(target: SyncTarget): string {
  const env = target === 'dsh' ? process.env.PACKHUB_DSH_HOME : process.env.PACKHUB_CODEX_HOME;
  return env ? resolve(env) : join(homedir(), target === 'dsh' ? '.dsh' : '.codex');
}

/**
 * 全局同步的路径表：root 是 harness home，skills 直接落在它的 skills/ 下。
 * 不写 instructionFile——全局 AGENTS.md 不归这个命令管。
 */
export function globalTargetVars(): Record<string, string> {
  return {
    root: '.packhub',
    cacheDir: '.packhub/cache',
    skillsDir: 'skills',
    knowledgeDir: 'knowledge',
    promptsDir: 'prompts',
    configFile: 'config.json',
    // 空字符串让 buildPlan 不追加 instruction：全局 AGENTS.md 不归 sync 管
    instructionFile: '',
  };
}

export interface SkillFrontmatter {
  name: string;
  description: string;
}

/** 只认 SKILL.md 的 YAML frontmatter；Codex 对格式比 DSH 严，先在这里拦住。 */
export function readSkillFrontmatter(skillDir: string): SkillFrontmatter {
  const file = join(skillDir, 'SKILL.md');
  if (!existsSync(file)) throw new Error(`skill 缺少 SKILL.md：${file}`);
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) throw new Error(`SKILL.md 没有 YAML frontmatter：${file}`);
  let data: unknown;
  try {
    data = parseYaml(match[1]!);
  } catch (err) {
    throw new Error(`SKILL.md frontmatter 不是合法 YAML：${file}（${(err as Error).message}）`);
  }
  if (!data || typeof data !== 'object') throw new Error(`SKILL.md frontmatter 不是对象：${file}`);
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) throw new Error(`SKILL.md 缺少字符串 name：${file}`);
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`SKILL.md 缺少字符串 description：${file}`);
  }
  return { name: name.trim(), description: description.trim() };
}

function assertHarnessRoot(target: SyncTarget, root: string): void {
  if (!existsSync(root)) {
    throw new Error(
      `${target} 的 home 不存在：${root}${target === 'codex' ? '（先安装 Codex，或设 PACKHUB_CODEX_HOME）' : '（先安装 DSH，或设 PACKHUB_DSH_HOME）'}`,
    );
  }
  if (!statSync(root).isDirectory()) throw new Error(`${target} 的 home 不是目录：${root}`);
}

/**
 * 把一个 skill-only Pack 同步到各 harness 的全局 skills/。
 * 只接受 type=skill 且来源是本地的资源；MCP/CLI/配置需要各自的 adapter，暂不混进来。
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
  if (!resources.some((r) => r.type === 'skill')) throw new Error('这个 Pack 没有 skill 资源');
  const others = resources.filter((r) => r.type !== 'skill');
  if (others.length) {
    throw new Error(
      `全局同步目前只支持 skill，拒绝这些资源：${others.map((r) => `${r.id}(${r.type})`).join(', ')}`,
    );
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

  for (const r of resources) {
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
  }

  const results: SyncTargetResult[] = [];
  for (const target of opts.targets) {
    const root = harnessRoot(target);
    const { plan } = planFor(ctx, { target, targetVars: globalTargetVars() });
    if (!plan) throw new Error(`${target}: 生成不了计划`);
    if (opts.dryRun) {
      results.push({ target, root, planHash: plan.planHash });
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
    results.push({ target, root, planHash: plan.planHash, outcomes: res.outcomes });
  }
  return { pack, results };
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
    try {
      assertHarnessRoot(target, root);
      return { target, root, report: doctorPack(root) };
    } catch (err) {
      return { target, root, error: (err as Error).message };
    }
  });
}

export type { Plan };

