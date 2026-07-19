import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  outputDir: '../../test-results/narrate-playback-real',
  projects: [{
    name: 'real-chromium',
    use: {
      ...devices['Desktop Chrome'],
      viewport: { height: 844, width: 390 },
    },
  }],
  reporter: 'list',
  testDir: './tests',
  testMatch: 'narrate-playback-real.spec.ts',
  timeout: 240_000,
  use: {
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
  workers: 1,
});
