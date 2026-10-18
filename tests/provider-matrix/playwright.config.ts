import { defineConfig } from '@playwright/test';

const stacks = (
  process.env.WALDEN_MATRIX_STACKS ??
  `node,cloudflare${process.env.WALDEN_TEST_S3_ENDPOINT ? ',mixed' : ''}`
).split(',');
export default defineConfig({
  testDir: '.',
  testMatch: 'matrix.spec.ts',
  outputDir: '../../test-results/provider-matrix',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: '../../playwright-report/provider-matrix', open: 'never' }],
  ],
  use: {
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: stacks.map((name) => ({ name })),
});
