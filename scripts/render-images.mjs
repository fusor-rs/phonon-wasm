// Renders the README's images, light and dark, with the e2e's Playwright (`cd e2e && npm ci`
// first): assets/brand/banner.html into banner.png and banner-dark.png, and
// assets/benchmarks/benchmarks.html into benchmarks.png and benchmarks-dark.png.
import { chromium } from '../e2e/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';

const IMAGES = [
  { page: '../assets/brand/banner.html', width: 1280, height: 400, name: 'banner' },
  { page: '../assets/benchmarks/benchmarks.html', width: 1400, height: 1250, name: 'benchmarks' },
];

const browser = await chromium.launch();
for (const { page, width, height, name } of IMAGES) {
  const source = new URL(page, import.meta.url);
  const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  for (const [theme, suffix] of [['light', ''], ['dark', '-dark']]) {
    await tab.goto(`${source.href}?theme=${theme}`);
    await tab.screenshot({ path: fileURLToPath(new URL(`${name}${suffix}.png`, source)) });
  }
  await tab.close();
}
await browser.close();
