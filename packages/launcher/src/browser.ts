import { spawn } from 'node:child_process';

/**
 * 用系统默认浏览器打开地址：后台进程、不等它、失败也不影响调用方的结果（地址已经打印出来了）。
 *
 * 只在「用户看得见的一次动作」里调用：`pal start` 起完 server、`pal ui` 起来之后，
 * 且 stdout 是 TTY、没给 `--no-open` / `--json`。做成公共函数是因为两条命令共用同一套平台分支。
 */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      /* 打不开就算了：URL 已经打印出来 */
    });
    child.unref();
  } catch {
    /* 同上 */
  }
}
