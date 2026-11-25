// `pal ui`：本地可视化启动器。浏览器打开一个单页，列出 home，点按钮启停 / 打开页面 / 看日志。
//
// 它是前台阻塞命令：服务只绑 127.0.0.1，Ctrl+C 关掉服务退出；关掉它不影响实例，也不停 core
// （读/写实例都走现有模块，UI 自己不持有进程）。命令面的取舍见 docs/decisions.md。
import { defineCommand } from 'citty';
import { openInBrowser } from '../browser.ts';
import { PalError } from '../errors.ts';
import { startUiServer, type UiServer } from '../ui.ts';

/** `--port`：0 = 让系统挑；其余必须是 0..65535 的整数。 */
function parsePort(raw: unknown): number {
  if (raw === undefined) return 0;
  const text = String(raw).trim();
  const port = Number(text);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new PalError('invalid-input', `--port 要 0..65535 的整数，收到：${text}`, {
      hint: '0（默认）= 让系统挑一个端口；具体端口被占会报 port-in-use',
    });
  }
  return port;
}

/**
 * 等 Ctrl+C（或服务被别人关掉）。
 * SIGINT / SIGTERM 都先关服务再返回：不关就退出会让监听套接字留在进程外，端口要等系统回收。
 */
function waitForClose(started: UiServer): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      void started.close().then(() => resolve());
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    started.server.once('close', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });
}

export const ui = defineCommand({
  meta: {
    name: 'ui',
    description:
      '本地可视化启动器：浏览器里列出 home，点按钮启动 / 停止、打开页面、看日志；只绑 127.0.0.1，前台阻塞到 Ctrl+C（关掉它不影响实例与 core）',
  },
  args: {
    port: { type: 'string', description: '端口；不写（或 0）= 让系统挑一个' },
    'no-open': {
      type: 'boolean',
      default: false,
      description: '不自动打开浏览器（非 TTY 时也不会打开）',
    },
    json: { type: 'boolean', default: false, description: '只打印 {url, port}；仍前台阻塞，Ctrl+C 退出' },
  },
  async run({ args }) {
    const started = await startUiServer({ port: parsePort(args.port) });
    if (args.json) {
      // 给脚本读：一行 JSON，不带别的输出
      console.log(JSON.stringify({ url: started.url, port: started.port }));
    } else {
      console.log(`PAL 启动器：${started.url}`);
      console.log('  只绑 127.0.0.1；Ctrl+C 退出（关掉它不影响已启动的实例，也不停 core）');
      // 与 `pal start` 同一套：--no-open / 非 TTY 不打开
      if (!args['no-open'] && process.stdout.isTTY) openInBrowser(started.url);
    }
    await waitForClose(started);
  },
});
