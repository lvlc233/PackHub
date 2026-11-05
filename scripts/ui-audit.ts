/**
 * 界面审计：在真实 Chromium 里跑 390 / 1280 两个宽度。
 * 检查：横向溢出（窄屏塌不塌）与 axe 的结构性违规（严重/致命才失败）。
 * 用法：pnpm ui:audit（需要先 pnpm web:build）
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { defaultStaticDir, startServer } from '../apps/local/src/server.ts';
import { visualAudit } from './ui-visual.ts';

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
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));
      await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
      const bodyText = (await page.locator('body').innerText()).trim();
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return Math.max(doc.scrollWidth, document.body.scrollWidth) - window.innerWidth;
      });
      const axe = await new AxeBuilder({ page }).analyze();
      const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      const label = `${viewport.name} ${path}`;
      if (bodyText.length === 0) {
        failures++;
        console.log(`x ${label}: 页面是空的（渲染失败？）`);
      }
      for (const message of pageErrors) {
        failures++;
        console.log(`x ${label}: 未捕获异常 — ${message.split('\n')[0]}`);
      }
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

  const visual = await visualAudit(browser, base, { baseline: process.argv.includes('--baseline'), root });
  failures += visual.failures.length;
  const testDir = 'tmp/ui-audit-pack';
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${base}/console`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '+ 新增资源' }).click();
    await page.getByRole('textbox', { name: '目录', exact: false }).fill(testDir);
    await page.getByRole('button', { name: '保存到目录' }).click();
    await page.getByRole('status').filter({ hasText: '已保存到' }).waitFor({ timeout: 10_000 });
    if (!existsSync(join(root, testDir, 'packhub.yaml'))) {
      failures++;
      console.log('x 创作台保存：没有写出 packhub.yaml');
    } else {
      console.log('✓ 创作台保存：新增资源 → 保存到目录');
    }

    // YAML 反向编辑：改标题 → 应用回表单 → 保存，文件里应是新标题
    const yamlDir = 'tmp/ui-audit-yaml';
    try {
      await page.getByText('直接编辑 yaml（可应用回表单）').click();
      await page.locator('.cs-yaml-edit').fill(`apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: me/yaml-e2e
  version: 0.1.0
  title: YAML 改过的标题
  description: 从 YAML 回填
  targets: [dir]
  visibility: public
requires:
  packhub: ">=0.0.1 <0.1"
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`);
      await page.getByRole('button', { name: '应用 YAML' }).click();
      const title = await page
        .locator('.cs-form label')
        .filter({ hasText: '标题' })
        .locator('input')
        .inputValue();
      if (title !== 'YAML 改过的标题') throw new Error(`标题没回填：${title}`);
      await page.getByRole('textbox', { name: '目录', exact: false }).fill(yamlDir);
      await page.getByRole('button', { name: '保存到目录' }).click();
      await page.getByRole('status').filter({ hasText: yamlDir }).waitFor({ timeout: 10_000 });
      const saved = readFileSync(join(root, yamlDir, 'packhub.yaml'), 'utf8');
      if (!saved.includes('YAML 改过的标题')) throw new Error('保存的 YAML 里没有新标题');
      console.log('✓ 创作台 YAML 反向编辑：改 YAML → 回填表单 → 保存');
    } catch (err) {
      failures++;
      console.log(`x 创作台 YAML 反向编辑失败：${(err as Error).message}`);
    } finally {
      rmSync(join(root, yamlDir), { recursive: true, force: true });
    }

    await page.close();
  } catch (err) {
    failures++;
    console.log(`x 创作台保存流程失败：${(err as Error).message}`);
  } finally {
    rmSync(join(root, testDir), { recursive: true, force: true });
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