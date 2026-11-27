import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron');

const HERE = dirname(fileURLToPath(import.meta.url));
// Windows 上默认的 userData 路径偶尔会让 Electron 在启动阶段直接崩（0xC0000005）；
// 固定到 LOCALAPPDATA\pal-desktop 并确保存在，启动就不依赖 APPDATA 下的默认目录状态。
const dataDir = process.env.PAL_DESKTOP_DATA || join(process.env.LOCALAPPDATA || process.env.APPDATA || HERE, 'pal-desktop');
mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
// PAL 自己的数据目录（instances / 审计），不是桌面应用的 userData
const palDataDir = process.env.PACKHUB_HOME || join(process.env.LOCALAPPDATA || process.env.APPDATA || HERE, 'PackHub');
const HOSTS = [
  { id: 'dsh', label: 'DSH', desc: 'DeepSeek Harness' },
  { id: 'claude-code', label: 'Claude', desc: 'Claude Code' },
  { id: 'codex', label: 'Codex', desc: 'OpenAI Codex' },
  { id: 'opencode', label: 'opencode', desc: 'opencode' },
  { id: 'workbody', label: 'WorkBuddy', desc: 'WorkBuddy / CodeBuddy' },
  { id: 'hermes', label: 'Hermes', desc: 'Hermes Agent' },
];

/** 每个动作对应一条 pal 命令；参数只在这里拼，渲染层只能传名字。 */
const ACTIONS = {
  update: (name) => ['update', '--home', name, '--json'],
  uninstall: (name) => ['uninstall', '--home', name, '--json'],
  remove: (name) => ['remove', name, '--yes', '--json'],
};

let win;
let terminal = null;

function errText(err) {
  return (err && err.message) || String(err);
}

function palBin() {
  if (process.env.PAL_BIN) return process.env.PAL_BIN;
  if (process.platform === 'win32') {
    const npm = process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'pal.cmd') : '';
    const pnpm = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'pnpm', 'pal.cmd') : '';
    const candidate = [npm, pnpm].find((item) => item && existsSync(item));
    if (candidate) return candidate;
  }
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pal'], { encoding: 'utf8' });
  if (probe.status === 0) {
    const lines = String(probe.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    // npm 在 Windows 上同时生成 pal / pal.cmd / pal.ps1；只有 .cmd/.exe/.bat 能直接 spawn
    const executable = lines.find((line) => /\.(cmd|exe|bat)$/i.test(line));
    if (executable) return executable;
    const first = lines[0];
    if (first) return first;
  }
  return 'pal';
}

function quote(value) {
  return /[\s"]/g.test(value) ? `"${String(value).replace(/"/g, '\\"')}"` : String(value);
}

function runPal(args, opts = {}) {
  const command = palBin();
  const timeout = opts.timeout ?? 120000;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const line = `${quote(command)} ${args.map(quote).join(' ')}`;
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      encoding: 'utf8', timeout, windowsHide: true, cwd: opts.cwd, windowsVerbatimArguments: true,
    });
  }
  return spawnSync(command, args, { encoding: 'utf8', timeout, windowsHide: true, cwd: opts.cwd });
}

/** pal 非 0 退出时，把最有信息量的那段文字挑出来给 UI。 */
function palFailure(result, fallback) {
  return String(result.stderr || result.stdout || fallback).trim();
}

/** 统一外壳：任何 handler 抛错都变成 { ok:false, error }，不让渲染层拿到 rejected promise。 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      return await fn(event, payload || {});
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
}

function listInstances() {
  const result = runPal(['list', '--json'], { timeout: 30000 });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || 'pal list 失败').trim(), instances: [] };
  }
  try {
    const data = JSON.parse(String(result.stdout || '{}'));
    return { ok: true, instances: data.instances || [] };
  } catch {
    return { ok: false, error: 'pal list 的 JSON 读不了', instances: [] };
  }
}

function modesFor(name) {
  const result = runPal(['start', name, '--list-modes', '--json'], { timeout: 30000 });
  if (result.status !== 0) return [];
  try {
    const data = JSON.parse(String(result.stdout || '{}'));
    return data.modes || [];
  } catch {
    return [];
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'PAL',
    backgroundColor: '#f4f5f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(HERE, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(join(HERE, 'index.html'));
  const shot = process.env.PAL_DESKTOP_SHOT;
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage();
          writeFileSync(shot, image.toPNG());
        } catch (err) {
          console.error('screenshot failed', err);
        } finally {
          app.quit();
        }
      }, 1800);
    });
  }
}

handle('pal:list', () => {
  const base = listInstances();
  if (!base.ok) return base;
  return { ok: true, instances: base.instances.map((inst) => ({ ...inst, modes: modesFor(inst.name) })) };
});

handle('pal:hosts', () => HOSTS);

/** 设置视图要展示的数据目录与版本：只读，不改 pal 的命令契约。 */
handle('pal:info', () => {
  let version = '';
  try {
    version = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version || '';
  } catch { /* 打包后拿不到就留空 */ }
  return { ok: true, version, dataDir: palDataDir, palBin: palBin(), platform: process.platform };
});

handle('pal:start', (_event, { name, mode }) => {
  const args = ['start', name, '--json'];
  if (mode) args.push('--mode', mode);
  const result = runPal(args, { timeout: 180000 });
  let record = null;
  try { record = JSON.parse(String(result.stdout || '')); } catch { /* text */ }
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.status === 0 ? undefined : palFailure(result, 'pal start 返回非 0'),
    record,
  };
});

handle('pal:stop', (_event, { name }) => {
  const result = runPal(['stop', name], { timeout: 60000 });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.status === 0 ? undefined : palFailure(result, 'pal stop 返回非 0'),
  };
});

/** 系统目录选择器单独一个通道：添加整合包的第二步行内选目录要能反复调用。 */
handle('pal:pick-pack', async () => {
  const picked = await dialog.showOpenDialog(win, {
    title: '选择整合包',
    properties: ['openFile'],
    filters: [{ name: 'Pack', extensions: ['phub'] }, { name: '全部文件', extensions: ['*'] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true, path: null };
  return { canceled: false, path: picked.filePaths[0] };
});

handle('pal:pick-directory', async () => {
  const picked = await dialog.showOpenDialog(win, {
    title: '选择 Pack 目录',
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true, path: null };
  return { canceled: false, path: picked.filePaths[0] };
});

/** 只算计划、不落盘：弹层第三屏的预览。 */
handle('pal:install-preview', (_event, { host, dir }) => {
  if (!dir) return { ok: false, error: '还没有选目录' };
  if (!existsSync(dir)) return { ok: false, error: `目录不存在：${dir}` };
  const result = runPal(['install', dir, '--host', host, '--dry-run', '--json'], { timeout: 180000 });
  if (result.status !== 0) {
    return { ok: false, error: palFailure(result, `pal install --dry-run 退出码 ${result.status}`) };
  }
  let data;
  try {
    data = JSON.parse(String(result.stdout || '{}'));
  } catch {
    return { ok: false, error: `预览输出不是 JSON：\n${String(result.stdout || '').slice(0, 2000)}` };
  }
  return { ok: true, plan: data.plan || null, name: data.name || null };
});

/** 保留旧调用：只传 host 时仍然弹系统目录选择器。 */
handle('pal:install', async (_event, { host, dir }) => {
  let target = dir;
  if (!target) {
    const picked = await dialog.showOpenDialog(win, {
      title: '选择 Pack 目录',
      properties: ['openDirectory'],
    });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
    target = picked.filePaths[0];
  }
  const result = runPal(['install', target, '--host', host, '--json'], { timeout: 180000 });
  let record = null;
  try { record = JSON.parse(String(result.stdout || '')); } catch { /* 纯文本输出 */ }
  const ok = result.status === 0;
  return {
    canceled: false,
    ok,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: ok ? undefined : palFailure(result, 'pal install 返回非 0'),
    record,
    name: record && record.name ? record.name : null,
  };
});

/** 更新 / 卸载 / 删除：危险动作的确认在渲染层，这里只执行。 */
handle('pal:action', (_event, { name, action }) => {
  const build = ACTIONS[action];
  if (!build) return { ok: false, error: `未知动作：${action}` };
  if (!name) return { ok: false, error: '没有给实例名' };
  const result = runPal(build(name), { timeout: 180000 });
  const ok = result.status === 0;
  return {
    ok,
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: ok ? undefined : palFailure(result, `pal ${action} 返回非 0`),
  };
});

handle('pal:reveal', async (_event, { path: target }) => {
  if (!target) return { ok: false, error: '这个实例没有记录路径' };
  if (!existsSync(target)) return { ok: false, error: `路径不存在：${target}` };
  let isDir = false;
  try { isDir = statSync(target).isDirectory(); } catch { /* 当成文件 */ }
  if (isDir) {
    const failure = await shell.openPath(target);
    return failure ? { ok: false, error: failure } : { ok: true };
  }
  shell.showItemInFolder(target);
  return { ok: true };
});

handle('pal:copy', (_event, { text }) => {
  clipboard.writeText(String(text ?? ''));
  return { ok: true };
});

handle('pal:open-external', async (_event, { url }) => {
  if (!url) return { ok: false, error: '没有链接' };
  await shell.openExternal(url);
  return { ok: true };
});

handle('term:start', (event, { name, cols, rows }) => {
  const pty = require('node-pty');
  if (terminal) {
    try { terminal.kill(); } catch { /* 已经退出 */ }
    terminal = null;
  }
  const command = palBin();
  const isCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const file = isCmd ? (process.env.ComSpec || 'cmd.exe') : command;
  const args = isCmd ? ['/d', '/s', '/c', `${quote(command)} run ${quote(name)}`] : ['run', name];
  terminal = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: Math.max(20, cols || 100),
    rows: Math.max(5, rows || 30),
    cwd: process.env.USERPROFILE || process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  terminal.onData((data) => {
    if (!event.sender.isDestroyed()) event.sender.send('term:data', data);
  });
  terminal.onExit(({ exitCode }) => {
    if (!event.sender.isDestroyed()) event.sender.send('term:exit', { exitCode });
    terminal = null;
  });
  return { ok: true };
});

ipcMain.on('term:input', (_event, { data }) => {
  if (terminal) terminal.write(data);
});

ipcMain.on('term:resize', (_event, { cols, rows }) => {
  if (terminal) {
    try { terminal.resize(Math.max(20, cols), Math.max(5, rows)); } catch { /* ignore */ }
  }
});

handle('term:kill', () => {
  if (terminal) {
    try { terminal.kill(); } catch { /* ignore */ }
    terminal = null;
  }
  return { ok: true };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
