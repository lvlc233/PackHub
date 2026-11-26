import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pal', {
  list: () => ipcRenderer.invoke('pal:list'),
  hosts: () => ipcRenderer.invoke('pal:hosts'),
  start: (name, mode) => ipcRenderer.invoke('pal:start', { name, mode }),
  stop: (name) => ipcRenderer.invoke('pal:stop', { name }),
  install: (host) => ipcRenderer.invoke('pal:install', { host }),
  openExternal: (url) => ipcRenderer.invoke('pal:open-external', { url }),
  termStart: (name, cols, rows) => ipcRenderer.invoke('term:start', { name, cols, rows }),
  termInput: (data) => ipcRenderer.send('term:input', { data }),
  termResize: (cols, rows) => ipcRenderer.send('term:resize', { cols, rows }),
  termKill: () => ipcRenderer.invoke('term:kill'),
  onTermData: (fn) => ipcRenderer.on('term:data', (_event, data) => fn(data)),
  onTermExit: (fn) => ipcRenderer.on('term:exit', (_event, payload) => fn(payload)),
});
