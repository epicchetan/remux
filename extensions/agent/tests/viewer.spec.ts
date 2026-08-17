import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  FIXTURE_CONVERSATION_ID,
  FIXTURE_SECOND_CONVERSATION_ID,
  installAgentHost,
} from './viewer-fixture';

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
  await expect(transcript(page).getByText('Inspect the workspace', { exact: true })).toHaveCount(1);
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/create')).toBe(1);
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/message/send')).toBe(1);
  await expect.poll(() => lastConversationOperationId(page)).toMatch(UUID_V4);
  await expect.poll(async () => (await lastCommandParams(
    page,
    'remux/agent/conversation/message/send',
  )).contextPlan).toEqual({ version: 1, automaticDialogueTurns: 2, overrides: [] });
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
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/create')).toBe(1);
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/message/send')).toBe(1);
  await expect.poll(() => lastClientMessageId(page)).toMatch(
    UUID_V4,
  );
  await expect.poll(() => lastConversationOperationId(page)).toMatch(UUID_V4);
});

test('keeps one conversation operation identity across a draft reload', async ({ page }) => {
  const beforeReload = await page.evaluate(() =>
    window.sessionStorage.getItem('remux.agent.draft-operation.v1'));
  expect(beforeReload).toMatch(UUID_V4);

  await messageBox(page).fill('Unsaved text survives this reload');
  await page.reload();
  await expect.poll(() => messageBox(page).evaluate((element) => (element as HTMLElement).innerText))
    .toBe('Unsaved text survives this reload');
  await messageBox(page).fill('Send the reloaded draft');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
  await expect.poll(() => lastConversationOperationId(page)).toBe(beforeReload);
  await expect.poll(() => page.evaluate(() =>
    window.sessionStorage.getItem('remux.agent.draft-operation.v1'))).toBeNull();
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

test('keeps sign-out inside the preferences menu', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preferences' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with device code' })).toBeVisible();
});

test('reconstructs a conversation from route-addressed turn frames', async ({ page, isMobile }) => {
  await page.goto(conversationUrl());

  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await expect(page.getByText('GPT-5.4 Fixture')).toBeVisible();
  const history = await openHistory(page, isMobile);
  await expect(history.getByRole('button', { name: 'Start new chat', exact: true })).toBeVisible();
});

test('keeps the transcript usable when optional context diagnostics are obsolete', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureStaleContextInspector=1'));

  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await expect(page.getByTestId('context-inspector')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
});

test('shows actual dispatch and compiled-frame evidence for a durable inference', async ({ page }) => {
  await page.goto(conversationUrl());

  const inspector = page.getByTestId('context-inspector');
  await expect(inspector.locator('summary')).toContainText('dialogue 100 · full 0 · active 102 · turn');
  await inspector.locator('summary').click();
  const panel = page.getByRole('region', { name: 'Inference context inspector' });
  await expect(panel).toContainText('Actual inference context');
  await expect(panel).toContainText('continuation transport');
  await expect(panel).toContainText('Selected turn context');
  await expect(panel).toContainText('dialogue turns');
  await expect(panel).toContainText('current work');
  await expect(panel).toContainText('1 included');
  await expect(panel).toContainText('retrievable omissions');

  await panel.getByRole('button', { name: /Open captured request context/u }).click();
  const dispatch = page.getByRole('dialog', { name: 'Captured harness-visible request context' });
  await expect(dispatch).toContainText('Fixture provider input');
  await dispatch.getByRole('button', { name: 'Close Captured harness-visible request context' }).click();

  await panel.getByRole('button', { name: /Open selection manifest/u }).click();
  const manifest = page.getByRole('dialog', { name: 'Durable inference context manifest' });
  await expect(manifest).toContainText('agent-inference-context-v7');
});

test('opens newest-first turn context below the composer actions', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureContextTurns=1'));

  await expect(page.getByRole('button', { name: 'Choose prior turn context' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preferences' }).click();
  await page.getByRole('button', { name: 'Turn context' }).click();
  const picker = page.getByRole('region', { name: 'Turn context settings' });
  await expect(picker).toContainText('Recent turns use dialogue by default.');
  await expect(page.locator('[data-remux-composer-config-panel]')).toHaveCount(0);

  const rows = picker.locator('.agent-context-picker-turn');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Context request 4');
  await expect(rows.nth(1)).toContainText('Context request 3');
  await expect(rows.nth(3)).toContainText('Context request 1');
  const positions = await page.locator('.remux-composer-actions, .agent-context-tray').evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().top));
  expect(positions[1]).toBeGreaterThan(positions[0]);

  const latest = picker.locator('.agent-context-picker-turn').filter({ hasText: 'Context request 4' });
  await latest.getByRole('button', { name: 'Full' }).click();
  const oldest = picker.locator('.agent-context-picker-turn').filter({ hasText: 'Context request 1' });
  await oldest.getByRole('button', { name: 'Dialogue' }).click();

  await messageBox(page).fill('Use the selected context');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const params = await lastCommandParams(page, 'remux/agent/conversation/message/send');
  expect(params.contextPlan).toEqual({
    version: 1,
    automaticDialogueTurns: 2,
    overrides: [
      { turnId: 'turn-4', resolution: 'full' },
      { turnId: 'turn-1', resolution: 'dialogue' },
    ],
  });
});

test('keeps explicit context choices after send only when requested', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureContextTurns=1'));
  await page.getByRole('button', { name: 'Preferences' }).click();
  await page.getByRole('button', { name: 'Turn context' }).click();
  const picker = page.getByRole('region', { name: 'Turn context settings' });
  const latest = picker.locator('.agent-context-picker-turn').filter({ hasText: 'Context request 4' });
  await latest.getByRole('button', { name: 'Full' }).click();
  await picker.getByRole('switch', { name: 'Keep context choices after sending' }).click();

  await messageBox(page).fill('Use and preserve the selected context');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/message/send')).toBe(1);
  await expect(transcript(page).getByText('The fixture stream completed.', { exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Preferences' }).click();
  await page.getByRole('button', { name: 'Turn context' }).click();
  const restoredPicker = page.getByRole('region', { name: 'Turn context settings' });
  await expect(restoredPicker.getByRole('switch', { name: 'Keep context choices after sending' }))
    .toHaveAttribute('aria-checked', 'true');
  const restoredLatest = restoredPicker.locator('.agent-context-picker-turn')
    .filter({ hasText: 'Context request 4' });
  await expect(restoredLatest.getByRole('button', { name: 'Full' })).toHaveAttribute('aria-pressed', 'true');

  await messageBox(page).fill('Use the preserved context again');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/message/send')).toBe(1);

  const params = await lastCommandParams(page, 'remux/agent/conversation/message/send');
  expect(params.contextPlan.overrides).toContainEqual({ turnId: 'turn-4', resolution: 'full' });
  await expect(restoredPicker.getByRole('switch', { name: 'Keep context choices after sending' }))
    .toHaveAttribute('aria-checked', 'true');
});

test('resets explicit context choices after send by default', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureContextTurns=1'));
  await page.getByRole('button', { name: 'Preferences' }).click();
  await page.getByRole('button', { name: 'Turn context' }).click();
  const picker = page.getByRole('region', { name: 'Turn context settings' });
  const latest = picker.locator('.agent-context-picker-turn').filter({ hasText: 'Context request 4' });
  await latest.getByRole('button', { name: 'Full' }).click();

  await messageBox(page).fill('Use the selected context once');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(transcript(page).getByText('The fixture stream completed.', { exact: true })).toBeVisible();
  await messageBox(page).fill('Return to the context default');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/message/send')).toBe(2);

  const params = await lastCommandParams(page, 'remux/agent/conversation/message/send');
  expect(params.contextPlan).toEqual({ version: 1, automaticDialogueTurns: 2, overrides: [] });
});

test('bounds long recent-turn context to its own scroll area', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureLong=1'));
  await page.getByRole('button', { name: 'Preferences' }).click();
  await page.getByRole('button', { name: 'Turn context' }).click();
  const picker = page.getByRole('region', { name: 'Turn context settings' });
  const list = picker.locator('.agent-context-picker-list');
  const rows = picker.locator('.agent-context-picker-turn');

  await expect(rows.first()).toContainText('Historical request 72');
  await expect(rows.first()).toContainText('Turn 72');
  await expect(rows.nth(1)).toContainText('Historical request 71');
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
});

test('selects history through the desktop sidebar or mobile sheet and restores target drafts', async ({ page, isMobile }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();

  await startNewChat(page, isMobile);
  const textbox = messageBox(page);
  await textbox.fill('Keep this exact new-chat draft');

  let history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /^Resume this conversation/u }).click();
  await expect.poll(() => currentResourceId(page)).toBe(FIXTURE_CONVERSATION_ID);
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();

  history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /New chat Draft/u }).click();
  await expect.poll(() => textbox.evaluate((element) => (element as HTMLElement).innerText))
    .toBe('Keep this exact new-chat draft');
  await expect.poll(() => currentResourceKind(page)).toBe('agentDraft');

  history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /^Resume this conversation/u }).click();
  await textbox.fill('Keep this conversation-specific draft');
  history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /New chat Draft/u }).click();
  await expect.poll(() => textbox.evaluate((element) => (element as HTMLElement).innerText))
    .toBe('Keep this exact new-chat draft');
  history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /^Resume this conversation/u }).click();
  await expect.poll(() => textbox.evaluate((element) => (element as HTMLElement).innerText))
    .toBe('Keep this conversation-specific draft');
});

test('fences a delayed conversation read during rapid history selection', async ({ page, isMobile }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await page.evaluate((id) => (window as any).__agentFixture.addConversation({
    id,
    preview: 'A separate empty work stream.',
    title: 'Parallel ledger work',
  }), FIXTURE_SECOND_CONVERSATION_ID);

  let history = await openHistory(page, isMobile);
  await expect(history.getByRole('button', { name: /^Parallel ledger work/u })).toBeVisible();
  await page.evaluate(() => (window as any).__agentFixture.delayNextTranscript(220));
  await history.getByRole('button', { name: /^Parallel ledger work/u }).click();
  await expect.poll(() => currentResourceId(page)).toBe(FIXTURE_SECOND_CONVERSATION_ID);

  history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /^Resume this conversation/u }).click();
  await expect.poll(() => currentResourceId(page)).toBe(FIXTURE_CONVERSATION_ID);
  await page.waitForTimeout(260);
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
});

test('honors host navigation to another durable conversation', async ({ page }) => {
  await page.goto(conversationUrl());
  await page.evaluate((id) => {
    const fixture = (window as any).__agentFixture;
    fixture.addConversation({ id, title: 'Host-selected work' });
    fixture.navigate('agentConversation', id);
  }, FIXTURE_SECOND_CONVERSATION_ID);

  await expect.poll(() => currentResourceId(page)).toBe(FIXTURE_SECOND_CONVERSATION_ID);
  await expect(page.getByText('No transcript yet')).toBeVisible();
});

test('preserves an unloaded conversation draft when lazy activation is rejected', async ({ page }) => {
  await page.goto(conversationUrl());
  await page.evaluate(() => (window as any).__agentFixture.resetGeneration());
  await expect.poll(() => page.evaluate(() =>
    (window as any).__agentFixture.resources.get('runtime')?.value.state)).toBe('unloaded');
  await page.evaluate(() => (window as any).__agentFixture.rejectNextMessage());
  const textbox = messageBox(page);
  await textbox.fill('Keep this exact draft after a busy rejection');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  await expect(page.getByRole('alert')).toContainText('Another conversation has an active turn.');
  await expect.poll(() => textbox.evaluate((element) => (element as HTMLElement).innerText))
    .toBe('Keep this exact draft after a busy rejection');
  await expect(textbox).toBeEditable();
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
      const request = log.find((entry) => entry.method === 'remux/agent/conversation/create');
      return request ? JSON.parse(request.summary).cwd : null;
    });
  }).toBe('/tmp/remux-fixture/packages');
});

test('locks model settings to an active conversation and unlocks a new chat', async ({ page, isMobile }) => {
  await page.getByRole('button', { name: 'Preferences' }).click();
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'GPT-5.4 Fixture' })).toBeEnabled();
  await page.keyboard.press('Escape');

  await messageBox(page).fill('Start a locked conversation');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  if (!isMobile) {
    await expect(page.getByRole('button', { name: 'Start new chat', exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Preferences' }).click();
  await expect(page.getByRole('button', { name: 'GPT-5.4 Fixture' })).toBeDisabled();
  await expect(page.getByText('Start a new chat to change model settings.')).toBeVisible();
  await page.keyboard.press('Escape');

  await startNewChat(page, isMobile);
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

test('searches and sends workspace file mentions as structured input', async ({ page }) => {
  const textbox = messageBox(page);
  await textbox.fill('Please inspect @read');
  await expect(page.getByText('Workspace files', { exact: true })).toBeVisible();
  await page.locator('.remux-file-mention-row').filter({ hasText: 'README.md' }).click();
  await textbox.press('End');
  await textbox.type(' now');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
  const params = await lastCommandParams(page, 'remux/agent/conversation/message/send');
  expect(params.parts.some((part: { path?: string; type: string }) =>
    part.type === 'mention' && part.path === 'README.md')).toBe(true);
  await expect(transcript(page).locator('.codex-user-rail-title').getByText('README.md', { exact: true })).toBeVisible();
});

test('picks, sends, and renders native image attachments', async ({ page }) => {
  await messageBox(page).fill('Use this image');
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await page.getByText('Photo Library', { exact: true }).click();
  await expect(page.locator('.remux-composer-attachment-card').getByText('picked.png')).toBeVisible();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  const params = await lastCommandParams(page, 'remux/agent/conversation/message/send');
  expect(params.parts.some((part: { dataUrl?: string; type: string }) =>
    part.type === 'image' && part.dataUrl?.startsWith('data:image/png;base64,'))).toBe(true);
  await expect(transcript(page).getByText('picked.png', { exact: true })).toBeVisible();
  await expect(transcript(page).getByRole('img', { name: 'picked.png' })).toBeVisible();
  await expect.poll(() => commandCount(page, 'host/attachments/pick')).toBe(1);
});

test('queues a follow-up during active work and dispatches it after stop', async ({ page }) => {
  await messageBox(page).fill('Please interrupt this turn');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop turn', exact: true })).toBeVisible();

  await messageBox(page).fill('Continue after the stop');
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect(page.getByText('Queued 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop turn', exact: true }).click();

  await expect(transcript(page).getByText('Continue after the stop', { exact: true })).toBeVisible();
  await expect(page.getByText('Queued 1', { exact: true })).toHaveCount(0);
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/message/send')).toBe(2);
});

test('edits a completed user message into an immutable branch', async ({ page }) => {
  await page.goto(conversationUrl());
  await page.getByRole('button', { name: 'Edit message', exact: true }).click();
  await expect(page.getByText('Editing message', { exact: true })).toBeVisible();
  await messageBox(page).fill('Replacement prompt');
  await page.getByRole('button', { name: 'Save edited message', exact: true }).click();

  await expect.poll(() => currentResourceId(page)).not.toBe(FIXTURE_CONVERSATION_ID);
  await expect(transcript(page).getByText('Replacement prompt', { exact: true })).toBeVisible();
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/message/edit')).toBe(1);
});

test('forks a completed response with its visible prefix intact', async ({ page }) => {
  await page.goto(conversationUrl());
  await page.getByRole('button', { name: 'Fork from response', exact: true }).click();
  await expect(page.getByText('Forking from response', { exact: true })).toBeVisible();
  await messageBox(page).fill('Fork follow-up');
  await page.getByRole('button', { name: 'Send forked message', exact: true }).click();

  await expect.poll(() => currentResourceId(page)).not.toBe(FIXTURE_CONVERSATION_ID);
  await expect(transcript(page).getByText('Resume this conversation', { exact: true })).toBeVisible();
  await expect(transcript(page).getByText('Fork follow-up', { exact: true })).toBeVisible();
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/message/fork')).toBe(1);
});

function conversationUrl(extra = '') {
  return `/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}${extra}`;
}

function messageBox(page: Page) {
  return page.getByRole('textbox', { name: 'Message', exact: true });
}

function transcript(page: Page) {
  return page.getByTestId('agent-transcript-scroll');
}

async function openHistory(page: Page, isMobile: boolean) {
  if (isMobile) {
    await page.getByRole('button', { name: 'Open history' }).click();
    return page.getByRole('dialog');
  }
  return page.getByLabel('Agent history');
}

async function startNewChat(page: Page, isMobile: boolean) {
  const history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: 'Start new chat', exact: true }).click();
}

async function currentResourceId(page: Page) {
  return page.evaluate(() => new URL(window.location.href).searchParams.get('remuxResourceId'));
}

async function currentResourceKind(page: Page) {
  return page.evaluate(() => new URL(window.location.href).searchParams.get('remuxResourceKind'));
}

async function commandCount(page: Page, method: string) {
  return page.evaluate((value) => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === value).length, method);
}

async function lastCommandParams(page: Page, method: string) {
  return page.evaluate((value) => {
    const log = (window as any).__agentFixture.requestLog as Array<{ method: string; summary: string }>;
    const request = log.findLast((entry) => entry.method === value);
    return request ? JSON.parse(request.summary) : null;
  }, method);
}

async function lastClientMessageId(page: Page) {
  return page.evaluate(() => {
    const log = (window as any).__agentFixture.requestLog as Array<{ method: string; summary: string }>;
    const request = log.findLast((entry) => entry.method === 'remux/agent/conversation/message/send');
    return request ? JSON.parse(request.summary).clientMessageId as string : null;
  });
}

async function lastConversationOperationId(page: Page) {
  return page.evaluate(() => {
    const log = (window as any).__agentFixture.requestLog as Array<{ method: string; summary: string }>;
    const request = log.findLast((entry) => entry.method === 'remux/agent/conversation/create');
    return request ? JSON.parse(request.summary).operationId as string : null;
  });
}

async function computedBackgroundImage(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).backgroundImage);
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
