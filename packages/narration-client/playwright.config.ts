import { defineConfig } from '@playwright/test';

const workloadThreads = Number.parseInt(process.env.REMUX_WORKLOAD_THREADS ?? '', 10);

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: true,
  outputDir: '../../test-results/narration-client',
  reporter: process.env.CI ? 'list' : 'line',
  testDir: './tests',
  timeout: 10_000,
  workers: Number.isSafeInteger(workloadThreads) && workloadThreads > 0 ? workloadThreads : undefined,
});
