// Takes screenshots of the ops page at given moments, e.g. while a k6 run is in progress.
// Usage: node capture-ops.mjs <name> <seconds,seconds,...>
import { chromium } from '@playwright/test';

const [name = 'ops', at = '0'] = process.argv.slice(2);
const base = process.env.BASE_URL ?? 'http://localhost:8080';
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, extraHTTPHeaders: { 'X-Forwarded-For': '100.72.0.1' } });
await page.goto(`${base}/ops`);
await page.getByRole('heading', { name: 'Ops' }).waitFor();
let elapsed = 0;
for (const t of at.split(',').map(Number)) {
  await page.waitForTimeout((t - elapsed) * 1000);
  elapsed = t;
  const file = `../../evidence/screenshots/${name}-${t}s.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`saved ${file}`);
}
await browser.close();
