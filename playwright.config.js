import { defineConfig } from '@playwright/test';

const externalURL = process.env.PLAYWRIGHT_BASE_URL;
const authenticatedPreview = process.env.VERCEL_PREVIEW_TEST === '1';

export default defineConfig({
  testDir: './test',
  testMatch: 'browser.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: externalURL || 'http://127.0.0.1:4173',
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    locale: 'fa-IR',
    screenshot: 'only-on-failure',
    trace: authenticatedPreview ? 'off' : 'retain-on-failure',
  },
  webServer: externalURL ? undefined : {
    command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
