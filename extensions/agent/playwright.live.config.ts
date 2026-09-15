import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/live',
  testMatch: 'viewer-direct-host.spec.ts',
  outputDir: '../../test-results/agent-live',
  reporter: 'list',
  forbidOnly: Boolean(process.env.CI),
  timeout: 30_000,
  expect: { timeout: 15_000 },
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 900 },
    baseURL: 'http://127.0.0.1:48123',
    trace: 'retain-on-failure',
  },
});
