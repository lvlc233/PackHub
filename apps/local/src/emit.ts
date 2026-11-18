/**
 * CLI 的输出与退出码单点。
 *
 * 退出码只有三种，表在 EXIT 里：0 成功；1 运行失败（动作失败、校验没过、外部命令/网络
 * 出错）；2 输入或前置条件错（参数、清单、锁、目录、配置）。命令体内不要直接
 * `process.exit`：用 `stop(code)` 抛出退出信号，由 `command()` 包出来的 guard 统一落到
 * `process.exitCode`。这样已写进 stdout/stderr 的内容不会被进程退出截断，citty 的兜底
 * catch 也不会把「参数错」重写成 1。
 *
 * 输出同理只从这里出去：`say` / `json` 写 stdout，`problem` / `warn` / issue 系列写
 * stderr。前缀（`x `、`warn  `、`error [code] `）只在这里拼，命令里不再各写一份。
 */
import type { ArgsDef, CommandContext, CommandDef } from 'citty';

export const EXIT = {
  /** 成功 */
  OK: 0,
  /** 运行失败：动作失败、校验没过、外部命令/网络出错 */
  RUNTIME: 1,
  /** 输入或前置条件错：缺清单、坏参数、锁或签名没配好 */
  USAGE: 2,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** 退出码的含义（给读代码的人与测试用；不参与任何输出）。 */
export const EXIT_TEXT: Record<ExitCode, string> = {
  [EXIT.OK]: '成功',
  [EXIT.RUNTIME]: '运行失败：动作失败、校验没过、外部命令/网络出错',
  [EXIT.USAGE]: '输入或前置条件错：缺清单、坏参数、锁或签名没配好',
};

/** 命令流里的退出信号；由 guard 接住并落到 process.exitCode。 */
export class ExitSignal extends Error {
  readonly code: ExitCode;

  constructor(code: ExitCode) {
    super(`exit ${code}`);
    this.name = 'ExitSignal';
    this.code = code;
  }
}

/** 退出命令流（不直接结束进程）。 */
export function stop(code: ExitCode): never {
  throw new ExitSignal(code);
}

/** 立刻结束进程。只给入口与信号处理用；命令体内用 stop。 */
export function terminate(code: ExitCode): never {
  process.exit(code);
}

export function isExitSignal(err: unknown): err is ExitSignal {
  return err instanceof ExitSignal;
}

// —— stdout ——

export function say(line = ''): void {
  console.log(line);
}

/** `--json` 时把人类可读行整体关掉：返回一个与 say 同签名的函数。 */
export function sayUnless(quiet: boolean): (line: string) => void {
  return quiet ? () => {} : (line: string) => say(line);
}

/** 结构化输出：缩进固定 2，所有命令共用。 */
export function json(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

// —— stderr ——

/** 一行错误：`x <message>`，message 不带前缀。 */
export function problem(message: string): void {
  console.error(`x ${message}`);
}

/**
 * 原样写一行错误。只给「本身已经是一句能照做的话」的命令用（例如
 * `没有 packhub.yaml：…（先跑 packhub init）`），
 * 保持旧输出的逐字文案，不额外加 `x `。
 */
export function problemRaw(message: string): void {
  console.error(message);
}

/** 一行警告：`warn  <message>`，message 不带前缀。 */
export function warn(message: string): void {
  console.warn(`warn  ${message}`);
}

/** 带 issue 代码的错误行：`error [<code>] <message>`。 */
export function issueError(code: string, message: string): void {
  console.error(`error [${code}] ${message}`);
}

/** 带 issue 代码的警告行：`warn  [<code>] <message>`。 */
export function issueWarn(code: string, message: string): void {
  console.warn(`warn  [${code}] ${message}`);
}

// —— 命令包装 ——

export interface GuardOptions {
  /** 未捕获错误落到哪个退出码；默认 RUNTIME。前置条件错传 USAGE。 */
  code?: ExitCode | ((err: unknown) => ExitCode);
  /** 这些错误不在这里收口、继续往上抛（沿用 citty 的兜底输出）。 */
  rethrow?: (err: unknown) => boolean;
}

/**
 * 定义命令并统一收口异常：命令体内不再各写 `try/catch` 与 `process.exit`。
 * 退出信号按它自己的码落地；其它异常按 `code`（或该命令的映射）落地。
 */
export function command<T extends ArgsDef>(def: CommandDef<T>, opts: GuardOptions = {}): CommandDef<T> {
  const run = def.run;
  if (!run) return def;
  const codeOf = (err: unknown): ExitCode =>
    typeof opts.code === 'function' ? opts.code(err) : opts.code ?? EXIT.RUNTIME;
  const guarded = async (context: CommandContext<T>): Promise<void> => {
    try {
      await run(context);
    } catch (err) {
      if (isExitSignal(err)) {
        process.exitCode = err.code;
        return;
      }
      if (opts.rethrow?.(err)) throw err;
      problem((err as Error).message);
      process.exitCode = codeOf(err);
    }
  };
  return { ...def, run: guarded };
}

/**
 * 把「参数/前置条件错」从普通异常里分出来：打印后按给定码退出命令流。
 * 命令里只剩一类前置调用的 try/catch 时用它，不再手写 catch 体。
 */
export interface OrStopOptions {
  /** 落在哪个退出码；默认 USAGE。 */
  code?: ExitCode;
  /** 打印整行（含前缀）；默认写 `x <err.message>`。 */
  line?: (err: unknown) => string;
}

export function orStop<T>(work: () => T, opts: OrStopOptions = {}): T {
  try {
    return work();
  } catch (err) {
    if (isExitSignal(err)) throw err;
    if (opts.line) problemRaw(opts.line(err));
    else problem((err as Error).message);
    stop(opts.code ?? EXIT.USAGE);
  }
}
