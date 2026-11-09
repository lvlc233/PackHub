// 最小 preload（E2）：暴露只读的 platform 和唯一的 API 桥 request。
//
// 页面里的 api.js 只认 `globalThis.pal.request(path, options)`：
//   transport 形状 = (path, request) => Promise<{ ok, status, text } | { ok: false, error }>
// 这里把 (path, options) 原样转给主进程的 `pal:request`；转发与放行规则都在主进程（forward.mjs）。
// 只传结构化可序列化的数据：method / headers（字符串值）/ body（字符串）。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 只保留可结构化克隆的字段，别让函数、DOM 节点之类的悄悄过桥。 */
function plainOptions(options) {
  const src = options && typeof options === 'object' ? options : {};
  const headers = {};
  if (src.headers && typeof src.headers === 'object') {
    for (const [key, value] of Object.entries(src.headers)) {
      if (typeof value === 'string') headers[key] = value;
    }
  }
  const out = { method: typeof src.method === 'string' && src.method ? src.method : 'GET', headers };
  if (typeof src.body === 'string') out.body = src.body;
  return out;
}

contextBridge.exposeInMainWorld('pal', {
  platform: process.platform,
  request: (path, options) =>
    ipcRenderer.invoke('pal:request', {
      path: typeof path === 'string' ? path : String(path ?? ''),
      options: plainOptions(options),
    }),
});
