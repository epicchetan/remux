import { expect, test, type Page } from '@playwright/test';
import { installAgentHost, FIXTURE_CONVERSATION_ID } from './viewer-fixture';

const url = `/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}`;
const editor = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const trigger = (page: Page) => page.getByRole('button', { name: 'Choose message delivery', exact: true });
const requests = (page: Page) => page.evaluate(() => (window as any).__agentFixture.requestLog
  .filter((entry: any) => entry.method === 'remux/agent/conversation/message/send').map((entry: any) => JSON.parse(entry.summary)));
test.beforeEach(async ({ page }) => installAgentHost(page));

for (const [label, delivery] of [['Send to current turn', 'auto'], ['Queue for next turn', 'queue']] as const) {
  test(`Send opens options without dispatch; ${label} submits exactly once`, async ({ page }) => {
    await page.goto(`${url}&fixtureRunning=1&fixtureActiveInput=1`);
    await editor(page).fill('A deliberate follow-up');
    await trigger(page).click();
    await expect(page.getByRole('menu', { name: 'Message delivery' })).toBeVisible();
    expect(await requests(page)).toHaveLength(0);
    await expect(editor(page)).toHaveText('A deliberate follow-up');
    await expect(page.getByRole('menuitem')).toHaveCount(2);
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await expect.poll(async () => (await requests(page)).map((request: any) => request.delivery)).toEqual([delivery]);
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
}

test('unsupported active input offers queueing with an explanation', async ({ page }) => {
  await page.goto(`${url}&fixtureRunning=1`);
  await editor(page).fill('Next response');
  await trigger(page).click();
  await expect(page.getByRole('menuitem')).toHaveCount(1);
  await expect(page.getByRole('menuitem', { name: 'Queue for next turn', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'This provider cannot accept' })).toBeVisible();
});

for (const state of ['queued', 'running', 'held']) {
  test(`${state} delivery never offers a bypass`, async ({ page }) => {
    await page.goto(`${url}&fixtureRunning=1&fixtureActiveInput=1&fixtureCompactEligibility=${state}`);
    await editor(page).fill('Preserve operation ordering');
    await trigger(page).click();
    await expect(page.getByRole('menuitem', { name: 'Send to current turn', exact: true })).toHaveCount(0);
    if (state === 'held') {
      await expect(page.getByRole('menuitem')).toHaveCount(0);
      await expect(page.getByRole('menu')).toContainText('Previous delivery is unconfirmed');
    } else {
      await page.getByRole('menuitem', { name: 'Queue after pending work', exact: true }).click();
      await expect.poll(async () => (await requests(page))[0]?.delivery).toBe('queue');
    }
  });
}

test('background children alone keep ordinary Send', async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__agentFixture.setRuntimeLifecycle({ state: 'running', runningCount: 2 }));
  await editor(page).fill('Talk while children work');
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await expect(send).not.toHaveAttribute('aria-haspopup', 'menu');
  await send.click();
  await expect.poll(async () => (await requests(page))[0]?.delivery).toBe('auto');
});

test('menu supports keyboard selection, Escape, and History without losing the draft', async ({ page }, testInfo) => {
  await page.goto(`${url}&fixtureRunning=1&fixtureActiveInput=1`);
  await editor(page).fill('Keep this draft');
  await trigger(page).focus();
  await trigger(page).press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Send to current turn', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Queue for next turn', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger(page)).toBeFocused();
  await expect(editor(page)).toHaveText('Keep this draft');
  if (testInfo.project.name === 'mobile') {
    await trigger(page).click();
    await page.getByRole('button', { name: 'Open history', exact: true }).click();
    await expect(page.getByRole('menu', { name: 'Message delivery' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveText('Keep this draft');
  }
  expect(await requests(page)).toHaveLength(0);
});

test('parent completion while the menu is open preserves an explicit queue choice', async ({ page }) => {
  await page.goto(`${url}&fixtureRunning=1&fixtureActiveInput=1`);
  await editor(page).fill('Next turn explicitly');
  await trigger(page).click();
  await page.evaluate(() => (window as any).__agentFixture.completeLatestRunningTurn());
  await expect(page.getByRole('menuitem', { name: 'Send message', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Queue for next turn', exact: true }).click();
  await expect.poll(async () => (await requests(page))[0]?.delivery).toBe('queue');
});

test('eligibility changes disable current delivery without moving queue under the pointer', async ({ page }) => {
  await page.goto(`${url}&fixtureRunning=1&fixtureActiveInput=1`);
  await editor(page).fill('Still my draft');
  await trigger(page).click();
  const current = page.getByRole('menuitem', { name: 'Send to current turn', exact: true });
  await page.evaluate(() => (window as any).__agentFixture.setDeliveryState({
    compaction: { policy: 'native-auto', pendingPhase: 'requested',
      operation: { state: 'running', operationId: 'new-compact', trigger: 'manual', startedAt: 1 } },
  }));
  await expect(current).toHaveAttribute('aria-disabled', 'true');
  await current.evaluate((element: HTMLElement) => element.click());
  expect(await requests(page)).toHaveLength(0);
  await expect(page.getByRole('menuitem')).toHaveCount(2);
  await page.getByRole('menuitem', { name: 'Queue after pending work', exact: true }).click();
  await expect.poll(async () => (await requests(page))[0]?.delivery).toBe('queue');
});

test('a parent ending between trigger press and release still opens options without sending', async ({ page }) => {
  await page.goto(`${url}&fixtureRunning=1&fixtureActiveInput=1`);
  await editor(page).fill('Do not send on this first press');
  const box = (await trigger(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() => (window as any).__agentFixture.completeLatestRunningTurn());
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await page.mouse.up();
  await expect(page.getByRole('menu', { name: 'Message delivery' })).toBeVisible();
  expect(await requests(page)).toHaveLength(0);
});

for (const width of [320, 390]) {
  test(`delivery options fit ${width}px without moving toolbar controls`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto(`${url}&fixtureRunning=1&fixtureActiveInput=1`);
    await editor(page).fill('A narrow-screen follow-up');
    const history = page.getByRole('button', { name: 'Open history', exact: true });
    const before = await history.boundingBox();
    await trigger(page).click();
    expect(await history.boundingBox()).toEqual(before);
    const box = (await page.getByRole('menu', { name: 'Message delivery' }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    if (width === 390) await page.screenshot({ path: '/tmp/remux-send-delivery-menu.png' });
  });
}

test('a resolved hold explains how to reopen choices without inserting an action under the pointer', async ({ page }) => {
  await page.goto(`${url}&fixtureRunning=1&fixtureActiveInput=1&fixtureCompactEligibility=held`);
  await editor(page).fill('Send only after I choose');
  await trigger(page).click();
  await page.evaluate(() => (window as any).__agentFixture.setDeliveryState({ deliveryHeld: false }));
  await expect(page.getByRole('menu')).toContainText('Delivery is available again');
  await expect(page.getByRole('menuitem')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await trigger(page).click();
  await expect(page.getByRole('menuitem')).toHaveCount(2);
  expect(await requests(page)).toHaveLength(0);
});
