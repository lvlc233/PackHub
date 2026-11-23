// pal 的安装类命令：统一 target 模型 —— target = 目录（--into，项目级）或实例（--instance，全局环境）。
// install 还可以 --new 新建实例再装（原 pal create）；目录路径的实现仍在 dirCommands.ts。
import { defineCommand, type CommandDef } from 'citty';
import { materializePack } from '../materialize.ts';
import { installIntoInstance } from '../create.ts';
import { requireInstance, type InstanceRecord } from '../index.ts';
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
import { createCmd } from './instance.ts';

/** 直接复用 dirCommands 里的目录实现：参数补成它认识的形状，输出/退出码不变。 */
async function invoke(cmd: CommandDef<never>, args: Record<string, unknown>): Promise<void> {
  const run = cmd.run as ((ctx: { args: Record<string, unknown> }) => unknown) | undefined;
  if (run) await run({ args });
}

/** target 解析：--into / --instance（install 多一个 --new），必须恰好一个。 */
function parseTarget(
  args: { into?: unknown; instance?: unknown; new?: unknown },
  opts: { allowNew: boolean },
): 'dir' | 'instance' | 'new' {
  const picks: ('dir' | 'instance' | 'new')[] = [];
  if (args.into !== undefined) picks.push('dir');
  if (args.instance !== undefined) picks.push('instance');
  if (opts.allowNew && args.new === true) picks.push('new');
  const choices = opts.allowNew
    ? '--into <目录>（项目级）/ --instance <实例>（全局环境）/ --new（新建实例再装）'
    : '--into <目录>（项目级）/ --instance <实例>（全局环境）';
  if (picks.length === 0) {
    throw new PalError('invalid-input', '要指定 target 才能继续', { hint: `三选一：${choices}。` });
  }
  if (picks.length > 1) {
    throw new PalError('invalid-input', 'target 只能给一个', { hint: `三选一：${choices}。` });
  }
  return picks[0]!;
}

/** 实例级写操作要求实例已停。 */
function requireStopped(rec: InstanceRecord): void {
  if (rec.pid && isPidAlive(rec.pid)) {
    throw new PalError('invalid-input', `实例还在运行，先停掉：pid ${rec.pid}`, {
      hint: `pal stop ${rec.id}`,
    });
  }
}

const TARGET_SUMMARY = 'target = 目录（--into，项目级，只写这个目录）或实例（--instance，全局环境，写实例根）';

export const install = defineCommand({
  meta: {
    name: 'install',
    description:
      '安装到 target：目录（--into，项目级）或实例（--instance，全局环境）；--new 新建实例再装',
  },
  args: {
    source: {
      type: 'positional',
      required: true,
      description: 'Pack 目录、.phub、git+https，或配合 --index 用 registry 名（name 或 name@version）',
    },
    into: {
      type: 'string',
      description: '项目级 target：装到这个目录（不存在会创建）。与 --instance / --new 三选一',
    },
    instance: {
      type: 'string',
      description: '实例级 target：装进已有实例（必须已停且还是空实例）；已有包请用 pal update --instance',
    },
    new: {
      type: 'boolean',
      default: false,
      description: '新建一个实例再装（配 --kind / --name）；这是原 pal create 的行为',
    },
    harness: {
      type: 'string',
      description: '--into 必填：按哪个宿主的落点表物化（--new 用 --kind；--instance 从实例记录取，不填）',
    },
    kind: { type: 'string', description: '--new 用：新实例的宿主形态（默认 dsh）' },
    name: { type: 'string', description: '--new 用：新实例名（同名拒绝）' },
    index: { type: 'string', description: 'registry 索引（路径或 URL；也可用 PACKHUB_ENV.index）' },
    version: { type: 'string', description: 'registry 包的版本；不写用 latest' },
    root: { type: 'string', description: '--new 用：实例根（绝对路径；默认由系统分配）' },
    'from-home': {
      type: 'string',
      description: '--new 用：沿用已有宿主 home 的模型凭据与指令（例如 ~/.dsh）',
    },
    isolation: { type: 'string', description: '--new 用：这份实例的隔离策略 layer=mode,...' },
    'dry-run': { type: 'boolean', default: false, description: '只算计划，不落盘（--into / --instance）' },
    overwrite: { type: 'boolean', default: false, description: '允许覆盖别的包写过的普通文件（--into / --instance）' },
    'allow-exec': { type: 'boolean', default: false, description: '允许执行清单里的 install.exec（--into / --instance）' },
    'allow-unsigned': {
      type: 'boolean',
      default: false,
      description: '外部来源：即使配置了信任列表也接受无签名包（显式降低要求；--into）',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const target = parseTarget(args, { allowNew: true });
    const source = String(args.source);

    if (target === 'new') {
      if (args.kind === undefined) {
        throw new PalError('invalid-input', '使用 --new 需要 --kind', { hint: '例如 --new --kind dsh --name demo' });
      }
      if (args.name === undefined) {
        throw new PalError('invalid-input', '使用 --new 需要 --name', { hint: '例如 --new --kind dsh --name demo' });
      }
      await invoke(createCmd as unknown as CommandDef<never>, {
        pack: source,
        name: String(args.name),
        kind: String(args.kind),
        ...(args.index ? { index: String(args.index) } : {}),
        ...(args.version ? { version: String(args.version) } : {}),
        ...(args.root ? { root: String(args.root) } : {}),
        ...(args['from-home'] ? { 'from-home': String(args['from-home']) } : {}),
        ...(args.isolation ? { isolation: String(args.isolation) } : {}),
        json: Boolean(args.json),
      });
      return;
    }

    if (target === 'dir') {
      if (args.harness === undefined) {
        throw new PalError('invalid-input', '--into 需要 --harness', {
          hint: '目录是项目级 target，必须指定按哪个宿主的落点表物化；例如 --into ./proj --harness dsh。',
        });
      }
      await invoke(installDirCmd as unknown as CommandDef<never>, {
        source,
        into: String(args.into),
        harness: String(args.harness),
        ...(args.index ? { index: String(args.index) } : {}),
        'dry-run': Boolean(args['dry-run']),
        overwrite: Boolean(args.overwrite),
        'allow-exec': Boolean(args['allow-exec']),
        'allow-unsigned': Boolean(args['allow-unsigned']),
        json: Boolean(args.json),
      });
      return;
    }

    if (args.harness !== undefined) {
      throw new PalError('invalid-input', '--harness 只用于 --into / --new', {
        hint: '实例级装到哪个宿主由实例记录决定；要换宿主请新建实例。',
      });
    }
    const rec = requireInstance(String(args.instance));
    const log = (line: string): void => {
      if (!args.json) console.error(line);
    };
    const packDir = await materializePack(source, {
      ...(args.index ? { index: String(args.index) } : {}),
      ...(args.version ? { version: String(args.version) } : {}),
      log,
    });
    const result = await installIntoInstance(rec.id, {
      packDir,
      packRef: source,
      ...(args.overwrite ? { overwrite: true } : {}),
      ...(args['allow-exec'] ? { allowExec: true } : {}),
      ...(args['dry-run'] ? { dryRun: true } : {}),
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
    console.log(`✓ ${result.record.id}`);
    console.log(`  ${result.record.root}`);
    console.log(`  pack ${result.record.pack.name}@${result.record.pack.version}`);
  },
});

export const uninstall = defineCommand({
  meta: {
    name: 'uninstall',
    description:
      '卸载 target 里装的包：--into <目录>（项目级）或 --instance <实例>（全局环境）；实例必须已停',
  },
  args: {
    into: { type: 'string', description: '项目级 target：已装过包的目录' },
    instance: { type: 'string', description: '实例级 target：实例名/id（必须已停）' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const target = parseTarget(args, { allowNew: false });
    if (target === 'dir') {
      await invoke(uninstallDirCmd as unknown as CommandDef<never>, {
        dir: String(args.into),
        json: Boolean(args.json),
      });
      return;
    }
    const rec = requireInstance(String(args.instance));
    requireStopped(rec);
    await invoke(uninstallDirCmd as unknown as CommandDef<never>, {
      dir: rec.root,
      json: Boolean(args.json),
    });
  },
});

export const verify = defineCommand({
  meta: {
    name: 'verify',
    description:
      '体检 target：--into <目录>（项目级）或 --instance <实例>（全局环境）；漂移 + 清单检查 + 计划派生检查（实例可运行）',
  },
  args: {
    into: { type: 'string', description: '项目级 target：已装过包的目录' },
    instance: { type: 'string', description: '实例级 target：实例名/id（可运行）' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const target = parseTarget(args, { allowNew: false });
    const dir =
      target === 'dir' ? String(args.into) : requireInstance(String(args.instance)).root;
    await invoke(verifyDirCmd as unknown as CommandDef<never>, { dir, json: Boolean(args.json) });
  },
});

export const rollback = defineCommand({
  meta: {
    name: 'rollback',
    description:
      '退回 target 的上一次安装之前：--into <目录>（项目级）或 --instance <实例>（全局环境）；实例必须已停',
  },
  args: {
    into: { type: 'string', description: '项目级 target：已装过包的目录' },
    instance: { type: 'string', description: '实例级 target：实例名/id（必须已停）' },
    generation: { type: 'string', description: '指定 generation（默认最近一次）' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const target = parseTarget(args, { allowNew: false });
    let dir: string;
    if (target === 'dir') {
      dir = String(args.into);
    } else {
      const rec = requireInstance(String(args.instance));
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
      '把 target 里的 Pack 换成 registry 最新版：--into <目录>（项目级）或 --instance <实例>（全局环境）；实例必须已停',
  },
  args: {
    into: { type: 'string', description: '项目级 target：已装过包的目录' },
    instance: { type: 'string', description: '实例级 target：实例名/id（必须已停）' },
    version: { type: 'string', description: 'registry 版本；不写用 latest' },
    index: { type: 'string', description: 'registry 索引；不写用默认索引' },
    force: {
      type: 'boolean',
      default: false,
      description: '实例级：覆盖本地改过的文件；不带时若 Pack 写过的文件被本地改过就拒绝更新',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const target = parseTarget(args, { allowNew: false });
    if (target === 'dir') {
      await updateStateDir(String(args.into), {
        ...(args.index ? { index: String(args.index) } : {}),
        ...(args.version ? { version: String(args.version) } : {}),
        json: Boolean(args.json),
      });
      return;
    }

    const rec = requireInstance(String(args.instance));
    requireStopped(rec);
    const ref = rec.pack.ref ?? rec.pack.name;
    const log = (line: string): void => {
      if (!args.json) console.error(line);
    };
    const result = await updateFromRef({
      idOrName: rec.id,
      packRef: ref,
      ...(args.index ? { index: String(args.index) } : {}),
      ...(args.version ? { version: String(args.version) } : {}),
      ...(args.force ? { force: true } : {}),
      log,
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`${result.changed ? '✓' : '·'} ${result.from} → ${result.to}`);
    if (result.addedFiles.length > 0) console.log(`  + ${result.addedFiles.length} 个文件`);
    if (result.removedFiles.length > 0) console.log(`  - ${result.removedFiles.length} 个旧文件已清掉`);
    for (const file of result.removedFiles.slice(0, 10)) console.log(`    ${file}`);
    if (result.localChanges.length > 0) {
      console.log(`  ! ${result.localChanges.length} 个文件在改之前被本地改过，现在是新版本的内容；要保留请先备份`);
    }
    if (result.warnings.length > 0) {
      console.log(`  ! ${result.warnings.length} 个旧文件没删掉（更新已完成，这些文件还留在实例里）`);
      for (const line of result.warnings.slice(0, 10)) console.log(`    ${line}`);
      if (result.warnings.length > 10) console.log(`    … 还有 ${result.warnings.length - 10} 条`);
    }
  },
});
