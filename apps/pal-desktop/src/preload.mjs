import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('pal', {
  list: () => ipcRenderer.invoke('pal:list'),
  hosts: () => ipcRenderer.invoke('pal:hosts'),
  info: () => ipcRenderer.invoke('pal:info'),
  start: (name, mode) => ipcRenderer.invoke('pal:start', { name, mode }),
  stop: (name) => ipcRenderer.invoke('pal:stop', { name }),
  // 添加整合包：先挑 .phub / 目录、再看 dry-run 预览，最后才真装。
  pickPack: () => ipcRenderer.invoke('pal:pick-pack'),
  pickDirectory: () => ipcRenderer.invoke('pal:pick-directory'),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  log: (event, data) => ipcRenderer.invoke('pal:log', { event, data }),
  installPreview: (host, dir, root) => ipcRenderer.invoke('pal:install-preview', { host, dir, root }),
  install: (host, dir, root) => ipcRenderer.invoke('pal:install', { host, dir, root }),
  // 管理页：update / uninstall / remove 只传名字，命令参数留在主进程。
  action: (name, action) => ipcRenderer.invoke('pal:action', { name, action }),
  instanceLogs: (name) => ipcRenderer.invoke('pal:instance-logs', { name }),
  reveal: (path) => ipcRenderer.invoke('pal:reveal', { path }),
  copy: (text) => ipcRenderer.invoke('pal:copy', { text }),
  openExternal: (url) => ipcRenderer.invoke('pal:open-external', { url }),
  termStart: (name, cols, rows) => ipcRenderer.invoke('term:start', { name, cols, rows }),
  termInput: (data) => ipcRenderer.send('term:input', { data }),
  termResize: (cols, rows) => ipcRenderer.send('term:resize', { cols, rows }),
  termKill: () => ipcRenderer.invoke('term:kill'),
  onTermData: (fn) => ipcRenderer.on('term:data', (_event, data) => fn(data)),
  onTermExit: (fn) => ipcRenderer.on('term:exit', (_event, payload) => fn(payload)),
});
