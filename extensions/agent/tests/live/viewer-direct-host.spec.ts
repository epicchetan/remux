import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('agent viewer connects directly to the live runtime', async ({ context, page, request }, testInfo) => {
  const health = await request.get('/readyz', { timeout: 3_000 }).catch(() => null);
  test.skip(health?.status() !== 200, 'Live Remux runtime is unavailable at 127.0.0.1:48123');
  const token = (await readFile(new URL('../../../../.remux/auth-token', import.meta.url), 'utf8')).trim();
  expect(token, 'Remux auth token must not be empty').not.toBe('');
  await context.addCookies([{
    name: 'remux_auth', value: token, url: 'http://127.0.0.1:48123', httpOnly: true, sameSite: 'Lax',
  }]);
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') console.error(`[console] ${message.text()}`); });
  page.on('pageerror', (error) => { errors.push(error.message); console.error(`[pageerror] ${error.message}`); });
  const response = await page.goto('/viewers/agent/');
  expect(response?.status()).toBe(200);
  await expect.poll(() => page.evaluate(() => window.__REMUX_DIRECT_HOST__ ?? null), {
    message: 'The served viewer must contain the direct host and complete its WebSocket handshake',
  }).toMatchObject({ status: { type: 'connected' }, error: null });
  await expect(page.locator('main.agent-app[data-connection="connected"]')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Boolean(window.ReactNativeWebView))).toBe(false);
  expect(errors).toEqual([]);
  const screenshot = testInfo.outputPath('viewer-direct-host.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('direct host viewer', { path: screenshot, contentType: 'image/png' });
  console.log(`Live direct host connected; screenshot: ${screenshot}`);
});
