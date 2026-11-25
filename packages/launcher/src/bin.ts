#!/usr/bin/env node
/**
 * pal 的入口：参数分派与错误展示都由这里定，不走 citty 的 runMain。
 * runMain 在内部 catch 里 consola.error(error, "\n") 打整段堆栈并直接 process.exit(1)，
 * 外层 .catch 永远执行不到：PalError 的 hint 丢了、invalid-input 退不到 2、普通用户看到调用栈。
 * 这里只借用它那三件事的做法（--version / --help 自己打，其余交给 runCommand），
 * 错误怎么打、退几由下面自己定。
 */
import { writeSync } from 'node:fs';
import { renderUsage, runCommand, type CommandDef, type CommandMeta, type SubCommandsDef } from 'citty';
import { main } from './cli.ts';
import { CORE_ENTRY, runCoreEntry } from './coreMain.ts';
import { PalError, errorBody } from './errors.ts';

const rawArgs = process.argv.slice(2);

/**
 * 旧 flag 不保留别名（v0 无兼容承诺）：`--into` / `--instance` 改名，`--environment` / `--harness` /
 * `--kind` / `--new` / `--app` 整个删掉。放在 runCommand 之前拦：citty 会静默忽略它不认识的参数，
 * 否则旧脚本会「看起来成功」。
 */
const RENAMED: Record<string, string> = { '--into': '--project', '--instance': '--home' };
const REMOVED: Record<string, string> = {
  '--environment': '已改名：用 --home（旧名不保留）；见 pal install --help。',
  '--harness': '已改名：用 --host（旧名不保留）；见 pal install --help。',
  '--kind': '已改名：用 --host（旧名不保留）；见 pal install --help。',
  '--new': '--new 已删除：不写 target 就是新建 managed 命名 home；装进已有目录用 --home。',
  '--app':
    '--app 已删除：启动方式改用模式。桌面 app 用 pal start <home> --mode app；' +
    'pal start <home> --list-modes 看这个宿主有哪些模式。',
};

function rejectRenamedFlags(): void {
  for (const arg of rawArgs) {
    if (!arg.startsWith('-')) continue;
    const name = arg.split('=')[0] ?? '';
    const now = RENAMED[name];
    if (now) {
      throw new PalError('invalid-input', `未知参数 ${name}`, {
        hint: `已改名：用 ${now}（旧名不保留）；三选一规则见 pal install --help。`,
      });
    }
    const removed = REMOVED[name];
    if (removed === undefined) continue;
    throw new PalError('invalid-input', `未知参数 ${name}`, { hint: removed });
  }
}

/** citty 的 meta / subCommands / 子命令定义都可能是函数或 Promise，统一解成值。 */
async function resolveValue<T>(
  value: T | Promise<T> | (() => T | Promise<T>) | undefined,
): Promise<T | undefined> {
  if (value === undefined) return undefined;
  return await (typeof value === 'function' ? (value as () => T | Promise<T>)() : value);
}

/**
 * 根帮助分组：命令名不变，只把命令按「对象」分块显示。
 * 子命令自己的 --help 仍用 citty 的 renderUsage（参数表由 citty 生成，避免两套）。
 */
const HELP_GROUPS: { title: string; names: string[] }[] = [
  {
    title: '安装（target = home / 项目）',
    names: ['install', 'uninstall', 'verify', 'rollback', 'update'],
  },
  {
    title: '环境',
    names: ['adopt', 'list', 'show', 'run', 'start', 'stop', 'restart', 'ps', 'health', 'logs', 'ui', 'use', 'current', 'remove', 'config'],
  },
  { title: '搬运', names: ['clone', 'migrate', 'export', 'import', 'backup', 'restore'] },
];

/** 一条命令的一行描述；meta 可能是函数 / Promise，按 citty 的规则先求值。 */
async function commandLine(name: string, sub: CommandDef | undefined): Promise<string> {
  const meta = sub ? await resolveValue<CommandMeta>(sub.meta) : undefined;
  return `  ${name.padEnd(12)} ${meta?.description ?? ''}`.trimEnd();
}

/** 根帮助：标题 + USAGE + 分组命令表。 */
async function groupedUsage(): Promise<string> {
  const meta = await resolveValue<CommandMeta>(main.meta);
  const subCommands = (await resolveValue<SubCommandsDef>(main.subCommands)) ?? {};
  const lines: string[] = [
    `${meta?.name ?? 'pal'} v${meta?.version ?? ''}`,
    '',
    meta?.description ?? '',
    '',
    `USAGE ${meta?.name ?? 'pal'} <command> [OPTIONS]`,
    '',
  ];
  for (const group of HELP_GROUPS) {
    lines.push(`${group.title}：`);
    for (const name of group.names) {
      const sub = await resolveValue<CommandDef>(subCommands[name]);
      lines.push(await commandLine(name, sub));
    }
    lines.push('');
  }
  lines.push(`Use ${meta?.name ?? 'pal'} <command> --help for more information about a command.`);
  return lines.join('\n');
}

/**
 * --help：打印用法（退出 0）。定位方式与 citty 的 resolveSubCommand 一致：
 * rawArgs 里第一个不以 - 开头的词就站在一级子命令的位置；它确实是 main.subCommands
 * 里的一个命令就打那个子命令的用法（标题为 `pal <命令>`），否则打分组的根帮助。
 */
async function printHelp(): Promise<void> {
  const word = rawArgs.find((arg) => !arg.startsWith('-'));
  const subCommands = (await resolveValue<SubCommandsDef>(main.subCommands)) ?? {};
  const sub = word ? await resolveValue<CommandDef>(subCommands[word]) : undefined;
  try {
    // 不用 citty 的 showUsage：它走 consola，输出流取决于报告器；这里直接写 stdout
    const usage = sub ? await renderUsage(sub, main) : await groupedUsage();
    writeSync(1, `${usage}\n`);
  } catch {
    // 渲染时也可能抛（meta 是函数时要先求值）；兜底只打命令名
    const meta = await resolveValue<CommandMeta>(main.meta).catch(() => undefined);
    writeSync(1, `${meta?.name ?? 'pal'}\n`);
  }
}

async function run(): Promise<void> {
  // core 的内部入口（隐藏动词，不是命令）：coreClient 的按需拉起与登录计划任务走这里，
  // 手打的 `pal core` 则是未知命令，help 里也没有它。
  if (rawArgs[0] === CORE_ENTRY) {
    await runCoreEntry(rawArgs.slice(1));
    return;
  }
  // 只有 --version 一个参数时才算「查版本」，和 citty 一致
  if (rawArgs.length === 1 && rawArgs[0] === '--version') {
    const meta = await resolveValue<CommandMeta>(main.meta);
    console.log(meta?.version ?? '');
    return;
  }
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    await printHelp();
    return;
  }
  // 不带命令：直接把帮助打出来（比 citty 的 "No command specified" 有用）
  if (rawArgs.length === 0) {
    await printHelp();
    return;
  }
  // 顶层出现未知选项：给可行动的话，别落到 citty 的 "No command specified"
  const first = rawArgs[0];
  if (first && first.startsWith('-')) {
    throw new PalError('invalid-input', `未知参数 ${first}`, {
      hint: '看命令：pal --help；列 home：pal list；某个命令的参数：pal <命令> --help',
    });
  }
  rejectRenamedFlags();
  await runCommand(main, { rawArgs });
}

/**
 * 失败出口：一行结论，有 hint 再补一行缩进的修法；不打堆栈，只有 PAL_DEBUG=1 才附上。
 * 退出码按错误语义给：invalid-input → 2，其余 → 1。
 * 用 writeSync 而不是 console.error：紧接着 process.exit，Windows 上管道里的异步写可能被截断。
 */
function fail(err: unknown): never {
  const body = errorBody(err);
  const lines = [`x ${body.error}`];
  if (body.hint) lines.push(`  ${body.hint}`);
  if (process.env.PAL_DEBUG === '1' && err instanceof Error && err.stack) lines.push(err.stack);
  writeSync(2, `${lines.join('\n')}\n`);
  process.exit(body.code === 'invalid-input' ? 2 : 1);
}

run().catch(fail);
