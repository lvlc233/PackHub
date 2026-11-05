/**
 * 视觉回归：对固定页面/视口截图，和 test/ui-baseline/<platform>/ 下的基线按像素比较。
 * 基线按平台存：不同系统的字体渲染不同，跨平台比像素没有意义。
 * 没有对应平台的基线时只提示跳过，不让新机器/CI 第一天就红。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import type { Browser } from 'playwright';

export interface VisualResult {
  checked: number;
  skipped: number;
  failures: string[];
}

interface Shot {
  name: string;
  path: string;
  width: number;
  height: number;
}

const SHOTS: Shot[] = [
  { name: 'home', path: '/', width: 1280, height: 800 },
  { name: 'packs', path: '/packs', width: 1280, height: 800 },
  { name: 'console', path: '/console', width: 1280, height: 800 },
  { name: 'home-mobile', path: '/', width: 390, height: 844 },
];

/** 允许的差异：抗锯齿/字体栅格化通常远低于这个比例；布局位移会远超。 */
const PIXEL_DELTA = 16;
const MAX_DIFF_RATIO = 0.035;
const MAX_MEAN_DELTA = 4;

export async function visualAudit(
  browser: Browser,
  base: string,
  opts: { baseline?: boolean; root?: string } = {},
): Promise<VisualResult> {
  const root = opts.root ?? resolve(process.cwd());
  const baselineDir = join(root, 'test', 'ui-baseline', process.platform);
  const diffDir = join(root, 'tmp', 'ui-diff');
  const result: VisualResult = { checked: 0, skipped: 0, failures: [] };

  if (opts.baseline) mkdirSync(baselineDir, { recursive: true });

  for (const shot of SHOTS) {
    const file = join(baselineDir, `${shot.name}.png`);
    const context = await browser.newContext({ viewport: { width: shot.width, height: shot.height } });
    const page = await context.newPage();
    try {
      await page.goto(`${base}${shot.path}`, { waitUntil: 'networkidle' });
      await page.addStyleTag({
        content:
          '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' +
          'html{scroll-behavior:auto!important}',
      });
      await page.evaluate(() => document.fonts?.ready);
      await page.waitForTimeout(200);
      const buffer = await page.screenshot({ fullPage: false });
      if (opts.baseline) {
        writeFileSync(file, buffer);
        result.checked++;
        console.log(`· 视觉基线已写入 ${file}`);
        continue;
      }
      if (!existsSync(file)) {
        result.skipped++;
        console.log(`- 视觉回归跳过 ${shot.name}：没有 ${process.platform} 基线（在对应平台跑 pnpm ui:baseline）`);
        continue;
      }
      const diff = compare(readFileSync(file), buffer);
      result.checked++;
      if (diff.dimensionMismatch) {
        result.failures.push(`${shot.name}: 尺寸变化 ${diff.dimensionMismatch}`);
        console.log(`x 视觉回归 ${shot.name}: 尺寸变化 ${diff.dimensionMismatch}`);
        saveDiff(diffDir, shot.name, buffer);
        continue;
      }
      if (diff.ratio > MAX_DIFF_RATIO || diff.mean > MAX_MEAN_DELTA) {
        result.failures.push(`${shot.name}: ${(diff.ratio * 100).toFixed(2)}% 像素不同，均值 ${diff.mean.toFixed(1)}`);
        console.log(
          `x 视觉回归 ${shot.name}: ${(diff.ratio * 100).toFixed(2)}% 像素不同（阈值 ${MAX_DIFF_RATIO * 100}%），均值 ${diff.mean.toFixed(1)}`,
        );
        saveDiff(diffDir, shot.name, buffer);
      } else {
        console.log(
          `✓ 视觉回归 ${shot.name}: ${(diff.ratio * 100).toFixed(2)}% 不同，均值 ${diff.mean.toFixed(1)}`,
        );
      }
    } finally {
      await context.close();
    }
  }

  return result;
}

interface DiffStats {
  ratio: number;
  mean: number;
  dimensionMismatch?: string;
}

function compare(expected: Buffer, actual: Buffer): DiffStats {
  const a = PNG.sync.read(expected);
  const b = PNG.sync.read(actual);
  if (a.width !== b.width || a.height !== b.height) {
    return {
      ratio: 1,
      mean: 255,
      dimensionMismatch: `${a.width}x${a.height} → ${b.width}x${b.height}`,
    };
  }
  let changed = 0;
  let total = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i]! - b.data[i]!),
      Math.abs(a.data[i + 1]! - b.data[i + 1]!),
      Math.abs(a.data[i + 2]! - b.data[i + 2]!),
    );
    total += d;
    if (d > PIXEL_DELTA) changed++;
  }
  return { ratio: changed / (a.width * a.height), mean: total / (a.width * a.height) };
}

function saveDiff(dir: string, name: string, actual: Buffer): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.actual.png`), actual);
}
