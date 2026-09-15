import { expect, test, type Page } from '@playwright/test';
import { installAgentHost, FIXTURE_CONVERSATION_ID } from './viewer-fixture';

const url = `/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}`;
const editor = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const send = (page: Page) => page.getByRole('button', { name: 'Send message', exact: true });
const preferences = (page: Page) => page.getByRole('button', { name: 'Preferences', exact: true });
const delivery = (page: Page) => page.getByRole('button', { name: 'Delivery', exact: true });
const requests = (page: Page) => page.evaluate(() => (window as any).__agentFixture.requestLog
  .filter((entry: any) => entry.method === 'remux/agent/conversation/message/send').map((entry: any) => JSON.parse(entry.summary)));
test.beforeEach(async ({ page }) => installAgentHost(page));

test('one click sends auto during an active turn', async ({ page }) => {
  await page.goto(`${url}&fixtureRunning=1&fixtureActiveInput=1`);
  await editor(page).fill('A deliberate follow-up');
  await expect(send(page)).not.toHaveAttribute('aria-haspopup', 'menu');
  await send(page).click();
  await expect.poll(async () => (await requests(page)).map((request: any) => request.delivery)).toEqual(['auto']);
});

test('Delivery config row queues once and resets to Reply now after send', async ({ page }) => {
  await page.goto(`${url}&fixtureRunning=1&fixtureActiveInput=1`);
  await editor(page).fill('Next turn explicitly');
  await preferences(page).click();
  await delivery(page).click();
  await page.getByRole('button', { name: 'Queue for next turn', exact: true }).click();
  expect(await requests(page)).toHaveLength(0);
  await page.keyboard.press('Escape');
  await send(page).click();
  await expect.poll(async () => (await requests(page))[0]?.delivery).toBe('queue');
  await expect(editor(page)).toBeEmpty();
  await editor(page).fill('Automatic again');
  await send(page).click();
  await expect.poll(async () => (await requests(page)).map((request: any) => request.delivery)).toEqual(['queue', 'auto']);
});

for (const suffix of ['', '&fixtureRunning=1', '&fixtureCompactEligibility=queued']) {
  test(`Delivery row visibility follows active turn or pending work: ${suffix || 'idle'}`, async ({ page }) => {
    await page.goto(`${url}${suffix}`);
    await preferences(page).click();
    await expect(delivery(page)).toHaveCount(suffix ? 1 : 0);
  });
}

test('background children alone leave Delivery hidden and Send automatic', async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__agentFixture.setRuntimeLifecycle({ state: 'running', runningCount: 2 }));
  await preferences(page).click();
  await expect(delivery(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await editor(page).fill('Talk while children work');
  await send(page).click();
  await expect.poll(async () => (await requests(page))[0]?.delivery).toBe('auto');
});

test('delivery reason is visible in the footer: Earlier queued work', async ({ page }) => {
  await page.goto(`${url}&fixtureRunning=1&fixtureActiveInput=1`);
  await editor(page).fill('First, for the next turn');
  await preferences(page).click();
  await delivery(page).click();
  await page.getByRole('button', { name: 'Queue for next turn', exact: true }).click();
  await page.keyboard.press('Escape');
  await send(page).click();
  await expect.poll(async () => (await requests(page))[0]?.delivery).toBe('queue');
  await editor(page).fill('Second, while the first waits');
  await expect(page.locator('.remux-composer-inline-status')).toContainText('Earlier queued work');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

for (const [suffix, reason] of [
  ['', 'This provider cannot accept'],
  ['&fixtureActiveInput=1&fixtureCompactEligibility=queued', 'wait for compaction'],
  ['&fixtureActiveInput=1&fixtureCompactEligibility=running', 'wait for compaction'],
  ['&fixtureActiveInput=1&fixtureCompactEligibility=held', 'Previous delivery is unconfirmed'],
]) {
  test(`delivery reason is visible in the footer: ${reason} (${suffix || 'no active input'})`, async ({ page }) => {
    await page.goto(`${url}&fixtureRunning=1${suffix}`);
    await editor(page).fill('Preserve ordering');
    await expect(page.locator('.remux-composer-inline-status')).toContainText(reason);
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
}

test('Delivery is keyboard reachable and Escape preserves the draft', async ({ page }) => {
  await page.goto(`${url}&fixtureRunning=1&fixtureActiveInput=1`);
  await editor(page).fill('Keep this draft');
  await preferences(page).focus();
  await page.keyboard.press('Enter');
  await delivery(page).focus();
  await page.keyboard.press('Enter');
  const queue = page.getByRole('button', { name: 'Queue for next turn', exact: true });
  await queue.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-remux-composer-config-panel]')).toHaveCount(0);
  await expect(editor(page)).toHaveText('Keep this draft');
  expect(await requests(page)).toHaveLength(0);
});

test('queue intent survives the parent ending before send', async ({ page }) => {
  await page.goto(`${url}&fixtureRunning=1&fixtureActiveInput=1`);
  await editor(page).fill('Next turn explicitly');
  await preferences(page).click();
  await delivery(page).click();
  await page.getByRole('button', { name: 'Queue for next turn', exact: true }).click();
  await page.evaluate(() => (window as any).__agentFixture.completeLatestRunningTurn());
  await page.keyboard.press('Escape');
  await send(page).click();
  await expect.poll(async () => (await requests(page))[0]?.delivery).toBe('queue');
});

test('autonomous continuation renders a compact read-only divider', async ({ page }) => {
  await page.goto(`${url}&fixtureContinuation=1`);
  const notice = page.locator('[data-row-kind="notice"]');
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText('Continued after Astra finished');
  await expect(notice).toContainText('20s');
  await expect(notice.getByRole('button')).toHaveCount(0);
  await expect(notice.locator('[data-client-message-id]')).toHaveCount(0);
});
