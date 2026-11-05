/**
 * 界面审计：在真实 Chromium 里跑 390 / 1280 两个宽度。
 * 检查：横向溢出（窄屏塌不塌）与 axe 的结构性违规（严重/致命才失败）。
 * 用法：pnpm ui:audit（需要先 pnpm web:build）
 */
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { defaultStaticDir, startServer } from '../apps/local/src/server.ts';

const root = resolve(process.cwd());
const staticDir = defaultStaticDir();
const server = await startServer({ root, port: 0, staticDir });
const addr = server.address();
const port = typeof addr === 'object' && addr ? addr.port : 0;
const base = `http://127.0.0.1:${port}`;

const pages = ['/', '/packs', '/console'];
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
];

const browser = await chromium.launch();
let failures = 0;
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
    });
    const page = await context.newPage();
    for (const path of pages) {
      await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return Math.max(doc.scrollWidth, document.body.scrollWidth) - window.innerWidth;
      });
      const axe = await new AxeBuilder({ page }).analyze();
      const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      const label = `${viewport.name} ${path}`;
      if (overflow > 1) {
        failures++;
        console.log(`x ${label}: 横向溢出 ${overflow}px`);
      } else {
        console.log(`✓ ${label}: 无横向溢出`);
      }
      for (const v of serious) {
        failures++;
        console.log(`x ${label}: [${v.impact}] ${v.id} — ${v.help}（${v.nodes.length} 处）`);
        for (const node of v.nodes.slice(0, 3)) console.log(`    ${node.target.join(' ')}`);
      }
      if (serious.length === 0) console.log(`  axe：没有 serious/critical 违规（共 ${axe.violations.length} 条）`);
    }
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}

if (failures > 0) {
  console.error(`\n界面审计失败：${failures} 项`);
  process.exit(1);
}
console.log('\n界面审计通过：窄屏无横向溢出，axe 无严重违规');