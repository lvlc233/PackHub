import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pal', {
  list: () => ipcRenderer.invoke('pal:list'),
  hosts: () => ipcRenderer.invoke('pal:hosts'),
  start: (name, mode) => ipcRenderer.invoke('pal:start', { name, mode }),
  stop: (name) => ipcRenderer.invoke('pal:stop', { name }),
  // 添加整合包：先挑目录、再看 dry-run 预览，最后才真装。
  pickDirectory: () => ipcRenderer.invoke('pal:pick-directory'),
  installPreview: (host, dir) => ipcRenderer.invoke('pal:install-preview', { host, dir }),
  install: (host, dir) => ipcRenderer.invoke('pal:install', { host, dir }),
  // 管理页：update / uninstall / remove 只传名字，命令参数留在主进程。
  action: (name, action) => ipcRenderer.invoke('pal:action', { name, action }),
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
