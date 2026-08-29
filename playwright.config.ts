import { defineConfig } from '@playwright/test';

const baseURL = process.env.TRUEFORGE_BASE_URL ?? 'http://127.0.0.1:8790';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ['line'],
    [
      'html',
      { open: 'never', outputFolder: 'evidence/artifacts/playwright-report' },
    ],
  ],
  outputDir: 'evidence/artifacts/playwright-results',
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
