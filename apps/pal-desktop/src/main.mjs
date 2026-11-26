import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');


const HERE = dirname(fileURLToPath(import.meta.url));
const HOSTS = [
  { id: 'dsh', label: 'DSH', desc: 'DeepSeek Harness' },
  { id: 'claude-code', label: 'Claude', desc: 'Claude Code' },
  { id: 'codex', label: 'Codex', desc: 'OpenAI Codex' },
  { id: 'opencode', label: 'opencode', desc: 'opencode' },
  { id: 'workbody', label: 'WorkBuddy', desc: 'WorkBuddy / CodeBuddy' },
  { id: 'hermes', label: 'Hermes', desc: 'Hermes Agent' },
];

let win;
let terminal = null;

function palBin() {
  if (process.env.PAL_BIN) return process.env.PAL_BIN;
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pal'], { encoding: 'utf8' });
  if (probe.status === 0) {
    const first = String(probe.stdout || '').split(/\r?\n/).find((line) => line.trim());
    if (first) return first.trim();
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
      encoding: 'utf8', timeout, windowsHide: true, cwd: opts.cwd,
    });
  }
  return spawnSync(command, args, { encoding: 'utf8', timeout, windowsHide: true, cwd: opts.cwd });
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

ipcMain.handle('pal:list', () => {
  const base = listInstances();
  if (!base.ok) return base;
  return { ok: true, instances: base.instances.map((inst) => ({ ...inst, modes: modesFor(inst.name) })) };
});

ipcMain.handle('pal:hosts', () => HOSTS);

ipcMain.handle('pal:start', (_event, { name, mode }) => {
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
    record,
  };
});

ipcMain.handle('pal:stop', (_event, { name }) => {
  const result = runPal(['stop', name], { timeout: 60000 });
  return { ok: result.status === 0, stdout: result.stdout || '', stderr: result.stderr || '' };
});

ipcMain.handle('pal:install', async (_event, { host }) => {
  const picked = await dialog.showOpenDialog(win, {
    title: '选择 Pack 目录',
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
  const result = runPal(['install', picked.filePaths[0], '--host', host], { timeout: 180000 });
  return {
    canceled: false,
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
});

ipcMain.handle('pal:open-external', (_event, { url }) => shell.openExternal(url));

ipcMain.handle('term:start', (event, { name, cols, rows }) => {
  const pty = require('node-pty');
  if (terminal) {
    try { terminal.kill(); } catch { /* ignore */ }
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

ipcMain.handle('term:kill', () => {
  if (terminal) {
    try { terminal.kill(); } catch { /* ignore */ }
    terminal = null;
  }
  return { ok: true };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
