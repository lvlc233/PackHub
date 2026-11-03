#!/usr/bin/env node
// 用无头 Chrome 截真实渲染图，并可选点一次按钮。仅开发时用。
// 用法：node scripts/shoot.mjs <url> <out.png> [clickText] [waitMs] [width] [height]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out, clickText, waitMs = '900', width = '1440', height = '1000'] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: shoot.mjs <url> <out.png> [clickText] [waitMs] [width] [height]');
  process.exit(2);
}

const CHROME =
  process.env.CHROME ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9300 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'ph-shot-'));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function devtools(path, init) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error('Chrome DevTools 未就绪');
}

try {
  const target = await devtools(`/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: Number(width),
    height: Number(height),
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url });
  await sleep(1400);

  if (clickText) {
    for (const text of clickText.split('|')) {
      const clicked = await send('Runtime.evaluate', {
        expression: `(() => {
          const el = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(${JSON.stringify(text)}));
          if (!el) return 'not-found';
          el.click();
          return 'clicked';
        })()`,
        returnByValue: true,
      });
      console.log(`click "${text}": ${clicked.result.value}`);
      await sleep(Number(waitMs));
    }
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`screenshot ${out}`);
  ws.close();
} finally {
  chrome.kill();
}
