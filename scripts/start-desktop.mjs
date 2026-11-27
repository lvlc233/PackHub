#!/usr/bin/env node
// 启动 PAL 桌面版：清掉 DSH 注入的 ELECTRON_RUN_AS_NODE，再以 --no-sandbox 起 Electron。
// 这两个都是本机会话里 Electron 能开窗的前提；普通机器上 --no-sandbox 也不会改变应用行为。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps', 'pal-desktop');
const BIN = join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const POSIX_BIN = join(APP, 'node_modules', 'electron', 'dist', 'electron');

const electron = process.platform === 'win32' ? BIN : POSIX_BIN;
if (!existsSync(electron)) {
  console.error('找不到 Electron 二进制；先在仓库根跑 pnpm install（国内可设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）。');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// pal.cmd 里是 `node ...`：保证 Node 自己的目录在 PATH 里，再补 npm 全局 bin（pal.cmd）。
const nodeDir = dirname(process.execPath);
if (nodeDir) {
  env.PATH = `${nodeDir};${env.PATH || ''}`;
  env.PAL_NODE_BIN = process.execPath;
}
if (process.env.APPDATA) env.PATH = `${join(process.env.APPDATA, 'npm')};${env.PATH || ''}`;
// DSH 会话里 Electron 子进程被 job object 限制，写不了 %LOCALAPPDATA%；
// 从 DSH 启动时把 PAL 数据放到仓库内（仍在工作区），真实桌面启动不受影响。
if (!env.PACKHUB_HOME && process.env.DSH_SESSION_ID) {
  env.PACKHUB_HOME = join(ROOT, '.pal-desktop-data');
}
if (!env.PAL_DESKTOP_DATA && process.env.DSH_SESSION_ID) {
  env.PAL_DESKTOP_DATA = join(ROOT, '.pal-desktop-data', 'app');
}

// Electron 子进程的 PATH 可能没有 npm 全局 bin，无法发现 dsh/claude/codex/opencode。
// 从当前 shell 的 where 结果把它们解析成 PAL_<HOST>_BIN，并把目录补进 PATH。
const HOST_COMMANDS = {
  dsh: 'dsh',
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  workbody: 'codebuddy',
  hermes: 'hermes',
};
const hostDirs = [];
for (const [host, command] of Object.entries(HOST_COMMANDS)) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8' });
  if (probe.status !== 0) continue;
  const first = String(probe.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
  if (!first) continue;
  env[`PAL_${host.toUpperCase().replace(/-/g, '_')}_BIN`] = first;
  hostDirs.push(dirname(first));
}
if (hostDirs.length) env.PATH = `${[...new Set(hostDirs)].join(';')};${env.PATH || ''}`;

const child = spawn(electron, ['--no-sandbox', APP], { cwd: ROOT, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
