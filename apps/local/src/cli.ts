import pkg from '../../../package.json' with { type: 'json' };
import type { CommandDef } from 'citty';
import { EXIT, command, problemRaw, say, stop } from './emit.ts';
import {
  plan,
  install,
  verify,
  lock,
  init,
  rollback,
  versions,
  activate,
  uninstall,
  diff,
} from './commands/plan-install.ts';
import { add, update, sync } from './commands/add-update.ts';
import { run, publish, probe, pack } from './commands/pack.ts';
import {
  trustAdd,
  trustRemove,
  trustList,
  trustRequire,
  trust,
  authSet,
  authList,
  authRemove,
  authRotate,
  auth,
  keygen,
  sign,
  verifySig,
} from './commands/trust-auth.ts';
import {
  marketServe,
  marketRegisterCmd,
  marketLoginCmd,
  marketPublishCmd,
  marketSearchCmd,
  marketRateCmd,
  marketYankCmd,
  marketWhoami,
  market,
  search,
  cacheLs,
  cacheClean,
  cache,
  discover,
  hub,
} from './commands/registry-market.ts';
import { audit, doctor, licenses } from './commands/doctor-license.ts';
import { resourceAdd, resource, slotSwap, slot } from './commands/misc.ts';

// completion 要读 main.subCommands，main 又在这里组装：留在同一个文件，避免循环依赖。
const completion = command({
  meta: { name: 'completion', description: '输出 shell 补全脚本（bash / zsh / pwsh，含子命令与参数）' },
  args: {
    shell: { type: 'positional', required: true, description: 'bash | zsh | pwsh' },
  },
  run({ args }) {
    type Cmd = { args?: Record<string, unknown>; subCommands?: Record<string, Cmd> };
    const commands = Object.entries((main.subCommands ?? {}) as Record<string, Cmd>)
      .filter(([n]) => n !== 'completion')
      .sort(([a], [b]) => a.localeCompare(b));
    const names = commands.map(([n]) => n);
    // 每个命令的可补内容：自己的参数 + 子命令名
    const optionsOf = (cmd: Cmd): string[] => [
      ...Object.keys(cmd.args ?? {})
        .filter((k) => k !== 'help' && k !== 'version')
        .map((k) => `--${k}`),
      ...Object.keys(cmd.subCommands ?? {}),
    ];
    const shell = String(args.shell);
    if (shell === 'bash') {
      const cases = commands
        .map(([n, cmd]) => `    ${n}) opts="${optionsOf(cmd).join(' ')}" ;;`)
        .join('\n');
      say(`# packhub bash completion
_packhub() {
  local cur opts
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "${names.join(' ')}" -- "\$cur") )
    return
  fi
  case "\${COMP_WORDS[1]}" in
${cases}
    *) opts="" ;;
  esac
  COMPREPLY=( \$(compgen -W "\$opts" -- "\$cur") )
}
complete -F _packhub packhub`);
      return;
    }
    if (shell === 'zsh') {
      const cases = commands
        .map(([n, cmd]) => `    ${n}) opts=(${optionsOf(cmd).join(' ')}) ;;`)
        .join('\n');
      say(`# packhub zsh completion
_packhub() {
  local -a cmds opts
  if (( CURRENT == 2 )); then
    cmds=(${names.map((n) => `'${n}'`).join(' ')})
    _describe 'command' cmds
    return
  fi
  case \$words[2] in
${cases}
    *) opts=() ;;
  esac
  _describe 'option' opts
}
compdef _packhub packhub`);
      return;
    }
    if (shell === 'pwsh' || shell === 'powershell') {
      const map = commands
        .map(([n, cmd]) => `  '${n}' = @(${optionsOf(cmd).map((o) => `'${o}'`).join(', ')})`)
        .join('\n');
      say(`# packhub PowerShell completion
Register-ArgumentCompleter -Native -CommandName packhub -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $opts = @{
${map}
  }
  $first = $commandAst.CommandElements | Select-Object -Skip 1 -First 1
  $words = if ($first -and $opts.ContainsKey([string]$first.Value)) { $opts[[string]$first.Value] } else { @(${names.map((n) => `'${n}'`).join(', ')}) }
  $words | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}`);
      return;
    }
    problemRaw(`不支持的 shell：${shell}（bash / zsh / pwsh）`);
    stop(EXIT.USAGE);
  },
});

/** 解析 argv 里的 flag，遇到当前命令没声明的 --flag 就报出来；citty 默认会静默忽略。 */
export function unknownFlag(argv: string[]): string | undefined {
  type Cmd = { meta?: { name?: string }; args?: Record<string, unknown>; subCommands?: Record<string, Cmd> };
  const namedArgs = (cmd: Cmd): Set<string> =>
    new Set(
      Object.entries(cmd.args ?? {})
        // 位置参数不能用 --name 传：citty 会静默忽略，命令跑在默认目录（cwd）上
        .filter(([, spec]) => (spec as { type?: string })?.type !== 'positional')
        .map(([name]) => name),
    );
  let cmd = main as unknown as Cmd;
  let allowed = namedArgs(cmd);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') return undefined;
    if (token.startsWith('-')) {
      if (token === '-h' || token === '--help' || token === '-v' || token === '--version') continue;
      const name = token.replace(/^--?/, '').split('=')[0]!;
      if (!allowed.has(name)) {
        return `未知参数 --${name}（${cmd.meta?.name ?? 'packhub'}）；用 packhub ${cmd.meta?.name ?? ''} --help 看可用参数`;
      }
      continue;
    }
    const sub = cmd.subCommands?.[token];
    if (sub) {
      cmd = sub;
      allowed = namedArgs(cmd);
    }
  }
  return undefined;
}
export const main: CommandDef = command({
  // 版本号只认仓库根 package.json 一份，别在这里手写第二份。
  meta: { name: 'packhub', version: pkg.version, description: 'Agent 能力的整合包工具' },
  subCommands: {
    plan,
    install,
    uninstall,
    rollback,
    versions,
    activate,
    update,
    verify,
    lock,
    init,
    search,
    discover,
    cache,
    add,
    sync,
    resource,
    slot,
    diff,
    pack,
    hub,
    doctor,
    auth,
    trust,
    audit,
    market,
    run,
    publish,
    probe,
    licenses,
    keygen,
    sign,
    'verify-sig': verifySig,
    completion,
  },
});
