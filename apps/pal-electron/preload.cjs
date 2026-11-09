// 最小 preload：只暴露只读的 platform，不接 API（IPC 业务桥在 E2）。
'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('pal', {
  platform: process.platform,
});
