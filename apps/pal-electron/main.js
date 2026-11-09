/**
 * PAL 最小 Electron 壳（E1）。
 *
 * 只做三件事：
 *   1. spawn 侧车 `pal serve`（仓库内走 node --experimental-strip-types …/bin.ts）；
 *   2. 从它 stdout 的 JSON（`--json` 时打印 `{"url":"http://127.0.0.1:PORT/"}`）里读出实际地址；
 *   3. 把地址装进 BrowserWindow，窗口关闭 / 应用退出时收掉侧车。
 *
 * 不做 IPC 业务桥（E2）、不做打包入口（E5）。侧车异常退出必须给出可见错误，不能静默失败。
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog } from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根：本文件在 apps/pal-electron/ 下，往上两级；PAL_REPO 可显式指定。 */
const repoRoot = process.env.PAL_REPO ?? path.resolve(here, '..', '..');
const SERVE_TIMEOUT_MS = 20_000;

/** @type {import('node:child_process').ChildProcess | null} */
let sidecar = null;
/** @type {BrowserWindow | null} */
let window = null;
/** 主动收摊（关窗 / 退出 / 失败处理）时为 true，此时侧车退出不算异常。 */
let stopping = false;
let failed = false;
let stderrTail = '';

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
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`起不了 pal serve（${command}）：${err.message}`));
      return;
    }
    sidecar = proc;

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

/**
 * 收掉侧车。Windows 上没有进程组，`pal serve` 再拉起子进程时 child.kill 收不干净，
 * 所以用 taskkill /T；其它平台发 SIGTERM。
 */
function stopSidecar() {
  const proc = sidecar;
  sidecar = null;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
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
    stopSidecar();
  });
  window.loadURL(url).catch((err) => {
    fail(`窗口加载 ${url} 失败：${err.message}`);
  });
}

app.on('window-all-closed', () => app.quit());

// 退出前收侧车：窗口关掉、任务管理器结束等路径之外的最后一道保险。
app.on('before-quit', () => {
  stopping = true;
  stopSidecar();
});

app
  .whenReady()
  .then(async () => {
    const url = await startSidecar();
    openWindow(url);
  })
  .catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
  });
