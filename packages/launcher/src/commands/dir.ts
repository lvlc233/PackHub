// pal 的安装类命令：统一 target 模型 ——
//   install 默认在 PAL 数据目录建一个 managed 命名 home；`--home` 装进宿主的真实全局目录（attached）；
//   `--project` 装进宿主会打开的项目目录。
//   uninstall / verify / rollback / update 用 `--home <名字|路径>` 或 `--project <目录>`。
// 目录路径的实现仍在 dirCommands.ts，命令层只做 target 解析与文案。
import { defineCommand, type CommandDef } from 'citty';
import { defaultLaunchMode, harness, harnessIds, harnesses, type HarnessId } from '@packhub/kernel';
import { loadState } from '@packhub/runtime';
import { materializePack, readPackIdentity } from '../materialize.ts';
import {
  createInstance,
  defaultHomeName,
  installIntoInstance,
  previewHomePlan,
  type CreateInstanceOptions,
} from '../create.ts';
import {
  findInstanceByRoot,
  readRecord,
  requireInstance,
  writeInstance,
  type InstanceRecord,
} from '../index.ts';
import { isPidAlive } from '../process.ts';
import { updateFromRef } from '../service.ts';
import {
  installDir as installDirCmd,
  printPlanSummary,
  rollbackDir as rollbackDirCmd,
  uninstallDir as uninstallDirCmd,
  updateStateDir,
  verifyDir as verifyDirCmd,
} from '../dirCommands.ts';
import { PalError } from '../errors.ts';
import { acceptBaseline } from './other.ts';
import { discoverAll } from '../harness.ts';
import { assertAttachedSupported } from '../layout.ts';
import {
  assertHomeNameFree,
  assertProfileName,
  assertProfileTarget,
  homePathInput,
  hostArg,
  resolveAttachedName,
} from '../validators.ts';

/** 直接复用 dirCommands 里的目录实现：参数补成它认识的形状，输出/退出码不变。 */
async function invoke(cmd: CommandDef<never>, args: Record<string, unknown>): Promise<void> {
  const run = cmd.run as ((ctx: { args: Record<string, unknown> }) => unknown) | undefined;
  if (run) await run({ args });
}

/* ---------- install 的 target ---------- */

type InstallTarget = 'managed' | 'attached' | 'project';

const TARGET_HINT =
  '三选一：不写 target（默认：在数据目录建一个命名 home）/ --home <路径>（attached home：宿主的真实全局目录）/ --project <目录>（项目）';

/** install 的 target：--home / --project 互斥，都不给 = 默认命名 home。 */
function parseInstallTarget(args: { home?: unknown; project?: unknown }): InstallTarget {
  const picks: InstallTarget[] = [];
  if (args.home !== undefined) picks.push('attached');
  if (args.project !== undefined) picks.push('project');
  if (picks.length > 1) {
    throw new PalError('invalid-input', 'target 只能给一个', { hint: TARGET_HINT });
  }
  return picks[0] ?? 'managed';
}

/** uninstall / verify / rollback / update 的 target：--home 或 --project，必须给一个。 */
type HomeTarget = 'home' | 'project';

function parseTarget(args: { home?: unknown; project?: unknown }): HomeTarget {
  if (args.home !== undefined && args.project !== undefined) {
    throw new PalError('invalid-input', 'target 只能给一个', {
      hint: '二选一：--home <路径|名字>（managed / attached home）或 --project <目录>（项目）',
    });
  }
  if (args.project !== undefined) return 'project';
  if (args.home !== undefined) return 'home';
  throw new PalError('invalid-input', '要指定 target 才能继续', {
    hint: '二选一：--home <路径|名字>（managed / attached home）或 --project <目录>（项目）',
  });
}

/** 按 target 找 home：先按名字/id，再按根路径（Windows 大小写不敏感）。 */
function requireHome(raw: unknown): InstanceRecord {
  const text = String(raw ?? '').trim();
  if (!text) {
    throw new PalError('invalid-input', '--home 不能为空', {
      hint: 'managed home 用名字；attached home 用名字或路径',
    });
  }
  const byName = requireInstanceOrUndefined(text);
  if (byName) return byName;
  let path: string | undefined;
  try {
    path = homePathInput(text);
  } catch {
    path = undefined;
  }
  if (path !== undefined) {
    const byRoot = findInstanceByRoot(path);
    if (byRoot) return byRoot;
  }
  throw new PalError('unknown-instance', `没有这个 home：${text}`, {
    hint: 'pal list 看现有 home；managed home 用名字，attached home 也可以用路径',
    details: { home: text },
  });
}

function requireInstanceOrUndefined(nameOrId: string): InstanceRecord | undefined {
  try {
    return requireInstance(nameOrId);
  } catch {
    return undefined;
  }
}

/** home 级写操作要求已停；attached 与 managed 同规则。 */
function requireStopped(rec: InstanceRecord): void {
  if (rec.pid && isPidAlive(rec.pid)) {
    throw new PalError('invalid-input', `home 还在运行，先停掉：pid ${rec.pid}`, {
      hint: `pal stop ${rec.id}`,
    });
  }
}

/**
 * uninstall / verify 的 `--profile`：只对 dsh attached 有意义，只用来核对记录里的选择。
 * 这两个命令按 state.written 干活，profile 不能收窄它们；记录里写的是别的 profile 就退 2，
 * 免得让人以为换个 profile 就能只处理那一份。换安装范围是 update 的事。
 */
function requireRecordedProfile(rec: InstanceRecord, profile: string | undefined): void {
  if (profile === undefined) return;
  assertProfileTarget(rec.harness, rec.attached === true);
  if (rec.profile !== undefined && rec.profile !== profile) {
    throw new PalError('invalid-input', `这个 home 是按 profile「${rec.profile}」装的，不是「${profile}」`, {
      hint:
        `漂移 / 卸载按 state 里的安装记录走，不按 profile 收窄；要换安装范围用 ` +
        `pal update --home ${rec.name} --profile ${profile}（摘旧 profile 的条目、写新的）`,
    });
  }
}

/** install 成功后给下一步：默认模式是前台就用 run（= start --mode <默认前台模式>），否则用 start。 */
function nextLine(host: HarnessId, name: string): string {
  const spec = harness(host);
  const mode = spec ? defaultLaunchMode(spec) : undefined;
  return mode?.kind === 'foreground' ? `pal run ${name}` : `pal start ${name}`;
}

function printInstalled(rec: InstanceRecord, pack: { name: string; version: string }, note?: string): void {
  console.log(`✓ ${rec.name}`);
  console.log(`  ${rec.root}`);
  console.log(`  pack ${pack.name}@${pack.version}`);
  if (note) console.log(`  · ${note}`);
  console.log(`next: ${nextLine(rec.harness, rec.name)}`);
}

/** 默认名要 Pack 的 metadata.name；读不到就按用法错停在取包之后、写盘之前。 */
function requirePackName(packDir: string): string {
  const name = readPackIdentity(packDir).name;
  if (!name) {
    throw new PalError('invalid-input', '清单有问题：读不到 metadata.name', {
      hint: '确认 Pack 目录里有 packhub.yaml，且清单能被解析',
      details: { packDir },
    });
  }
  return name;
}

/** attached 支持列表：从注册表现查，加宿主不用改这里的文案。 */
function attachedHostsLabel(): string {
  return harnesses()
    .filter((spec) => spec.attached === true)
    .map((spec) => spec.id)
    .join(' / ');
}

export const install = defineCommand({
  meta: {
    name: 'install',
    description:
      '装进 home 或项目：默认在数据目录建 managed 命名 home；--home 装进宿主真实全局目录（attached）；--project 装进项目。三种 target 都要 --host',
  },
  args: {
    source: {
      type: 'positional',
      required: true,
      description: 'Pack 目录、.phub、git+https，或配合 --index 用 registry 名（name 或 name@version）',
    },
    host: {
      type: 'string',
      description: `按哪个宿主的落点装（必填）：${harnessIds().join(' / ')}`,
    },
    name: {
      type: 'string',
      description: `home 的名字（默认 <host>-<packSlug>）；只能配默认 target 与 --home，--project 不能用`,
    },
    home: {
      type: 'string',
      description: `attached home：宿主的真实全局目录（存在或新建；~ 会展开成你的 home）；支持 attached 的宿主：${attachedHostsLabel()}`,
    },
    project: {
      type: 'string',
      description: '项目级 target：宿主会打开的项目目录（不存在会创建）',
    },
    root: {
      type: 'string',
      description:
        'managed home 的根目录（默认 PAL 数据目录；必须绝对路径，不能与 --home / --project 同用）',
    },
    profile: {
      type: 'string',
      description:
        '只对 --host dsh 的 --home（attached dsh home）有意义：只装这一个 profile（<home>/profiles/<名字>/cordis.patch.yml）；不写 = 所有已有 profile，一个都没有会报错（先启动一次 dsh 生成 profile）',
    },
    'from-home': {
      type: 'string',
      description:
        'managed 专用：把这个宿主已有全局目录里 credentialFiles 登记的凭据带到新 home（attached 直接用全局目录，不需要）',
    },
    index: { type: 'string', description: 'registry 索引（路径或 URL；也可用 PACKHUB_ENV.index）' },
    version: { type: 'string', description: 'registry 包的版本；不写用 latest' },
    'dry-run': { type: 'boolean', default: false, description: '只算计划，不落盘' },
    overwrite: {
      type: 'boolean',
      default: false,
      description: '允许覆盖别的包写过的普通文件',
    },
    'allow-exec': {
      type: 'boolean',
      default: false,
      description: '允许执行清单里的 install.exec',
    },
    'allow-unsigned': {
      type: 'boolean',
      default: false,
      description: '外部来源：即使配置了信任列表也接受无签名包（显式降低要求）',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const target = parseInstallTarget(args);
    const hostId = hostArg(args.host, 'install');
    // --profile 只对 dsh 的 attached home 有意义：先校验，别等取完包才发现是用法错
    const profile = args.profile === undefined ? undefined : assertProfileName(args.profile);
    if (profile !== undefined) assertProfileTarget(hostId, target === 'attached');
    if (target === 'project' && args.name !== undefined) {
      throw new PalError('invalid-input', '--name 只用于 managed / attached home', {
        hint: '--project 装的是宿主会打开的项目目录，没有 home 名；要命名 home 就别给 --project',
      });
    }
    // --from-home 是 managed 的「沿用全局凭据」：attached 的 home 就是全局目录，项目没有 home
    if (args['from-home'] !== undefined && target !== 'managed') {
      throw new PalError('invalid-input', '--from-home 只能配默认 target（managed 命名 home）', {
        hint:
          target === 'attached'
            ? 'attached 直接装进宿主的全局目录，凭据本来就在那里，不需要 --from-home'
            : '--project 只写项目文件，没有 home 段可以放凭据',
      });
    }
    const fromHome =
      args['from-home'] === undefined ? undefined : homePathInput(args['from-home'], '--from-home 的目录');
    const source = String(args.source);
    if (args.root !== undefined && target !== 'managed') {
      throw new PalError('invalid-input', '--root 只能配默认 target（managed 命名 home）', {
        hint: 'attached 用 --home 指定目录；项目用 --project 指定项目目录',
      });
    }
    const homeRoot =
      args.root === undefined ? undefined : homePathInput(String(args.root), '--root 的目录');

    if (target === 'project') {
      const projectDir = String(args.project);
      // pointer：项目里只写指路块，技能不注册进项目（要注册技能得装进 home）
      if (harness(hostId)?.project === 'pointer' && !args.json) {
        console.error(
          `warn  ${hostId} 的 skill 是全局的：项目内只写指路块，不注册 skill；要注册用 pal install <pack> --host ${hostId}（命名 home）`,
        );
      }
      // 没有项目级落点的宿主在这里挡住：给的是 PAL 的说法，不是 runtime 的旧参数
      if (harness(hostId)?.project === false) {
        throw new PalError('invalid-input', `宿主 ${hostId} 没有项目级安装落点`, {
          hint: `用 pal install <pack> --host ${hostId}（默认命名 home）或 --home <路径>`,
        });
      }
      await invoke(installDirCmd as unknown as CommandDef<never>, {
        source,
        project: projectDir,
        host: hostId,
        ...(args.index ? { index: String(args.index) } : {}),
        'dry-run': Boolean(args['dry-run']),
        overwrite: Boolean(args.overwrite),
        'allow-exec': Boolean(args['allow-exec']),
        'allow-unsigned': Boolean(args['allow-unsigned']),
        json: Boolean(args.json),
      });
      if (!args.json && !args['dry-run']) console.log(`next: 在宿主里打开 ${projectDir}`);
      return;
    }

    // attached 的路径与宿主支持在取包之前就查掉：不支持的宿主不必先下载
    const attachedHome = target === 'attached' ? homePathInput(args.home) : undefined;
    if (attachedHome !== undefined) assertAttachedSupported(hostId);

    const log = (line: string): void => {
      if (!args.json) console.error(line);
    };
    const packDir = await materializePack(source, {
      ...(args.index ? { index: String(args.index) } : {}),
      ...(args.version ? { version: String(args.version) } : {}),
      log,
    });
    const packName = requirePackName(packDir);
    const dryRun = Boolean(args['dry-run']);

    if (target === 'attached' && attachedHome !== undefined) {
      // 已经登记过（adopt 或之前装过）的 attached home：装进同一份记录，不另起一份
      const existing = findInstanceByRoot(attachedHome);
      if (existing) {
        if (existing.attached !== true) {
          throw new PalError('invalid-input', `这个目录是一份 managed home：${existing.name}`, {
            hint: `换版本用 pal update --home ${existing.name}；要装进别的目录就换 --home`,
          });
        }
        if (existing.harness !== hostId) {
          throw new PalError('invalid-input', `这个 home 登记为 ${existing.harness}，不能按 ${hostId} 安装`, {
            hint: '换 --host，或用 --name 建/接管另一个 home',
          });
        }
        if (args.name !== undefined && String(args.name).trim() !== existing.name) {
          throw new PalError('invalid-input', `这个 home 已经叫 ${existing.name}`, {
            hint: `改名用 pal config ${existing.name} --name <新名字>`,
          });
        }
        const result = await installIntoInstance(existing.id, {
          packDir,
          packRef: source,
          ...(profile ? { profile } : {}),
          ...(args.overwrite ? { overwrite: true } : {}),
          ...(args['allow-exec'] ? { allowExec: true } : {}),
          ...(dryRun ? { dryRun: true } : {}),
        });
        if (args.json) {
          console.log(
            JSON.stringify(
              result.dryRun
                ? { plan: result.plan, outcomes: result.outcomes, dryRun: true }
                : { ...result.record, outcomes: result.outcomes },
              null,
              2,
            ),
          );
          return;
        }
        if (result.dryRun) {
          printPlanSummary(result.plan, (line) => console.log(line));
          console.log('\n（dry-run：没有落盘）');
          return;
        }
        printInstalled(result.record, result.record.pack!);
        return;
      }

      // 默认名冲突自动区分：<base> → <base>-attached；显式 --name 冲突仍退 2
      const base = args.name === undefined ? defaultHomeName(hostId, packName) : String(args.name).trim();
      const nameInfo = resolveAttachedName(base, args.name !== undefined);
      const name = nameInfo.name;
      const nameNote = nameInfo.adjusted ? `默认名 ${nameInfo.base} 已存在，改用 ${name}` : undefined;
      if (dryRun) {
        const plan = previewHomePlan({
          packDir,
          harness: hostId,
          attachedHome,
          ...(profile ? { profile } : {}),
        });
        if (args.json) console.log(JSON.stringify({ plan, dryRun: true, name }, null, 2));
        else {
          printPlanSummary(plan, (line) => console.log(line));
          console.log(`\n（dry-run：没有落盘；name ${name}${nameNote ? `；${nameNote}` : ''}）`);
        }
        return;
      }
      const opts: CreateInstanceOptions = {
        name,
        harness: hostId,
        packDir,
        packRef: source,
        attachedHome,
        ...(profile ? { profile } : {}),
        onWarn: log,
      };
      const rec = await createInstance(opts);
      if (args.json) {
        console.log(JSON.stringify(rec, null, 2));
        return;
      }
      printInstalled(rec, rec.pack!, nameNote);
      return;
    }

    // 默认 target：managed 命名 home（PAL 数据目录）
    const name = args.name === undefined ? defaultHomeName(hostId, packName) : String(args.name).trim();
    if (dryRun) {
      const plan = previewHomePlan({ packDir, harness: hostId });
      if (args.json) console.log(JSON.stringify({ plan, dryRun: true }, null, 2));
      else {
        printPlanSummary(plan, (line) => console.log(line));
        console.log(`\n（dry-run：没有落盘；name ${name}）`);
      }
      return;
    }
    assertHomeNameFree(name);
    const info = discoverAll({ probeVersion: false }).find((h) => h.id === hostId);
    const rec = await createInstance({
      name,
      harness: hostId,
      packDir,
      packRef: source,
      ...(homeRoot ? { root: homeRoot } : {}),
      ...(info?.version ? { harnessVersion: info.version } : {}),
      ...(fromHome ? { fromHome } : {}),
      onWarn: log,
    });
    if (args.json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    printInstalled(rec, rec.pack!);
  },
});

/**
 * 卸载成功后让实例记录跟 state 一致。
 *
 * `pal uninstall` 摘的是 state 里的安装记录；home 自己的 `instance.json` 不是 state，不会跟着变。
 * 卸载干净（state 里已经没有包）时，记录里这些字段只在有包时才有意义，一起摘掉：
 * - `pack`：包身份（名称/版本/引用）；
 * - `harnessVersion`：装包那一刻探测的宿主版本；
 * - `profile`：dsh attached 那次安装选的 profile 范围；
 * - `origin.kind === 'pack'`：这份 home 是从哪个 Pack 引用装的（模板复现的依据）。
 *
 * 还有别的包（多 Pack 的接管目录）就保留记录；坏记录不在这里改写——那归隔离区，别盖成半份。
 */
function syncInstanceAfterUninstall(dir: string): void {
  if (Object.keys(loadState(dir).packs).length > 0) return;
  const rec = readRecord(dir);
  if (!rec) return;
  const stale =
    rec.pack !== undefined ||
    rec.harnessVersion !== undefined ||
    rec.profile !== undefined ||
    rec.origin?.kind === 'pack';
  if (!stale) return;
  const next: InstanceRecord = { ...rec };
  delete next.pack;
  delete next.harnessVersion;
  delete next.profile;
  if (next.origin?.kind === 'pack') delete next.origin;
  writeInstance(next);
}

export const uninstall = defineCommand({
  meta: {
    name: 'uninstall',
    description:
      '卸载 target 里装的包：--home <路径|名字>（managed / attached home）或 --project <目录>；home 必须已停',
  },
  args: {
    project: { type: 'string', description: '项目级 target：已装过包的项目目录' },
    home: { type: 'string', description: 'home target：managed 用名字，attached 用路径或名字（必须已停）' },
    profile: {
      type: 'string',
      description:
        '只对 --home 的 dsh attached home 有意义：核对记录里的 profile；卸载按 state.written 摘，不需要它',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const target = parseTarget(args);
    const profile = args.profile === undefined ? undefined : assertProfileName(args.profile);
    if (profile !== undefined && target !== 'home') assertProfileTarget('', false);
    let dir: string;
    if (target === 'project') {
      dir = String(args.project);
    } else {
      const rec = requireHome(args.home);
      if (profile !== undefined) requireRecordedProfile(rec, profile);
      requireStopped(rec);
      dir = rec.root;
    }
    await invoke(uninstallDirCmd as unknown as CommandDef<never>, {
      dir,
      json: Boolean(args.json),
    });
    // 摘干净之后实例记录也要认账：否则 list/show/更新/卸载继续宣称装着（P0-1）
    syncInstanceAfterUninstall(dir);
  },
});

export const verify = defineCommand({
  meta: {
    name: 'verify',
    description:
      '体检 target：--home <路径|名字>（managed / attached home）或 --project <目录>；漂移 + 清单检查 + 计划派生检查（home 可运行）；--accept 把 home 当前磁盘状态认作基线',
  },
  args: {
    project: { type: 'string', description: '项目级 target：已装过包的项目目录' },
    home: { type: 'string', description: 'home target：managed 用名字，attached 用路径或名字（可运行）' },
    accept: {
      type: 'boolean',
      default: false,
      description:
        'home target：把当前磁盘状态认作基线（接受本地改动），之后体检不再报漂移；项目没有基线，不能用',
    },
    profile: {
      type: 'string',
      description:
        '只对 --home 的 dsh attached home 有意义：核对这次体检的 profile（不写用记录里的）；漂移仍按 state 里的安装记录走',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const target = parseTarget(args);
    const profile = args.profile === undefined ? undefined : assertProfileName(args.profile);
    if (profile !== undefined && target !== 'home') assertProfileTarget('', false);
    if (target === 'project') {
      if (args.accept) {
        throw new PalError('invalid-input', '项目没有基线，--accept 只用于 home', {
          hint: '项目体检看漂移与检查项；要接受 home 里的本地改动，用 pal verify --home <名字|路径> --accept。',
        });
      }
      await invoke(verifyDirCmd as unknown as CommandDef<never>, {
        dir: String(args.project),
        json: Boolean(args.json),
      });
      return;
    }
    const rec = requireHome(args.home);
    if (profile !== undefined) requireRecordedProfile(rec, profile);
    if (!args.accept) {
      await invoke(verifyDirCmd as unknown as CommandDef<never>, {
        dir: rec.root,
        json: Boolean(args.json),
      });
      return;
    }
    const baseline = acceptBaseline(rec.id);
    if (!args.json) {
      console.log(`✓ 基线已更新：${baseline.files.length} 个文件（${baseline.pack}@${baseline.version}）`);
    }
    // --json：baseline 交给 verifyDir 并进同一份 JSON，stdout 上不留两段 JSON
    await invoke(verifyDirCmd as unknown as CommandDef<never>, {
      dir: rec.root,
      json: Boolean(args.json),
      baseline: JSON.stringify(baseline),
    });
  },
});

export const rollback = defineCommand({
  meta: {
    name: 'rollback',
    description:
      '退回 target 的上一次安装之前：--home <路径|名字>（managed / attached home）或 --project <目录>；home 必须已停',
  },
  args: {
    project: { type: 'string', description: '项目级 target：已装过包的项目目录' },
    home: { type: 'string', description: 'home target：managed 用名字，attached 用路径或名字（必须已停）' },
    generation: { type: 'string', description: '指定 generation（默认最近一次）' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const target = parseTarget(args);
    let dir: string;
    if (target === 'project') {
      dir = String(args.project);
    } else {
      const rec = requireHome(args.home);
      requireStopped(rec);
      dir = rec.root;
    }
    await invoke(rollbackDirCmd as unknown as CommandDef<never>, {
      dir,
      ...(args.generation === undefined ? {} : { generation: String(args.generation) }),
      json: Boolean(args.json),
    });
  },
});

export const update = defineCommand({
  meta: {
    name: 'update',
    description:
      '把 target 里的 Pack 换成 registry 最新版：--home <路径|名字>（managed / attached home）或 --project <目录>；home 必须已停',
  },
  args: {
    project: { type: 'string', description: '项目级 target：已装过包的项目目录' },
    home: { type: 'string', description: 'home target：managed 用名字，attached 用路径或名字（必须已停）' },
    version: { type: 'string', description: 'registry 版本；不写用 latest' },
    index: { type: 'string', description: 'registry 索引；不写用默认索引' },
    force: {
      type: 'boolean',
      default: false,
      description: 'home 级：覆盖本地改过的文件；不带时若 Pack 写过的文件被本地改过就拒绝更新',
    },
    profile: {
      type: 'string',
      description:
        '只对 --home 的 dsh attached home 有意义：把安装范围换成这个 profile（摘掉旧 profile 的 pal-mcp-* 条目、写进新的，记录一起改）；不写沿用记录里的，--profile all 显式切回全部已有 profile；profile 不存在退 2',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const target = parseTarget(args);
    const profile = args.profile === undefined ? undefined : assertProfileName(args.profile);
    if (profile !== undefined && target !== 'home') assertProfileTarget('', false);
    if (target === 'project') {
      await updateStateDir(String(args.project), {
        ...(args.index ? { index: String(args.index) } : {}),
        ...(args.version ? { version: String(args.version) } : {}),
        json: Boolean(args.json),
      });
      return;
    }

    const rec = requireHome(args.home);
    requireStopped(rec);
    // 记录里没有包、或 state 里已经没有包：没有东西可更新。在取包之前就报，
    // 不装一次再空跑成功（P0-1 的「更新还能成功一次什么也没写」）。
    const pack = rec.pack;
    if (!pack || Object.keys(loadState(rec.root).packs).length === 0) {
      throw new PalError('invalid-input', `这个目录没有安装记录：${rec.root}（state 里没有包）`, {
        hint: `装包用 pal install <pack> --home ${rec.root}；pal list 看现有 home`,
      });
    }
    if (profile !== undefined) assertProfileTarget(rec.harness, rec.attached === true);
    const ref = pack.ref ?? pack.name;
    const log = (line: string): void => {
      if (!args.json) console.error(line);
    };
    const result = await updateFromRef({
      idOrName: rec.id,
      packRef: ref,
      ...(args.index ? { index: String(args.index) } : {}),
      ...(args.version ? { version: String(args.version) } : {}),
      ...(args.force ? { force: true } : {}),
      ...(profile ? { profile } : {}),
      log,
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`${result.changed ? '✓' : '·'} ${result.from} → ${result.to}`);
    if (result.profileChange) {
      const from = result.profileChange.from ?? 'all';
      const to = result.profileChange.to ?? 'all';
      console.log(`  profile：${from} → ${to}`);
    }
    if (result.addedFiles.length > 0) console.log(`  + ${result.addedFiles.length} 个文件`);
    if (result.removedFiles.length > 0) console.log(`  - ${result.removedFiles.length} 个旧文件已清掉`);
    for (const file of result.removedFiles.slice(0, 10)) console.log(`    ${file}`);
    if (result.localChanges.length > 0) {
      console.log(`  ! ${result.localChanges.length} 个文件在改之前被本地改过，现在是新版本的内容；要保留请先备份`);
    }
    if (result.warnings.length > 0) {
      console.log(`  ! ${result.warnings.length} 条提示（更新已完成）`);
      for (const line of result.warnings.slice(0, 10)) console.log(`    ${line}`);
      if (result.warnings.length > 10) console.log(`    … 还有 ${result.warnings.length - 10} 条`);
    }
  },
});
