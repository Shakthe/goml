import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

const ADMIN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const SHOTS = '../../evidence/screenshots';
let ipCounter = 10;

// Each browser context looks like a different customer to the gateway's per-IP limits.
async function customer(browser: Browser, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport, extraHTTPHeaders: { 'X-Forwarded-For': `100.70.0.${ipCounter++}` } });
  return ctx.newPage();
}

async function startSale(request: APIRequestContext, body: { stock: number; startsInSeconds: number; strategy?: string }) {
  const res = await request.post('/api/admin/sale', {
    headers: { 'X-Admin-Token': ADMIN, 'X-Forwarded-For': `100.71.0.${ipCounter++}` },
    data: { strategy: 'queue', ...body },
  });
  expect(res.status()).toBe(200);
  await new Promise((r) => setTimeout(r, 1200)); // let every API replica see the new sale
}

async function buyButton(page: Page) {
  return page.getByRole('button', { name: /buy now|opens at|sold out|placing|confirming|order confirmed|already ordered|try again/i });
}

test('before 8 PM: countdown is shown and buying is disabled', async ({ browser, request }) => {
  await startSale(request, { stock: 500, startsInSeconds: 2 * 3600 + 15 * 60 });
  const page = await customer(browser);
  await page.goto('/');
  await expect(page.getByRole('timer')).toBeVisible();
  await expect(page.getByText('Sale starts in')).toBeVisible();
  await expect(await buyButton(page)).toBeDisabled();
  await expect(page.getByText('Live updates')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/01-countdown.png` });

  const mobile = await customer(browser, { width: 390, height: 844 });
  await mobile.goto('/');
  await expect(mobile.getByRole('timer')).toBeVisible();
  await mobile.screenshot({ path: `${SHOTS}/01b-countdown-mobile.png`, fullPage: true });
});

test('the button unlocks by itself when the sale opens (pushed over SSE)', async ({ browser, request }) => {
  await startSale(request, { stock: 500, startsInSeconds: 4 });
  const page = await customer(browser);
  await page.goto('/');
  const btn = await buyButton(page);
  await expect(btn).toBeDisabled();
  await expect(btn).toBeEnabled({ timeout: 10_000 });
  await expect(btn).toHaveText(/Buy now/);
  await expect(page.getByText('Units left')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/02-live.png` });
});

test('rapid clicks send exactly one checkout request and the order is confirmed', async ({ browser, request }) => {
  await startSale(request, { stock: 500, startsInSeconds: 0 });
  const page = await customer(browser);
  let checkoutCalls = 0;
  page.on('request', (r) => { if (r.url().endsWith('/api/checkout')) checkoutCalls++; });
  await page.goto('/');
  const btn = await buyButton(page);
  await expect(btn).toBeEnabled();

  // Five clicks as fast as the browser can dispatch them.
  await btn.evaluate((el: HTMLButtonElement) => { for (let i = 0; i < 5; i++) el.click(); });
  await page.screenshot({ path: `${SHOTS}/03-placing-order.png` });
  await expect(page.getByText(/Your order .* is confirmed/)).toBeVisible({ timeout: 10_000 });
  await expect(btn).toHaveText('Order confirmed');
  expect(checkoutCalls).toBe(1);
  await expect(page.getByText('499')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/04-confirmed.png` });

  // Same customer after a refresh: one unit per customer.
  await page.reload();
  await (await buyButton(page)).click();
  await expect(page.getByText(/already have an order/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/05-already-ordered.png` });
});

test('the last unit goes to one buyer; the next buyer sees sold out', async ({ browser, request }) => {
  await startSale(request, { stock: 1, startsInSeconds: 0 });
  const first = await customer(browser);
  const second = await customer(browser);
  await first.goto('/');
  await second.goto('/');
  await (await buyButton(first)).click();
  await expect(first.getByText(/is confirmed/)).toBeVisible({ timeout: 10_000 });

  // The second shopper's page updates on its own over SSE.
  await expect(second.getByText('Sold out').first()).toBeVisible({ timeout: 5000 });
  await expect(await buyButton(second)).toBeDisabled();
  await second.screenshot({ path: `${SHOTS}/06-sold-out.png` });
});

test('ops page shows Redis, database and queue agreeing', async ({ browser, request }) => {
  await startSale(request, { stock: 500, startsInSeconds: 0 });
  const page = await customer(browser);
  await page.goto('/');
  await (await buyButton(page)).click();
  await expect(page.getByText(/is confirmed/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('link', { name: 'Ops' }).click();
  await expect(page.getByRole('heading', { name: 'Ops' })).toBeVisible();
  await expect(page.locator('.tile', { hasText: 'Confirmed orders' })).toContainText('1');
  await expect(page.locator('.tile', { hasText: 'Redis stock' })).toContainText('499');
  await expect(page.locator('.tile', { hasText: 'Database stock' })).toContainText('499');
  await page.screenshot({ path: `${SHOTS}/07-ops.png`, fullPage: true });
});
