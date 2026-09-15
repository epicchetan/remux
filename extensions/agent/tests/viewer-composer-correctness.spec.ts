import { expect, test, type Page } from '@playwright/test';

import { installAgentHost } from './viewer-fixture';

test.beforeEach(async ({ page }) => {
  await installAgentHost(page);
});

for (const effort of ['unfamiliar', 'off']) {
  test(`submits advertised ${effort} effort unchanged`, async ({ page }) => {
    await page.goto(`/viewers/agent/?fixtureEffort=${effort}`);
    await page.getByRole('button', { name: 'Preferences' }).click();
    await page.getByRole('group', { name: 'Reasoning effort', exact: true }).getByRole('button').click();
    await expect(page.locator('.remux-composer-config-option', {
      hasText: effort === 'off' ? /^Off$/u : /^Unfamiliar$/u,
    })).toBeVisible();
    if (effort !== 'off') {
      await expect(page.locator('.remux-composer-config-option', { hasText: /^Off$/u })).toHaveCount(0);
    }
    await page.keyboard.press('Escape');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Use the native effort');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => (await lastParams(page, 'remux/agent/conversation/create'))?.effort)
      .toBe(effort);
    await expect.poll(async () => (await lastParams(page, 'remux/agent/conversation/message/send'))?.effort)
      .toBe(effort);
  });
}

test('hides reasoning and omits effort when the model advertises none', async ({ page }) => {
  await page.goto('/viewers/agent/?fixtureEffort=none');
  await page.getByRole('button', { name: 'Preferences' }).click();
  await expect(page.getByRole('group', { name: 'Reasoning effort', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('No effort');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => {
    const params = await lastParams(page, 'remux/agent/conversation/create');
    return params ? Object.hasOwn(params, 'effort') : null;
  }).toBe(false);
  await expect.poll(async () => (await lastParams(
    page, 'remux/agent/conversation/message/send'
  ))?.effort).toBeNull();
});

test('allows effort selection when the current effort is absent', async ({ page }) => {
  await page.goto('/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=11111111-1111-4111-8111-111111111111&fixtureCurrentEffortNull=1');
  await page.getByRole('button', { name: 'Preferences' }).click();
  const group = page.getByRole('group', { name: 'Reasoning effort', exact: true });
  await expect(group).toBeVisible();
  await group.getByRole('button').click();
  await page.getByRole('button', { name: 'Medium', exact: true }).click();
  await expect.poll(async () => (await lastParams(
    page, 'remux/agent/composer/conversation-preference/set'
  ))?.effort).toBe('medium');
});

test('restores new-chat text and access after switching through a conversation', async ({ page, isMobile }) => {
  await page.goto('/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=11111111-1111-4111-8111-111111111111');
  let history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: 'Start new chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Retain this draft');
  await page.getByRole('button', { name: 'Preferences' }).click();
  await page.getByRole('button', { name: 'Workspace write', exact: true }).click();
  await page.getByRole('button', { name: 'Read only', exact: true }).click();

  history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /^Resume this conversation/u }).click();
  await page.getByRole('button', { name: 'Preferences' }).click();
  await expect(page.getByRole('button', { name: 'Workspace write', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /New chat Draft/u }).click();
  await expect.poll(() => page.getByRole('textbox', { name: 'Message', exact: true })
    .evaluate((element) => (element as HTMLElement).innerText)).toBe('Retain this draft');
  await page.getByRole('button', { name: 'Preferences' }).click();
  await expect(page.getByRole('button', { name: 'Read only', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await lastParams(page, 'remux/agent/conversation/create'))?.access)
    .toBe('read-only');
});

test('persists an access-only draft change through reload', async ({ page }) => {
  await page.goto('/viewers/agent/?fixtureDelayModels=1');
  await page.getByRole('button', { name: 'Preferences' }).click();
  await page.getByRole('button', { name: 'Workspace write', exact: true }).click();
  await page.getByRole('button', { name: 'Read only', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Preferences' }).click();
  await expect(page.getByRole('button', { name: 'Read only', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep access');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await lastParams(page, 'remux/agent/conversation/create'))?.access)
    .toBe('read-only');
});

for (const state of ['queued', 'running', 'unresumable', 'held']) {
  test(`disables compact for a ${state} conversation`, async ({ page }) => {
    await page.goto(`/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=11111111-1111-4111-8111-111111111111&fixtureCompactEligibility=${state}`);
    await page.getByRole('button', { name: 'Show usage details' }).click();
    await expect(page.locator('.remux-composer-usage-compact')).toBeDisabled();
  });
}

test('submits compact for an eligible conversation', async ({ page }) => {
  await page.goto('/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=11111111-1111-4111-8111-111111111111&fixtureCompactEligibility=eligible');
  await page.getByRole('button', { name: 'Show usage details' }).click();
  await page.getByRole('button', { name: 'Compact', exact: true }).click();
  await expect.poll(async () => Boolean(await lastParams(page, 'remux/agent/conversation/compact'))).toBe(true);
});

async function lastParams(page: Page, method: string) {
  return page.evaluate((value) => {
    const request = (window as any).__agentFixture.requestLog
      .findLast((entry: { method: string }) => entry.method === value);
    return request ? JSON.parse(request.summary) : null;
  }, method);
}

async function openHistory(page: Page, isMobile: boolean) {
  if (isMobile) {
    await page.getByRole('button', { name: 'Open history' }).click();
    return page.getByRole('dialog');
  }
  return page.getByLabel('Agent history');
}

test('provider rejection preserves the draft and ends transcript synchronization recovery', async ({ page }) => {
  await page.goto('/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=11111111-1111-4111-8111-111111111111&fixtureDeliveryRejected=1');
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Keep my cleanup instructions');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The provider did not accept this message. Your text is saved; remove its queued entry before resending.', { exact: true })).toBeVisible();
  await expect(message).toHaveText('Keep my cleanup instructions');
  await expect(page.getByText('The message was accepted. Retry to finish syncing its conversation.', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(message).toHaveText('Keep my cleanup instructions');
  await expect.poll(async () => page.evaluate(() => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === 'remux/agent/conversation/message/send').length)).toBe(0);
});

test('current-turn delivery requests auto; reloaded pending work retains queue order', async ({ page }) => {
  await page.goto(`/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=11111111-1111-4111-8111-111111111111&fixtureRunning=1&fixtureActiveInput=1`);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Respond while the child works');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const request = (window as any).__agentFixture.requestLog.findLast((entry: any) =>
      entry.method === 'remux/agent/conversation/message/send');
    return request ? JSON.parse(request.summary).delivery : null;
  })).toBe('auto');
  await page.goto(`/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=11111111-1111-4111-8111-111111111111&fixtureRunning=1`);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Wait for the next turn');
  await expect(page.getByRole('button', { name: 'Queue for next turn', exact: true })).toHaveCount(0);
  await expect(page.locator('.remux-composer-inline-status')).toContainText('Earlier queued work goes first.');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
});

test('uncertain delivery exposes the saved message and requires an explicit recovery action', async ({ page }) => {
  await page.goto('/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=11111111-1111-4111-8111-111111111111&fixtureUncertainDelivery=1&fixtureRunning=1');
  await expect(page.getByText('Message delivery is unconfirmed.', { exact: true })).toBeVisible();
  const work = page.getByRole('button', { name: 'Waiting for recovery', exact: true });
  await expect(work).toBeVisible();
  if (await work.getAttribute('aria-expanded') !== 'true') await work.click();
  await expect(page.locator('.agent-execution-scope').first()).toHaveAttribute('data-state', 'recovering');
  await expect(page.getByText(/^Working for/u)).toHaveCount(0);
  await expect(page.locator('.agent-thinking-placeholder')).toHaveCount(0);
  expect(await lastParams(page, 'remux/agent/conversation/delivery/resolve')).toBeNull();
  await page.getByRole('button', { name: 'Review delivery', exact: true }).click();
  await expect(page.getByText('How are our actions going to work?', { exact: true })).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'Delivery recovery', exact: true });
  await expect(dialog).toBeInViewport({ ratio: 1 });
  const resolution = page.getByRole('button', { name: 'End interrupted turn without resending', exact: true });
  await expect(resolution).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await lastParams(page, 'remux/agent/conversation/delivery/resolve')).toBeNull();
  await page.getByRole('button', { name: 'Review delivery', exact: true }).click();
  await resolution.click();
  await expect.poll(async () => (await lastParams(page, 'remux/agent/conversation/delivery/resolve'))?.action).toBe('abandon');
  await expect(page.getByText('Message delivery is unconfirmed.', { exact: true })).toHaveCount(0);
  expect(await lastParams(page, 'remux/agent/conversation/message/send')).toBeNull();
});
