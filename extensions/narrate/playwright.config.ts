import { defineConfig } from '@playwright/test';

const port = Number(process.env.REMUX_NARRATE_VIEW_TEST_PORT ?? 5183);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  outputDir: '../../test-results/narrate',
  reporter: 'line',
  testDir: './tests',
  testIgnore: 'narrate-playback-real.spec.ts',
  timeout: 45_000,
  use: {
    baseURL,
    colorScheme: 'dark',
    viewport: { height: 844, width: 390 },
  },
  webServer: {
    command: `npm run build && npx vite preview --config viewer/vite.config.ts --host 127.0.0.1 --port ${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    url: baseURL,
  },
  workers: 1,
});
