import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PalError } from './errors.ts';
import { palHome } from './paths.ts';

/**
 * 让操作系统把 core 拉起来：注册一个当前用户的开机/登录任务，并让它在 core 异常退出后自动重起。
 *
 * 为什么用计划任务而不是「父进程看着」：父进程自己就是客户端，它退出正是 core 要活下来的原因。
 * Windows 只在登录后起（InteractiveToken），所以它管的是「用户在用这台机器」的那段时间；
 * 没有登录时 core 本来也没有实例要守。
 */

export const CORE_TASK_NAME = 'PackHub PAL Core';
/** core 异常退出后的重起间隔；任务计划里的短格式。 */
const RESTART_INTERVAL = 'PT1M';
const RESTART_COUNT = '999';

export interface CoreTaskCommand {
  /** node 可执行文件 */
  command: string;
  /** 入口 + 子命令（含 --experimental-strip-types 这类运行时参数） */
  args: string[];
  workingDirectory: string;
  /** DOMAIN\user */
  userId: string;
}

export interface TaskRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 执行 schtasks 的注入点；测试不碰真实计划任务。 */
export type TaskRunner = (command: string, args: string[]) => TaskRunResult;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 任务计划写的是命令行，带空格的路径要自己加引号。 */
function quoteArg(text: string): string {
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/** 当前用户与入口：`pal core install` 注册的就是这条命令。 */
export function coreTaskCommand(): CoreTaskCommand {
  const entry = process.argv[1];
  if (!entry) {
    throw new PalError('invalid-input', '找不到 PAL 的入口，没法注册计划任务', {
      hint: '从 pal 命令或打包后的 pal.cjs 调用 pal core install',
    });
  }
  const user = process.env.USERNAME ?? '';
  const domain = process.env.USERDOMAIN ?? process.env.COMPUTERNAME ?? '';
  return {
    command: process.execPath,
    // 每次跑 pal core start：已经在跑就什么都不做，没人看护就补一个。
    // 带上 --home：任务不继承用户的环境变量，不能靠它去猜 core 该落哪个数据目录。
    args: [...process.execArgv, entry, 'core', 'start', '--home', palHome()],
    workingDirectory: process.cwd(),
    userId: domain ? `${domain}\\${user}` : user,
  };
}

/**
 * 任务 XML：登录时拉起，之后每分钟检查一次；同时只跑一个；失败还按 1 分钟重起。
 *
 * 为什么不只靠「失败重起」：core 被结束（Task Scheduler 会记成 terminated，不是 failed）时
 * 系统不会把它算作失败。每分钟的重复触发是兜底——不管 core 以什么方式没了，一分钟内都会回来。
 * IgnoreNew 是「不出现两个 core」的第一道；第二道是 core 自己的锁文件。
 */
export function coreTaskXml(spec: CoreTaskCommand): string {
  const userId = escapeXml(spec.userId);
  const start = new Date().toISOString().slice(0, 19);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>PackHub PAL core：常驻看护托管实例；由 pal core install 注册。</Description>
    <URI>\\${escapeXml(CORE_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${userId}</UserId>
      <Delay>PT5S</Delay>
    </LogonTrigger>
    <CalendarTrigger>
      <StartBoundary>${start}</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${userId}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure>
      <Interval>${RESTART_INTERVAL}</Interval>
      <Count>${RESTART_COUNT}</Count>
    </RestartOnFailure>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(spec.command)}</Command>
      <Arguments>${escapeXml(spec.args.map(quoteArg).join(' '))}</Arguments>
      <WorkingDirectory>${escapeXml(spec.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

const defaultRunner: TaskRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

function requireWindows(): void {
  if (process.platform !== 'win32') {
    throw new PalError('invalid-input', '系统任务启动只在 Windows 上支持', {
      hint: '其它平台先靠 pal core run 挂在进程管理器里；CLI 与界面照样按需拉起 core',
    });
  }
}

/** 注册（或覆盖）开机任务；返回任务名与 XML，方便 doctor/日志里核对。 */
export function installCoreTask(
  spec: CoreTaskCommand = coreTaskCommand(),
  runner: TaskRunner = defaultRunner,
): { name: string; xml: string } {
  requireWindows();
  const xml = coreTaskXml(spec);
  const dir = mkdtempSync(join(tmpdir(), 'pal-core-task-'));
  const file = join(dir, 'core-task.xml');
  try {
    // schtasks 只认 Unicode XML：UTF-16LE + BOM，否则报「不是有效的 XML」
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
    const result = runner('schtasks', ['/Create', '/TN', CORE_TASK_NAME, '/XML', file, '/F']);
    if (result.status !== 0) {
      throw new PalError('internal', '注册 PAL core 的计划任务失败', {
        hint: result.stderr.trim() || 'schtasks /Create 返回非 0；确认当前用户能用任务计划程序',
        details: { task: CORE_TASK_NAME, status: result.status, stderr: result.stderr.trim() },
      });
    }
    return { name: CORE_TASK_NAME, xml };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function uninstallCoreTask(runner: TaskRunner = defaultRunner): { removed: boolean } {
  requireWindows();
  const result = runner('schtasks', ['/Delete', '/TN', CORE_TASK_NAME, '/F']);
  // 任务本来就不存在（退出码 1 + 找不到）不算失败
  if (result.status !== 0 && !/找不到|cannot find|does not exist/i.test(`${result.stdout}${result.stderr}`)) {
    throw new PalError('internal', '删除 PAL core 的计划任务失败', {
      hint: result.stderr.trim() || 'schtasks /Delete 返回非 0',
      details: { task: CORE_TASK_NAME, status: result.status },
    });
  }
  return { removed: result.status === 0 };
}

export function coreTaskInstalled(runner: TaskRunner = defaultRunner): boolean {
  requireWindows();
  const result = runner('schtasks', ['/Query', '/TN', CORE_TASK_NAME]);
  return result.status === 0;
}

