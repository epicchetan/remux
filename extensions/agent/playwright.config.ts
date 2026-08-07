import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.REMUX_AGENT_VIEW_TEST_PORT ?? 5179);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  outputDir: '../../test-results/agent',
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { height: 900, width: 1280 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'], viewport: { height: 844, width: 390 } },
    },
  ],
  reporter: process.env.CI ? 'list' : 'list',
  testDir: './tests',
  testMatch: 'viewer*.spec.ts',
  timeout: 30_000,
  use: { baseURL, colorScheme: 'dark', trace: 'on-first-retry' },
  webServer: {
    command: `npx vite --config viewer/vite.config.ts --host 127.0.0.1 --port ${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    url: baseURL,
  },
});
