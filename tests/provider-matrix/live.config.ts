import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'live.spec.ts',
  outputDir: '../../test-results/provider-live',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 90_000 },
  reporter: [['list']],
  use: { browserName: 'chromium', headless: true, screenshot: 'only-on-failure' },
});
