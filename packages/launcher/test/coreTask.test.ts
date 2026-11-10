import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CORE_TASK_NAME,
  coreTaskCommand,
  coreTaskInstalled,
  coreTaskXml,
  installCoreTask,
  uninstallCoreTask,
  type CoreTaskCommand,
  type TaskRunner,
} from '../src/coreTask.ts';
import { isPalError } from '../src/errors.ts';
import { palHome } from '../src/paths.ts';

const spec: CoreTaskCommand = {
  command: 'C:\\Program Files\\nodejs\\node.exe',
  args: ['--experimental-strip-types', 'C:\\work\\pack\\packages\\launcher\\src\\bin.ts', 'core', 'start'],
  workingDirectory: 'C:\\work\\pack',
  userId: 'DESKTOP-1\\neo',
};

const windowsOnly = process.platform === 'win32' ? it : it.skip;

describe('计划任务 XML', () => {
  it('登录拉起、每分钟兜底一次、只跑一个、失败也重起', () => {
    const xml = coreTaskXml(spec);
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml).toContain('<Interval>PT1M</Interval>');
    expect(xml).toContain('<Count>999</Count>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<Repetition>');
    expect(xml).toContain('<ScheduleByDay>');
    expect(xml).toContain(`\\${CORE_TASK_NAME}`);
  });

  it('带空格的参数加引号，XML 特殊字符转义', () => {
    const xml = coreTaskXml({
      ...spec,
      args: [...spec.args, 'C:\\a b\\pack'],
      workingDirectory: 'C:\\a&b',
    });
    expect(xml).toContain('<Command>C:\\Program Files\\nodejs\\node.exe</Command>');
    expect(xml).toContain('&quot;C:\\a b\\pack&quot;');
    expect(xml).toContain('C:\\a&amp;b');
  });

  it('入口取当前进程：node 路径 + argv[1] + core start，并钉住数据目录', () => {
    const command = coreTaskCommand();
    expect(command.command).toBe(process.execPath);
    expect(command.args.slice(-4, -2)).toEqual(['core', 'start']);
    expect(command.args[command.args.indexOf('--home') + 1]).toBe(palHome());
    expect(command.args).toContain(process.argv[1]);
    expect(command.userId).toContain(process.env.USERNAME ?? '');
  });
});

describe('计划任务的注册与删除', () => {
  windowsOnly('install 用 UTF-16 XML 交给 schtasks /Create /F', () => {
    const seen: string[] = [];
    const runner: TaskRunner = (command, args) => {
      seen.push(`${command} ${args.join(' ')}`);
      const file = args[args.indexOf('/XML') + 1]!;
      const bytes = readFileSync(file);
      // 首两字节是 BOM，正文按 UTF-16LE 解出来还能看到任务名
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xfe);
      expect(bytes.toString('utf16le')).toContain(CORE_TASK_NAME);
      return { status: 0, stdout: '成功', stderr: '' };
    };

    const result = installCoreTask(spec, runner);
    expect(result.name).toBe(CORE_TASK_NAME);
    expect(seen[0]).toContain('/Create');
    expect(seen[0]).toContain('/F');
  });

  windowsOnly('schtasks 失败带上 stderr 与任务名，不假装成功', () => {
    const runner: TaskRunner = () => ({ status: 1, stdout: '', stderr: '拒绝访问' });
    let caught: unknown;
    try {
      installCoreTask(spec, runner);
    } catch (err) {
      caught = err;
    }
    expect(isPalError(caught) && caught.code === 'internal').toBe(true);
  });

  windowsOnly('删除不存在的任务不算失败', () => {
    const runner: TaskRunner = () => ({ status: 1, stdout: '错误: 系统找不到指定的任务 "PackHub PAL Core"。', stderr: '' });
    expect(uninstallCoreTask(runner)).toEqual({ removed: false });
  });

  windowsOnly('查询判断任务在不在', () => {
    expect(coreTaskInstalled(() => ({ status: 0, stdout: '', stderr: '' }))).toBe(true);
    expect(coreTaskInstalled(() => ({ status: 1, stdout: '', stderr: '' }))).toBe(false);
  });

  it('非 Windows 上给出明确的拒绝，而不是调 schtasks', () => {
    if (process.platform === 'win32') return;
    const runner = vi.fn();
    expect(() => installCoreTask(spec, runner)).toThrow();
    expect(runner).not.toHaveBeenCalled();
  });
});

