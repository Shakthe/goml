import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  workers: 1, // tests share one sale, so they run one after another
  reporter: [['list'], ['html', { outputFolder: '../../evidence/e2e/report', open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:8080',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  // Uses the installed Chrome when available (PW_CHANNEL=chrome), otherwise Playwright's Chromium.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, channel: process.env.PW_CHANNEL } }],
});
