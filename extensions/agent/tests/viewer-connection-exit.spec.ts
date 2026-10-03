import { expect, test, type Page } from '@playwright/test';
import { installAgentHost } from './viewer-fixture';

test.beforeEach(async ({ page }) => { await installAgentHost(page); });

async function exitToTabs(page: Page) {
  const exit = page.getByRole('button', { name: 'Exit to Tabs', exact: true });
  await expect(exit).toBeVisible();
  await expect(exit).toBeEnabled();
  await exit.click();
  await expect.poll(() => page.evaluate(() => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string; summary: string }) => entry.method === 'host/overview/open')
    .map((entry: { summary: string }) => JSON.parse(entry.summary)))).toEqual([{ section: 'tabs' }]);
}

test('can leave while Agent resource requests are still pending', async ({ page }) => {
  await page.goto('/?fixtureHoldAgentResources=1');
  await expect(page.getByText('Connecting to agent runtime…')).toBeVisible();
  await exitToTabs(page);
  await expect(page.getByText('Connecting to agent runtime…')).toBeVisible();
});

test('can leave while the Remux connection is unavailable', async ({ page }) => {
  await page.goto('/?fixtureHostDisconnected=1&fixtureHoldAgentResources=1');
  await expect(page.getByText('Reconnecting to Remux…')).toBeVisible();
  await exitToTabs(page);
});

test('can leave from a failed initial Agent connection without retrying it', async ({ page }) => {
  await page.goto('/?fixtureResourceFailure=1');
  await expect(page.getByRole('heading', { name: 'Agent runtime unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
  await exitToTabs(page);
});

test('can leave while the provider is signed out', async ({ page }) => {
  await page.goto('/?fixtureSignedOut=1');
  await expect(page.getByRole('button', { name: 'Sign in with device code' })).toBeVisible();
  await exitToTabs(page);
});
