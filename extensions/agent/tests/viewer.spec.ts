import { expect, test, type Locator, type Page } from '@playwright/test';

import { FIXTURE_CONVERSATION_ID, installAgentHost } from './viewer-fixture';

test.beforeEach(async ({ page }) => {
  await installAgentHost(page);
  await page.goto('/viewers/agent/');
});

test('starts with the authoritative model and sends the first message once', async ({ page }) => {
  await expect(page.getByText('GPT-5.4 Fixture')).toBeVisible();
  await messageBox(page).fill('Inspect the workspace');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
  await expect(page.locator('.codex-work-header-status')).toHaveText('completed');
  await expect(page.getByText('Inspect the workspace', { exact: true })).toHaveCount(1);
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/start')).toBe(1);
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/message/send')).toBe(1);
});

test('sends with a portable UUID when crypto.randomUUID is unavailable', async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
  });

  await messageBox(page).fill('Send without randomUUID');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/start')).toBe(1);
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/message/send')).toBe(1);
  await expect.poll(() => lastClientMessageId(page)).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
});

test('interrupts an active turn through the server command', async ({ page }) => {
  await messageBox(page).fill('Please interrupt this turn');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Stop turn', exact: true }).click();

  await expect(page.locator('.codex-work-header-status')).toHaveText('interrupted');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
});

test('renders signed-out device-code login and cancel state', async ({ page }) => {
  await page.goto('/viewers/agent/?fixtureSignedOut=1');
  await page.getByRole('button', { name: 'Sign in with device code' }).click();
  await expect(page.getByText('REMUX-CODE')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open verification page' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with device code' })).toBeVisible();
});

test('preserves sign-out in the compact action shell', async ({ page }) => {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with device code' })).toBeVisible();
});

test('reconstructs a conversation from route-addressed turn frames', async ({ page }) => {
  await page.goto(conversationUrl());

  await expect(page.getByText('Recovered from authoritative resources.')).toBeVisible();
  await expect(page.getByText('GPT-5.4 Fixture')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();
});

test('renders terminal turn errors from the authoritative frame', async ({ page }) => {
  await messageBox(page).fill('Trigger an error fixture');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  await expect(page.getByText('Fixture provider failure.', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.codex-work-header-status')).toHaveText('failed');
});

test('selects a workspace through the bounded directory picker', async ({ page }) => {
  await page.getByRole('button', { name: 'Choose workspace' }).click();
  await page.getByRole('option', { name: 'packages/' }).click();
  await expect(page.getByText('/tmp/remux-fixture/packages', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select directory' }).click();
  await expect(page.getByRole('button', { name: 'Choose workspace' })).toContainText('packages');

  await messageBox(page).fill('Use the selected workspace');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => {
    return page.evaluate(() => {
      const log = (window as any).__agentFixture.requestLog as Array<{ method: string; summary: string }>;
      const request = log.find((entry) => entry.method === 'remux/agent/conversation/start');
      return request ? JSON.parse(request.summary).cwd : null;
    });
  }).toBe('/tmp/remux-fixture/packages');
});

test('locks model settings to an active conversation and unlocks a new chat', async ({ page }) => {
  await page.getByRole('button', { name: 'Preferences' }).click();
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'GPT-5.4 Fixture' })).toBeEnabled();
  await page.keyboard.press('Escape');

  await messageBox(page).fill('Start a locked conversation');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();
  await page.getByRole('button', { name: 'Preferences' }).click();
  await expect(page.getByRole('button', { name: 'GPT-5.4 Fixture' })).toBeDisabled();
  await expect(page.getByText('Start a new chat to change model settings.')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByRole('button', { name: 'Choose workspace' })).toBeEnabled();
});

test('paints the config menu and action shell in dark and light themes', async ({ page }) => {
  const preferences = page.getByRole('button', { name: 'Preferences' });
  await preferences.click();

  const panel = page.locator('[data-remux-composer-config-panel]');
  await expect(panel).toBeVisible();

  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.remuxTheme = value;
    }, theme);

    await expect.poll(() => computedBackgroundImage(panel)).toContain('linear-gradient');
    await expect.poll(() => computedBackgroundImage(preferences)).toContain('linear-gradient');
  }
});

test('keeps Enter multiline and sends only from the action', async ({ page }) => {
  const textbox = messageBox(page);
  await textbox.fill('First line');
  await textbox.press('End');
  await textbox.press('Enter');
  await textbox.type('Second line');

  await expect(textbox).toBeFocused();
  await expect.poll(() => textbox.evaluate((element) => (element as HTMLElement).innerText)).toBe('First line\nSecond line');
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/message/send')).toBe(0);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/message/send')).toBe(1);
});

function conversationUrl(extra = '') {
  return `/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}${extra}`;
}

function messageBox(page: Page) {
  return page.getByRole('textbox', { name: 'Message', exact: true });
}

async function commandCount(page: Page, method: string) {
  return page.evaluate((value) => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === value).length, method);
}

async function lastClientMessageId(page: Page) {
  return page.evaluate(() => {
    const log = (window as any).__agentFixture.requestLog as Array<{ method: string; summary: string }>;
    const request = log.findLast((entry) => entry.method === 'remux/agent/conversation/message/send');
    return request ? JSON.parse(request.summary).clientMessageId as string : null;
  });
}

async function computedBackgroundImage(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).backgroundImage);
}
