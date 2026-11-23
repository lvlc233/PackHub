// 目录对象命令：install / uninstall / verify / rollback 作用于「一个已存在的目录」，
// 不创建 PAL 实例记录。新建实例仍走 create（pal create）。
//
// 与实例路径的分工：
// - 这里只写文件 + `.packhub/state.json`，不动实例记录、基线、active 指针；
// - 安装/卸载/校验/回退的实现都在 runtime，命令层只负责参数、排版与退出码。
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineCommand } from 'citty';
import {
  PACKHUB_ENV,
  STATE_FILE,
  harnessIds,
  isHarnessId,
  type HarnessId,
  type Issue,
  type Plan,
} from '@packhub/kernel';
import {
  InstallSourceError,
  doctorPack,
  installFromSource,
  loadState,
  removePack,
  resolveRegistry,
  rollbackPack,
  updatePack,
  verifyAt,
  type UpdateResult,
} from '@packhub/runtime';
import { PalError } from './errors.ts';

/** installDir 的 --host 可选名单：现查宿主注册表（加宿主不用改 launcher）。 */
function harnessHint(): string {
  return `${harnessIds().join(' / ')}（安装参数；不用 dir）`;
}
const INSTANCE_HINT =
  '装进已有项目用 pal install --project <目录> --host <宿主>；新建命名 home 用 pal install <pack> --host <宿主>。';

/** 解析 --host：只认宿主名（dir 是 PAL 的实例形态，不是安装参数）。 */
function parseInstallHost(raw: unknown): HarnessId {
  const value = String(raw ?? '');
  if (!isHarnessId(value)) {
    throw new PalError('invalid-input', `未知宿主：${value}`, {
      hint: `可选 ${harnessHint()}`,
      details: { harness: value, choices: harnessIds() },
    });
  }
  return value as HarnessId;
}

/** issue 行与 CLI 的写法一致：error 打 `error [code]`，warning 打 `warn  [code]`。 */
function printIssues(issues: readonly Issue[], log: (line: string) => void): void {
  for (const issue of issues) {
    log(`${issue.severity === 'error' ? 'error' : 'warn '} [${issue.code}] ${issue.message}`);
  }
}

export function printPlanSummary(plan: Plan, log: (line: string) => void): void {
  log(`${plan.pack.name}@${plan.pack.version} → ${plan.harness ? `harness=${plan.harness}` : '平铺目录'}`);
  for (const action of plan.actions) {
    const dest = 'to' in action ? action.to : 'dest' in action ? action.dest : 'path' in action ? action.path : '';
    log(`  ${action.actionId.padEnd(16)} ${action.op.padEnd(14)} ${dest}`);
  }
  log(`planHash ${plan.planHash}`);
}

/** 目录里有没有安装记录：state.json 存在且至少一个包。 */
function requireInstalledState(dir: string): ReturnType<typeof loadState> {
  if (!existsSync(join(dir, STATE_FILE))) {
    throw new PalError('invalid-input', `这个目录没有安装记录：${dir}`, {
      hint: `${INSTANCE_HINT}安装记录在 ${STATE_FILE}。`,
    });
  }
  const state = loadState(dir);
  if (Object.keys(state.packs).length === 0) {
    throw new PalError('invalid-input', `这个目录没有安装记录：${dir}（state 里没有包）`, {
      hint: INSTANCE_HINT,
    });
  }
  return state;
}

/* ---------- install ---------- */

export const installDir = defineCommand({
  meta: {
    name: 'install',
    description: `把来源装进一个已存在的目录（只写文件与 ${STATE_FILE}）`,
  },
  args: {
    source: {
      type: 'positional',
      required: true,
      description: 'Pack 目录、.phub、git+https，或配合 --index 用 registry 名（name 或 name@version）',
    },
    project: { type: 'string', default: '.', description: '装到哪个项目目录（默认当前目录；不存在会创建）' },
    host: { type: 'string', description: harnessHint() },
    index: { type: 'string', description: `registry 索引（路径或 URL；也可用 ${PACKHUB_ENV.index}）` },
    'dry-run': { type: 'boolean', default: false, description: '只算计划，不落盘' },
    overwrite: { type: 'boolean', default: false, description: '允许覆盖别的包写过的普通文件' },
    'allow-exec': { type: 'boolean', default: false, description: '允许执行清单里的 install.exec' },
    'allow-unsigned': {
      type: 'boolean',
      default: false,
      description: '外部来源：即使配置了信任列表也接受无签名包（显式降低要求）',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const log = (line: string): void => {
      if (!args.json) console.log(line);
    };
    // 必填但手动校验：citty 的 required 缺失走 internal（退出 1），这里按用法错退出 2
    if (args.host === undefined) {
      throw new PalError('invalid-input', '缺少 --host', {
        hint: `必须指定按哪个宿主的落点表物化：${harnessHint()}；用户面用 pal install --project <目录> --host <宿主>。`,
      });
    }
    const harness = parseInstallHost(args.host);
    const projectDir = resolve(String(args.project ?? '.'));
    let planned = false;
    try {
      const result = await installFromSource({
        source: String(args.source),
        projectDir,
        harness,
        ...(args.index ? { index: String(args.index) } : {}),
        ...(args.overwrite ? { overwrite: true } : {}),
        ...(args['allow-exec'] ? { allowExec: true } : {}),
        ...(args['allow-unsigned'] ? { allowUnsigned: true } : {}),
        ...(args['dry-run'] ? { dryRun: true } : {}),
        log,
        warn: (line) => {
          if (!args.json) console.error(`warn  ${line}`);
        },
        onPlan: (plan) => {
          planned = true;
          printPlanSummary(plan, log);
        },
      });
      if (!planned) printPlanSummary(result.plan, log);
      if (result.dryRun) log('\n（dry-run：没有落盘）');
      printIssues(result.issues, log);
      if (args.json) {
        console.log(
          JSON.stringify(
            {
              flow: result.flow,
              source: result.source,
              label: result.label,
              planHash: result.planHash,
              harness: result.plan.harness ?? null,
              dryRun: result.dryRun,
              ...(result.statePath ? { statePath: result.statePath } : {}),
              outcomes: result.outcomes,
              ...(result.verification ? { verification: result.verification } : {}),
              issues: result.issues,
            },
            null,
            2,
          ),
        );
      }
    } catch (err) {
      if (err instanceof InstallSourceError) {
        printIssues(err.issues, (line) => console.error(line));
        throw new PalError(err.failure === 'usage' ? 'invalid-input' : 'install-failed', err.message, {
          cause: err,
        });
      }
      throw err;
    }
  },
});

/* ---------- uninstall ---------- */

export const uninstallDir = defineCommand({
  meta: {
    name: 'uninstall',
    description: `按目录里的 ${STATE_FILE} 反向删掉已装文件`,
  },
  args: {
    dir: { type: 'positional', required: true, description: '已装过包的目录' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const state = requireInstalledState(dir);
    const result = removePack(dir);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    for (const path of result.removed) console.log(`  - ${path}`);
    for (const path of result.kept) console.log(`  = 保留 ${path}（还有别的包在用）`);
    console.log(`\n移除 ${result.removed.length} 个路径，涉及 ${result.packs.length} 个包（此前 ${Object.keys(state.packs).length} 个）`);
  },
});

/* ---------- verify ---------- */

export const verifyDir = defineCommand({
  meta: {
    name: 'verify',
    description: '体检一个已安装目录：漂移 + 清单检查 + 计划派生检查',
  },
  args: {
    dir: { type: 'positional', required: true, description: '已装过包的目录' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    requireInstalledState(dir);
    const drift = doctorPack(dir);
    const checks = await verifyAt(dir, {});
    printIssues(
      checks.issues.filter((i) => i.severity === 'warning'),
      (line) => console.error(line),
    );
    if (args.json) {
      // baseline 只在 verify --accept 时由命令层内部传入（不是 CLI 参数）：并进同一份 JSON
      const accepted = (args as Record<string, unknown>).baseline;
      const payload =
        accepted === undefined ? { dir, drift, checks } : { dir, baseline: JSON.parse(String(accepted)), drift, checks };
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log('漂移：已装记录 vs 磁盘');
      if (drift.packs.length === 0) {
        console.log('  这个目录没有装任何包');
      } else if (drift.ok) {
        console.log(`  ✓ ${drift.packs.length} 个包全部在位`);
      } else {
        for (const finding of drift.findings) {
          console.log(`  x ${finding.pack}`);
          for (const block of finding.blocksMissing) console.log(`      托管块不见了：${block}`);
          for (const file of finding.filesMissing) console.log(`      文件不见了：${file}`);
          for (const config of finding.configDrift) console.log(`      配置被改：${config}`);
          for (const active of finding.activeDrift) console.log(`      激活指针不一致：${active}`);
          for (const stateDir of finding.stateMissing) console.log(`      状态目录不见了：${stateDir}`);
          for (const mcp of finding.mcpMissing) console.log(`      MCP 不见了：${mcp}`);
        }
      }
      console.log('\n检查：清单 verify 项 + 从计划派生的项');
      if (!checks.ready) {
        console.log('  跳过（清单或计划有问题，见上面的错误）');
      } else if (checks.mode === 'installed') {
        for (const report of checks.installed) {
          console.log(`  ${report.pack}`);
          console.log(`    planHash ${report.planHash}`);
          for (const item of report.results) {
            const mark = item.status === 'pass' ? '✓' : item.status === 'fail' ? 'x' : '-';
            console.log(`    ${mark} [${item.index}] ${item.type.padEnd(18)} ${item.status.padEnd(8)} ${item.detail}`);
          }
        }
        console.log(`  ${checks.installed.length} 个包：${checks.failed} 项失败 / ${checks.skipped} 项跳过`);
      } else {
        for (const item of checks.results) {
          const mark = item.status === 'pass' ? '✓' : item.status === 'fail' ? 'x' : '-';
          console.log(`  ${mark} [${item.index}] ${item.type.padEnd(18)} ${item.status.padEnd(8)} ${item.detail}`);
        }
        console.log(
          `  ${checks.results.length} 项：${checks.results.length - checks.failed - checks.skipped} 通过 / ${checks.failed} 失败 / ${checks.skipped} 跳过`,
        );
      }
    }
    if (!checks.ready) {
      throw new PalError('invalid-input', '清单或计划有问题，见上面的错误');
    }
    if (!drift.ok || checks.failed > 0) {
      throw new PalError('install-failed', '体检未通过：有漂移或检查项失败');
    }
  },
});

/* ---------- rollback ---------- */

export const rollbackDir = defineCommand({
  meta: {
    name: 'rollback',
    description: '退回一个已安装目录的上一次安装之前',
  },
  args: {
    dir: { type: 'positional', required: true, description: '已装过包的目录' },
    generation: { type: 'string', description: '指定 generation（默认最近一次）' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const result = rollbackPack(dir, args.generation === undefined ? undefined : String(args.generation));
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`回退 ${result.generation}`);
    for (const path of result.restored) console.log(`  ↩ ${path}`);
    for (const path of result.removed) console.log(`  × ${path}`);
    console.log(`\n恢复 ${result.restored.length} 个文件，删除 ${result.removed.length} 个新建文件`);
  },
});

/* ---------- update 的目录分支 ---------- */

/**
 * `pal update --dir <path>`：按目录更新，读 state 里装的包与上次 harness，
 * 按 registry 最新版重装。这个入口是显式的：目录没装过包直接报用法错。
 */
export async function updateStateDir(
  target: string,
  opts: { index?: string; version?: string; json: boolean },
): Promise<void> {
  const dir = resolve(target);
  const state = loadState(dir);
  const keys = Object.keys(state.packs);
  if (keys.length === 0) {
    throw new PalError('invalid-input', `这个目录没有安装记录：${dir}（state 里没有包）`, {
      hint: '装进这个目录用 pal install --project <目录> --host <宿主>；要新建命名 home 就不给 target。',
    });
  }
  const indexRef = resolveRegistry(opts.index);
  if (!indexRef) {
    throw new PalError('invalid-input', '按目录更新需要一个 registry 索引', {
      hint: `加 --index <路径|URL|registry 名>，或设 ${PACKHUB_ENV.index}，或在配置里配 defaultRegistry。${INSTANCE_HINT}`,
    });
  }
  const names = [...new Set(keys.map((key) => key.slice(0, key.lastIndexOf('@'))))];
  const results: UpdateResult[] = [];
  for (const name of names) {
    const result = await updatePack({
      name,
      index: indexRef,
      projectDir: dir,
      ...(opts.version ? { version: opts.version } : {}),
    });
    results.push(result);
    if (opts.json) continue;
    console.log(`${result.changed ? '✓' : '·'} ${result.name}：${result.from ?? '(未装)'} → ${result.to}`);
    if (result.added.length > 0) console.log(`  + ${result.added.length} 个文件`);
    if (result.removed.length > 0) console.log(`  - ${result.removed.length} 个旧文件已清掉`);
    for (const warning of result.warnings) console.log(`  ! ${warning}`);
  }
  if (opts.json) console.log(JSON.stringify({ dir, results }, null, 2));
}
