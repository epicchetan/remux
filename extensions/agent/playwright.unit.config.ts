import { defineConfig } from '@playwright/test';

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'list' : 'list',
  testDir: './tests/unit',
  testMatch: '*.test.ts',
  timeout: 10_000,
});
