/**
 * PAL 最小 Electron 壳（E1 起）+ API 桥（E2）。
 *
 * 只做四件事：
 *   1. spawn 侧车 `pal serve`（仓库内走 node --experimental-strip-types …/bin.ts）；
 *   2. 从它 stdout 的 JSON（`--json` 时打印 `{"url":"http://127.0.0.1:PORT/"}`）里读出实际地址；
 *   3. 把地址装进 BrowserWindow，窗口关闭 / 应用退出时收掉侧车；
 *   4. 注册 `pal:request` IPC，把页面的 /api/ 请求转给侧车（转发规则在 forward.mjs）。
 *
 * 不做打包入口（E5）。侧车异常退出必须给出可见错误，不能静默失败。
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { forwardRequest, sidecarOrigin } from './forward.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根：本文件在 apps/pal-electron/ 下，往上两级；PAL_REPO 可显式指定。 */
const repoRoot = process.env.PAL_REPO ?? path.resolve(here, '..', '..');
const SERVE_TIMEOUT_MS = 20_000;
/** D7：先关 stdin 请 sidecar 自己退，最多等这么久，之后才硬收。 */
const GRACEFUL_EXIT_MS = 1500;
/** 硬收之后再等这么久，仍未退出就不再等它。 */
const FORCE_EXIT_MS = 1000;
/** before-quit 的兜底：等 sidecar 再久，也不能让窗口关不掉。 */
const QUIT_DEADLINE_MS = GRACEFUL_EXIT_MS + FORCE_EXIT_MS + 1000;

/** @type {import('node:child_process').ChildProcess | null} */
let sidecar = null;
/** @type {BrowserWindow | null} */
let window = null;
/** 主动收摊（关窗 / 退出 / 失败处理）时为 true，此时 sidecar 退出不算异常。 */
let stopping = false;
let failed = false;
let stderrTail = '';
/** stopSidecar 的单一入口：关窗与退出可能并发调用，共用同一个 Promise。 */
/** @type {Promise<void> | null} */
let stopPromise = null;
/** before-quit 已经在等 sidecar 时为 true，避免重复拦截。 */
let quitting = false;

/** 侧车怎么起：dev 走仓库源码，打包入口 E1 先不实现。 */
function resolveSidecar() {
  if (app.isPackaged) {
    throw new Error(
      '打包入口还没接：E1 只支持仓库内运行（app.isPackaged === false）。\n' +
        '打包后应带 runtime/node + runtime/pal.cjs，等 E5 定范围后再接。',
    );
  }
  return {
    command: process.env.PAL_NODE ?? 'node',
    args: [
      '--experimental-strip-types',
      path.join(repoRoot, 'packages', 'launcher', 'src', 'bin.ts'),
      'serve',
      '--port',
      '0',
      '--json',
      // D7：关掉 stdin 时 sidecar 自己关服务并退 0，别等着被 taskkill
      '--exit-on-stdin-close',
    ],
    cwd: repoRoot,
  };
}

/** 从一行 stdout 里取地址；非 JSON 或没有 url 字段就返回 null。 */
function readUrl(line) {
  if (!line.startsWith('{')) return null;
  try {
    const payload = JSON.parse(line);
    const url = payload?.url;
    return typeof url === 'string' && url.startsWith('http') ? url : null;
  } catch {
    return null;
  }
}

/**
 * 页面发起的 /api/ 请求：先确认来源帧就是侧车页面，再交给 forward.mjs 转发。
 * IPC 的返回值必须能结构化克隆，所以任何异常都收敛成 `{ ok: false, error }`，
 * 让渲染侧（web/api.js）统一转成 Error。
 */
function registerBridge(url) {
  const origin = sidecarOrigin(url);
  ipcMain.removeHandler('pal:request');
  ipcMain.handle('pal:request', async (event, payload) => {
    try {
      let frameOrigin = '';
      try {
        frameOrigin = new URL(event.senderFrame?.url ?? '').origin;
      } catch {
        frameOrigin = '';
      }
      // senderFrame 拿不到时（帧已销毁）就按“来源不明”拒掉，这里没有需要兼容的旧客户端
      if (!origin || frameOrigin !== origin) {
        return { ok: false, error: '拒绝转发：请求不是来自 PAL 界面' };
      }
      return await forwardRequest({ baseUrl: url, path: payload?.path, options: payload?.options });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** pal serve 没给地址就结束：带退出码与 stderr 尾巴，别只说“失败了”。 */
function fail(message) {
  if (failed || stopping) return;
  failed = true;
  const detail = stderrTail.trim();
  dialog.showErrorBox('PAL 启动失败', detail ? `${message}\n\npal serve 的 stderr：\n${detail}` : message);
  stopping = true;
  stopSidecar();
  app.quit();
}

function startSidecar() {
  const { command, args, cwd } = resolveSidecar();
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(command, args, {
        cwd,
        env: process.env,
        windowsHide: true,
        // D7：stdin 是关闭通道（关掉就让 sidecar 自己退），stdout/stderr 仍按行解析
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`起不了 pal serve（${command}）：${err.message}`));
      return;
    }
    sidecar = proc;
    // 收摊时侧车可能已经走了：再写 stdin 只会得到 EPIPE，别让它变成未捕获异常
    proc.stdin.on('error', () => {});

    let buffered = '';
    let settled = false;
    const timer = setTimeout(() => {
      settle(new Error(`等 pal serve 给出地址超时（${SERVE_TIMEOUT_MS / 1000}s）`));
    }, SERVE_TIMEOUT_MS);

    function settle(err, url) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(url);
    }

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
        const url = readUrl(line);
        if (url) settle(null, url);
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        settle(new Error(`找不到 Node（${command}）：先装 Node 22+ 放进 PATH，或用 PAL_NODE 指定 node 可执行文件。`));
      } else {
        settle(new Error(`起不了 pal serve（${command}）：${err.message}`));
      }
    });

    proc.on('exit', (code, signal) => {
      if (sidecar === proc) sidecar = null;
      if (!settled) {
        settle(new Error(`pal serve 在给出地址前退出（code=${code}${signal ? `, signal=${signal}` : ''}）`));
        return;
      }
      if (stopping) return;
      fail(`pal serve 意外退出（code=${code}${signal ? `, signal=${signal}` : ''}）。`);
    });
  });
}

/** 等 ms 毫秒；用来给“等进程退出”加时限，返回 false 表示到点了。 */
function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(false), ms);
  });
}

/**
 * 硬收。Windows 上没有进程组，`pal serve` 再拉起子进程时 child.kill 收不干净，
 * 所以用 taskkill /T /F；其它平台先 SIGTERM（更晚的 SIGKILL 在 stopSidecar 里补）。
 */
function forceKill(proc) {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      if (result.status !== 0) proc.kill();
    } else {
      proc.kill('SIGTERM');
    }
  } catch {
    try {
      proc.kill();
    } catch {
      /* 收摊失败不挡关窗 */
    }
  }
}

/**
 * 收掉侧车（D7 的优雅路径）：先 `proc.stdin.end()`，让 `pal serve --exit-on-stdin-close`
 * 自己关 HTTP server 并退出 0；最多等 GRACEFUL_EXIT_MS，没退再 forceKill。
 * 重复调用共用同一个 Promise：关窗与 before-quit 都会走到这里。
 */
function stopSidecar() {
  if (stopPromise) return stopPromise;
  stopping = true;
  const proc = sidecar;
  sidecar = null;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    stopPromise = Promise.resolve();
    return stopPromise;
  }
  stopPromise = (async () => {
    const exited = new Promise((resolve) => proc.once('exit', () => resolve(true)));
    try {
      proc.stdin.end();
    } catch {
      /* stdin 已经坏了就直接走硬收 */
    }
    if (await Promise.race([exited, wait(GRACEFUL_EXIT_MS)])) return;
    forceKill(proc);
    if (await Promise.race([exited, wait(FORCE_EXIT_MS)])) return;
    if (process.platform !== 'win32') {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* 已经没了 */
      }
    }
  })();
  return stopPromise;
}

function openWindow(url) {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#121417',
    title: 'PAL',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => {
    window = null;
    // 关窗走优雅路径（关 stdin → 等退 → 兜底硬收）；不 await，别挡住窗口销毁
    void stopSidecar();
  });
  window.loadURL(url).catch((err) => {
    fail(`窗口加载 ${url} 失败：${err.message}`);
  });
}

app.on('window-all-closed', () => app.quit());

// 退出前收侧车：窗口关掉、任务管理器结束等路径之外的最后一道保险。
// D7：这里先拦一次，给侧车最多 QUIT_DEADLINE_MS 优雅收摊的时间；到点 app.exit() 直接走，
// 绝不让“等侧车”卡住关窗（app.exit 不会再触发 before-quit）。
app.on('before-quit', (event) => {
  stopping = true;
  if (quitting) {
    event.preventDefault();
    return;
  }
  if (!sidecar && !stopPromise) return;
  quitting = true;
  event.preventDefault();
  const deadline = setTimeout(() => app.exit(0), QUIT_DEADLINE_MS);
  stopSidecar()
    .catch(() => {})
    .finally(() => {
      clearTimeout(deadline);
      app.exit(0);
    });
});

app
  .whenReady()
  .then(async () => {
    const url = await startSidecar();
    // 窗口加载前先挂好桥：页面一进来就可能发请求
    registerBridge(url);
    openWindow(url);
  })
  .catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
  });
