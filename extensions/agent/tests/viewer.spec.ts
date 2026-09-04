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
  await expect(page.getByRole('button', { name: 'Show usage details' })
    .getByText('GPT-5.6 Sol')).toBeVisible();
  await messageBox(page).fill('Inspect the workspace');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
  await expect(page.locator('.codex-work-header')).toContainText(/^Worked for \S+$/u);
  await expect(transcript(page).getByText('Inspect the workspace', { exact: true })).toHaveCount(1);
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/create')).toBe(1);
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/message/send')).toBe(1);
  await expect.poll(() => lastConversationOperationId(page)).toMatch(UUID_V4);
  await expect.poll(async () => (await lastCommandParams(
    page,
    'remux/agent/conversation/create',
  )).model).toBe('gpt-5.6-sol');
  await expect.poll(async () => (await lastCommandParams(
    page,
    'remux/agent/conversation/create',
  )).effort).toBe('high');
  await expect.poll(async () => (await lastCommandParams(
    page,
    'remux/agent/conversation/message/send',
  )).content).toEqual([{ type: 'text', text: 'Inspect the workspace' }]);
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

  await expect(page.locator('.codex-work-header')).toContainText(/^Worked for \S+$/u);
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

test('replaces an unsuccessful initial connection with a retryable error', async ({ page }) => {
  await page.goto('/viewers/agent/?fixtureResourceFailure=1');
  await expect(page.getByRole('heading', { name: 'Agent runtime unavailable' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Fixture Agent runtime is unavailable.');
  await expect(page.getByText('Connecting to agent runtime…')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
});

test('keeps sign-out inside the preferences menu', async ({ page }) => {
  await expect(page.getByRole('button', { name: /Sign out/u })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preferences' }).click();
  await page.getByRole('button', { name: 'Providers' }).click();
  await page.getByRole('button', { name: 'Sign out of Fixture subscription' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with device code' })).toBeVisible();
});

test('reconstructs a conversation from route-addressed turn frames', async ({ page, isMobile }) => {
  await page.goto(conversationUrl());

  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show usage details' })
    .getByText('GPT-5.6 Sol')).toBeVisible();
  const history = await openHistory(page, isMobile);
  await expect(history.getByRole('button', { name: 'Start new chat', exact: true })).toBeVisible();
});

test('keeps large conversation histories on a bounded flat-list window', async ({ page, isMobile }) => {
  await page.goto(conversationUrl());
  await page.evaluate(() => {
    (window as any).__agentFixture.addConversations(Array.from({ length: 1_000 }, (_, index) => ({
      createdAt: 1_700_000_000_000 + index,
      id: `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      preview: `Bounded row ${index}`,
      title: `History item ${index}`,
    })));
  });
  const history = await openHistory(page, isMobile);
  const list = history.getByRole('list', { name: 'Conversation history' });
  await expect.poll(() => list.getByRole('listitem').count()).toBeGreaterThan(5);
  expect(await list.getByRole('listitem').count()).toBeLessThan(40);
  const geometry = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight * 20);
});

test('shows a flat recognition-focused history without graph or management controls', async ({ page, isMobile }) => {
  await page.goto(conversationUrl());
  await page.evaluate(() => {
    (window as any).__agentFixture.addConversation({
      archivedAt: Date.now(),
      id: '44444444-4444-4444-8444-444444444444',
      preview: 'Recover the hidden conversation without spending tokens',
      title: 'New chat',
    });
  });
  const history = await openHistory(page, isMobile);
  await expect(history.getByRole('button', { name: /Recover the hidden conversation/u })).toBeVisible();
  await expect(history.getByText('GPT-5.6 Sol', { exact: true })).toBeVisible();
  await expect(history.getByRole('button', { name: 'Close history', exact: true })).toHaveCount(0);
  await expect(history.getByRole('button', { name: 'Conversation actions', exact: true })).toHaveCount(0);
  await expect(history.getByText(/Archived \(/u)).toHaveCount(0);
  await expect(history.locator('[title="Conversation versions"]')).toHaveCount(0);
  await expect(history.getByRole('tree')).toHaveCount(0);
});

test('orders history by the latest sent message rather than the latest read or metadata update', async ({
  page,
  isMobile,
}) => {
  await page.goto(conversationUrl());
  await page.evaluate(() => {
    (window as any).__agentFixture.addConversations([
      {
        id: '77777777-7777-4777-8777-777777777777',
        title: 'Older message, recently visited',
        createdAt: 1_000,
        lastActivityAt: 2_000,
        updatedAt: 9_000,
      },
      {
        id: '88888888-8888-4888-8888-888888888888',
        title: 'Newer message, never visited',
        createdAt: 1_000,
        lastActivityAt: 3_000,
        updatedAt: 3_000,
      },
    ]);
  });

  const history = await openHistory(page, isMobile);
  const rows = await history.getByRole('listitem').allTextContents();
  const newerIndex = rows.findIndex((row) => row.includes('Newer message, never visited'));
  const olderIndex = rows.findIndex((row) => row.includes('Older message, recently visited'));
  expect(newerIndex).toBeGreaterThanOrEqual(0);
  expect(olderIndex).toBeGreaterThanOrEqual(0);
  expect(newerIndex).toBeLessThan(olderIndex);
});

test('keeps the transcript usable when optional context diagnostics are obsolete', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureStaleContextInspector=1'));

  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await expect(page.getByTestId('context-inspector')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
});

test('selects history through the desktop sidebar or mobile sheet and restores target drafts', async ({ page, isMobile }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();

  await startNewChat(page, isMobile);
  const textbox = messageBox(page);
  await expect(textbox).not.toBeFocused();
  await textbox.fill('Keep this exact new-chat draft');

  let history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /^Resume this conversation/u }).click();
  await expect(textbox).not.toBeFocused();
  await expect.poll(() => currentResourceId(page)).toBe(FIXTURE_CONVERSATION_ID);
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();

  history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /New chat Draft/u }).click();
  await expect(textbox).not.toBeFocused();
  await expect.poll(() => textbox.evaluate((element) => (element as HTMLElement).innerText))
    .toBe('Keep this exact new-chat draft');
  await expect.poll(() => currentResourceKind(page)).toBe('agentDraft');

  history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /^Resume this conversation/u }).click();
  await expect(textbox).not.toBeFocused();
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

test('history selection clears composer presentation without reopening the keyboard', async ({ page, isMobile }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();

  const textbox = messageBox(page);
  await page.getByRole('button', { name: 'Edit message', exact: true }).click();
  await expect(page.getByText('Editing message', { exact: true })).toBeVisible();
  await expect(textbox).toBeFocused();

  const history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: 'Start new chat', exact: true }).click();

  await expect(page.getByText('Editing message', { exact: true })).toHaveCount(0);
  await expect(textbox).not.toBeFocused();
  await page.waitForTimeout(350);
  await expect(textbox).not.toBeFocused();
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

test('restores a cached transcript before background revalidation completes', async ({ page, isMobile }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await page.evaluate((id) => (window as any).__agentFixture.addConversation({
    id,
    preview: 'A separate cached work stream.',
    title: 'Cached ledger work',
  }), FIXTURE_SECOND_CONVERSATION_ID);

  let history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /^Cached ledger work/u }).click();
  await expect(page.getByText('No transcript yet')).toBeVisible();

  await page.evaluate(() => (window as any).__agentFixture.delayNextTranscript(2_000));
  history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /^Resume this conversation/u }).click();

  await expect(transcript(page).getByText('Recovered from authoritative resources.'))
    .toBeVisible({ timeout: 500 });
  const latestRequest = await latestTranscriptRequest(page);
  expect(latestRequest.key).toBe(`agent/transcript:${FIXTURE_CONVERSATION_ID}:tail-24`);
  expect(latestRequest.ifNoneMatch).toEqual(expect.any(Number));
});

test('patches a cached inactive conversation through its dirty turn resource', async ({ page, isMobile }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await page.evaluate((id) => {
    const fixture = (window as any).__agentFixture;
    fixture.addConversation({ id, title: 'Streaming elsewhere' });
    fixture.appendCompletedTurnTo(id, 'Background work', 'Before background update.');
  }, FIXTURE_SECOND_CONVERSATION_ID);

  let history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /^Streaming elsewhere/u }).click();
  await expect(transcript(page).getByText('Before background update.')).toBeVisible();
  history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /^Resume this conversation/u }).click();
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();

  const tailReadsBefore = await transcriptReadCount(page, 'agent/transcript:');
  const turnReadsBefore = await transcriptReadCount(page, 'agent/turn:');
  await page.evaluate((id) => (window as any).__agentFixture.reviseLatestAssistant(
    id,
    'Updated while the conversation was inactive.',
  ), FIXTURE_SECOND_CONVERSATION_ID);

  history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /^Streaming elsewhere/u }).click();
  await expect(transcript(page).getByText('Updated while the conversation was inactive.')).toBeVisible();
  await expect.poll(() => transcriptReadCount(page, 'agent/turn:')).toBe(turnReadsBefore + 1);
  expect(await transcriptReadCount(page, 'agent/transcript:')).toBe(tailReadsBefore);
});

test('restores a stable semantic scroll position across repeated conversation switches', async ({
  page,
  isMobile,
}) => {
  await page.goto(conversationUrl('&fixtureLong=1'));
  await expect(transcript(page).getByText('Historical answer 72.')).toBeVisible();
  await page.evaluate((id) => {
    const fixture = (window as any).__agentFixture;
    fixture.addConversation({ id, title: 'Scrollable cached work' });
    for (let index = 1; index <= 36; index += 1) {
      fixture.appendCompletedTurnTo(
        id,
        `Secondary request ${index}`,
        `Secondary answer ${index}.`,
      );
    }
  }, FIXTURE_SECOND_CONVERSATION_ID);

  const mainPosition = await establishManualScrollPosition(page, 0.42);
  let history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /^Scrollable cached work/u }).click();
  await expect(transcript(page).getByText('Secondary answer 36.')).toBeVisible();
  const secondaryPosition = await establishManualScrollPosition(page, 0.63);

  for (let iteration = 0; iteration < 2; iteration += 1) {
    history = await openHistory(page, isMobile);
    await history.getByRole('button', { name: /^Resume this conversation/u }).click();
    await expect.poll(() => currentResourceId(page)).toBe(FIXTURE_CONVERSATION_ID);
    await expectStableViewportPosition(page, mainPosition);

    history = await openHistory(page, isMobile);
    await history.getByRole('button', { name: /^Scrollable cached work/u }).click();
    await expect.poll(() => currentResourceId(page)).toBe(FIXTURE_SECOND_CONVERSATION_ID);
    await expectStableViewportPosition(page, secondaryPosition);
  }
});

test('restores the transcript bottom semantically across conversation switches', async ({
  page,
  isMobile,
}) => {
  await page.goto(conversationUrl('&fixtureLong=1'));
  await expect(transcript(page).getByText('Historical answer 72.')).toBeVisible();
  await expect.poll(() => transcriptBottomDistance(page)).toBeLessThanOrEqual(2);
  await page.evaluate((id) => {
    const fixture = (window as any).__agentFixture;
    fixture.addConversation({ id, title: 'Other cached work' });
    for (let index = 1; index <= 24; index += 1) {
      fixture.appendCompletedTurnTo(id, `Other request ${index}`, `Other answer ${index}.`);
    }
  }, FIXTURE_SECOND_CONVERSATION_ID);

  let history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /^Other cached work/u }).click();
  await expect(transcript(page).getByText('Other answer 24.')).toBeVisible();
  history = await openHistory(page, isMobile);
  await history.getByRole('button', { name: /^Resume this conversation/u }).click();

  await expect.poll(() => currentResourceId(page)).toBe(FIXTURE_CONVERSATION_ID);
  await expect.poll(() => transcriptBottomDistance(page)).toBeLessThanOrEqual(2);
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
  await expect(page.locator('.codex-work-header')).toContainText(/^Worked for \S+$/u);
});

test('blocks mutations after a history sync failure and exposes an explicit retry', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureHistoryFailed=1'));

  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Fixture history read failed.');
  await messageBox(page).fill('Wait for provider truth');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
});

test('changes model and access on an existing idle conversation for the next turn', async ({ page }) => {
  await page.goto(conversationUrl());
  await page.getByRole('button', { name: 'Preferences' }).click();
  await expect(page.getByRole('button', { name: 'GPT-5.6 Sol', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'GPT-5.6 Sol', exact: true }).click();
  await page.getByRole('button', { name: /^GPT-5\.4 Fixture/u }).click();
  await expect.poll(async () => (await lastCommandParams(
    page,
    'remux/agent/composer/conversation-preference/set',
  )).model).toBe('gpt-5.4-fixture');
  await expect(page.getByRole('button', { name: 'Workspace write', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Workspace write', exact: true }).click();
  await page.getByRole('button', { name: 'Read only', exact: true }).click();
  await expect.poll(async () => (await lastCommandParams(
    page,
    'remux/agent/composer/conversation-access/set',
  )).access).toBe('read-only');

  await messageBox(page).fill('Continue with the updated access');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await lastCommandParams(
    page,
    'remux/agent/conversation/message/send',
  )).access).toBe('read-only');
  await expect.poll(async () => (await lastCommandParams(
    page,
    'remux/agent/conversation/message/send',
  )).model).toBe('gpt-5.4-fixture');
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

test('pins the selected native provider model and effort when creating a conversation', async ({ page, isMobile }) => {
  await page.getByRole('button', { name: 'Preferences' }).click();
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'GPT-5.6 Sol' })).toBeEnabled();
  await page.getByRole('button', { name: 'GPT-5.6 Sol', exact: true }).click();
  await page.getByRole('button', { name: 'GPT-5.4 Fixture' }).click();
  await expect(page.getByRole('button', { name: 'High', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'High', exact: true }).click();
  await page.getByRole('button', { name: 'Medium', exact: true }).click();
  await page.getByRole('button', { name: 'Workspace write', exact: true }).click();
  await page.getByRole('button', { name: 'Full access', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Medium reasoning', { exact: true })).toBeVisible();

  await messageBox(page).fill('Start with the selected native configuration');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await lastCommandParams(
    page,
    'remux/agent/conversation/create',
  )).effort).toBe('medium');
  await expect.poll(async () => (await lastCommandParams(
    page,
    'remux/agent/conversation/create',
  )).model).toBe('gpt-5.4-fixture');
  await expect.poll(async () => (await lastCommandParams(
    page,
    'remux/agent/conversation/create',
  )).access).toBe('full-access');
  await expect(page.getByText('The fixture stream completed.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Medium reasoning', { exact: true })).toBeVisible();

  await startNewChat(page, isMobile);
  await expect(page.getByRole('button', { name: 'Choose workspace' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Show usage details' })
    .getByText('GPT-5.4 Fixture')).toBeVisible();
  await expect(page.getByText('Medium reasoning', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preferences' }).click();
  await expect(page.getByRole('button', { name: 'Workspace write', exact: true })).toBeVisible();
});

test('shows context and subscription usage and invokes native Compact without touching the draft', async ({ page }) => {
  await page.goto(conversationUrl());
  const usageRail = page.getByRole('button', { name: 'Show usage details' });
  await expect(usageRail.locator('.remux-composer-provider-mark')).toHaveText('A');
  await expect(usageRail.locator('.remux-composer-provider-mark'))
    .toHaveAttribute('title', 'Fixture subscription');
  await expect(usageRail).toContainText('36% context');
  await expect(usageRail).toContainText('36k tokens');
  await expect(page.getByTitle('36,000 of 100,000 context tokens')).toHaveText('36% context');
  await usageRail.click();

  const tray = page.getByRole('region', { name: 'Usage details' });
  await expect(tray).toBeVisible();
  await expect(tray.getByText('36,000 / 100,000 · 36%')).toBeVisible();
  await expect(tray.getByRole('progressbar', { name: 'Context window used' })).toHaveAttribute('aria-valuenow', '36');
  await expect(tray.getByText('Fixture subscription')).toBeVisible();
  await expect(tray.getByText('5 hours', { exact: true })).toBeVisible();
  await expect(tray.getByText('18% used', { exact: true })).toBeVisible();
  await expect(tray.getByRole('progressbar', { name: '5 hours used' })).toHaveAttribute('aria-valuenow', '18');
  await expect(tray.getByText('Weekly', { exact: true })).toBeVisible();
  await expect(tray.getByText('42% used', { exact: true })).toBeVisible();
  await expect(tray.getByRole('progressbar', { name: 'Weekly used' })).toHaveAttribute('aria-valuenow', '42');
  await expect(tray.getByText(/^Live usage · updated/u)).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(tray).toHaveCount(0);
  await page.getByRole('button', { name: 'Show usage details' }).click();
  await messageBox(page).fill('Keep this draft through compaction');
  await page.getByRole('region', { name: 'Usage details' })
    .getByRole('button', { name: 'Compact', exact: true }).click();

  await expect.poll(() => commandCount(page, 'remux/agent/conversation/compact')).toBe(1);
  await expect.poll(() => messageBox(page).evaluate((element) => (element as HTMLElement).innerText))
    .toBe('Keep this draft through compaction');
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toHaveCount(1);
});

test('keeps the compact Remux composer inside the Agent transcript material', async ({ page }) => {
  await page.goto(conversationUrl());
  const preferences = page.getByRole('button', { name: 'Preferences' });
  await preferences.click();

  const panel = page.locator('[data-remux-composer-config-panel]');
  const composer = page.locator('.remux-composer-panel');
  const assistantCopy = page.locator('.codex-assistant-message .codex-md-paragraph');
  const userBubble = page.locator('.codex-user-bubble');
  await expect(panel).toBeVisible();
  await expect(assistantCopy).toHaveCSS('font-size', '13px');
  await expect(assistantCopy).toHaveCSS('line-height', '18px');
  await expect(userBubble).toHaveCSS('border-top-width', '0px');
  await expect(userBubble).toHaveCSS('border-radius', '16px');
  await expect(composer).toHaveCSS('padding-top', '0px');
  await expect(composer).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(preferences).toHaveCSS('width', '39px');
  await expect(preferences).toHaveCSS('height', '36px');

  for (const expectation of [
    {
      action: 'rgb(249, 115, 22)', canvas: 'rgb(10, 10, 10)',
      focus: 'rgb(96, 165, 250)', link: 'rgb(96, 165, 250)', theme: 'dark',
    },
    {
      action: 'rgb(249, 115, 22)', canvas: 'rgb(252, 252, 252)',
      focus: 'rgb(37, 99, 235)', link: 'rgb(37, 99, 235)', theme: 'light',
    },
  ]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.remuxTheme = theme;
    }, expectation.theme);

    await expect.poll(() => computedBackgroundColor(page.locator('body'))).toBe(expectation.canvas);
    await expect.poll(() => computedThemeColor(page, '--agent-action')).toBe(expectation.action);
    await expect.poll(() => computedThemeColor(page, '--ring')).toBe(expectation.focus);
    await expect.poll(() => computedThemeColor(page, '--link')).toBe(expectation.link);
    await expect.poll(() => computedBackgroundImage(panel)).toContain('linear-gradient');
    await expect.poll(() => computedBackgroundImage(preferences)).toContain('linear-gradient');
  }
});

test('keeps duration in the work header and live rows stable while their shimmer settles', async ({ page }) => {
  await messageBox(page).fill('Please interrupt after showing live activity');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  const workHeader = page.locator('.codex-work-header');
  await expect(workHeader).toContainText(/^Working for \S+$/u);
  await expect(workHeader.getByRole('status')).toHaveCount(0);
  const actionHeader = page.locator('.agent-action-run-header');
  const activity = actionHeader.getByRole('status');
  await expect(activity).toBeVisible();
  await expect(activity.locator('.agent-live-activity-focus')).toHaveCSS(
    'animation-name',
    'agent-live-activity-focus',
  );
  await expect(activity.locator('.agent-live-activity-focus-counter')).toHaveCSS('display', 'block');
  await expect(activity.locator('.agent-live-activity-focus-aligned')).toHaveCSS('display', 'block');
  const runningHeight = await workHeader.evaluate((element) => element.getBoundingClientRect().height);
  const runningLabelLeft = await actionHeader.locator('.agent-live-activity-label').first()
    .evaluate((element) => element.getBoundingClientRect().left);
  await expect(page.getByRole('status', { name: 'Thinking' })).toHaveCount(0);

  await page.evaluate(() => (window as any).__agentFixture.reviseLatestExecutionScope());
  await expect(page.getByText('Validated the refreshed execution-scope revision.')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Thinking' })).toBeVisible();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(activity.locator('.agent-live-activity-focus')).toHaveCSS('display', 'none');

  await page.getByRole('button', { name: 'Stop turn', exact: true }).click();
  await expect(workHeader).toContainText(/^Worked for \S+$/u);
  await expect(page.locator('.codex-work-header-status')).toHaveCount(0);
  await workHeader.click();
  await expect(actionHeader).toBeVisible();
  await expect(actionHeader.getByRole('status')).toHaveCount(0);
  const settledLabelLeft = await actionHeader.locator('.agent-live-activity-label').first()
    .evaluate((element) => element.getBoundingClientRect().left);
  expect(settledLabelLeft).toBe(runningLabelLeft);
  await expect.poll(() => workHeader.evaluate((element) => element.getBoundingClientRect().height))
    .toBe(runningHeight);
});

test('restores and advances the elapsed work duration after a page refresh', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureRunning=1'));
  const workHeader = page.locator('.codex-work-header');
  await expect(workHeader).toContainText(/^Working for \S+$/u);
  await expect.poll(() => workHeaderSeconds(workHeader)).toBeGreaterThanOrEqual(3);

  const beforeTick = await workHeaderSeconds(workHeader);
  await expect.poll(() => workHeaderSeconds(workHeader), { timeout: 2_500 })
    .toBeGreaterThan(beforeTick);
  const beforeRefresh = await workHeaderSeconds(workHeader);

  await page.reload();
  await expect(workHeader).toContainText(/^Working for \S+$/u);
  await expect.poll(() => workHeaderSeconds(workHeader))
    .toBeGreaterThanOrEqual(beforeRefresh);

  await page.getByRole('button', { name: 'Stop turn', exact: true }).click();
  await expect(workHeader).toContainText(/^Worked for \S+$/u);
  await expect.poll(() => workHeaderSeconds(workHeader))
    .toBeGreaterThanOrEqual(beforeRefresh);
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
  expect(params.content.some((part: { path?: string; type: string }) =>
    part.type === 'file-reference' && part.path === 'README.md')).toBe(true);
  await expect(transcript(page).locator('.codex-user-rail-title').getByText('README.md', { exact: true })).toBeVisible();
});

test('picks, sends, and renders native image attachments', async ({ page }) => {
  await messageBox(page).fill('Use this image');
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await page.getByText('Photo Library', { exact: true }).click();
  await expect(page.locator('.remux-composer-attachment-card').getByText('picked.png')).toBeVisible();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  const params = await lastCommandParams(page, 'remux/agent/conversation/message/send');
  expect(params.content.some((part: { artifactId?: string; type: string }) =>
    part.type === 'image-artifact' && Boolean(part.artifactId))).toBe(true);
  expect(JSON.stringify(params)).not.toContain('data:image/png;base64,');
  await expect.poll(() => commandCount(page, 'remux/agent/artifact/put')).toBe(1);
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

test('edits a completed user message as a new version of the same conversation', async ({ page, isMobile }) => {
  await page.goto(conversationUrl());
  await page.getByRole('button', { name: 'Preferences' }).click();
  await page.getByRole('button', { name: 'GPT-5.6 Sol', exact: true }).click();
  await page.getByRole('button', { name: 'GPT-5.4 Fixture' }).click();
  await page.getByRole('button', { name: 'High', exact: true }).click();
  await page.getByRole('button', { name: 'Medium', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Edit message', exact: true }).click();
  await expect(page.getByText('Editing message', { exact: true })).toBeVisible();
  await messageBox(page).fill('Replacement prompt');
  await page.getByRole('button', { name: 'Save edited message', exact: true }).click();

  await expect.poll(() => currentResourceId(page)).toBe(FIXTURE_CONVERSATION_ID);
  await expect(transcript(page).getByText('Replacement prompt', { exact: true })).toBeVisible();
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/message/edit')).toBe(1);
  await expect.poll(async () => (await lastCommandParams(
    page,
    'remux/agent/conversation/message/edit',
  ))).toMatchObject({
    content: [{ type: 'text', text: 'Replacement prompt' }],
    expectedHeadRevision: 1,
    sourceConversationId: FIXTURE_CONVERSATION_ID,
  });
  const branchParams = await lastCommandParams(page, 'remux/agent/conversation/message/edit');
  expect(branchParams.sourcePathEntryId).toContain(FIXTURE_CONVERSATION_ID);
  expect(branchParams.sourceStrandId).toBe(`fixture-strand:${FIXTURE_CONVERSATION_ID}:initial`);

  const history = await openHistory(page, isMobile);
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await expect(history.getByText('Replacement prompt', { exact: true })).toBeVisible();
  await expect(history.locator('[title="Conversation versions"]')).toHaveCount(0);
});

test('forks a completed response with its visible prefix intact', async ({ page, isMobile }) => {
  await page.goto(conversationUrl());
  await page.getByRole('button', { name: 'Fork from response', exact: true }).click();
  await expect(page.getByText('Forking from response', { exact: true })).toBeVisible();
  await messageBox(page).fill('Fork follow-up');
  await page.getByRole('button', { name: 'Send forked message', exact: true }).click();

  await expect.poll(() => currentResourceId(page)).not.toBe(FIXTURE_CONVERSATION_ID);
  await expect(transcript(page).getByText('Resume this conversation', { exact: true })).toBeVisible();
  await expect(transcript(page).getByText('Fork follow-up', { exact: true })).toBeVisible();
  await expect.poll(() => commandCount(page, 'remux/agent/conversation/message/fork')).toBe(1);
  await expect.poll(async () => (await lastCommandParams(
    page,
    'remux/agent/conversation/message/fork',
  )).content).toEqual([{ type: 'text', text: 'Fork follow-up' }]);
  const forkParams = await lastCommandParams(page, 'remux/agent/conversation/message/fork');
  expect(forkParams).toMatchObject({
    expectedHeadRevision: 1,
    sourceConversationId: FIXTURE_CONVERSATION_ID,
    sourceStrandId: `fixture-strand:${FIXTURE_CONVERSATION_ID}:initial`,
  });

  const history = await openHistory(page, isMobile);
  await expect(history.getByRole('listitem')).toHaveCount(2);
  await expect(history.getByRole('button', { name: /^Fork follow-up/u })).toBeVisible();
  await expect(history.getByRole('tree')).toHaveCount(0);
});

function conversationUrl(extra = '') {
  return `/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}${extra}`;
}

async function workHeaderSeconds(header: Locator) {
  const match = /(?:Working|Worked) for (\d+)s/u.exec(await header.textContent() ?? '');
  return match ? Number(match[1]) : -1;
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

type ViewportPosition = {
  offset: number;
  rowId: string;
  turnId: string;
};

async function establishManualScrollPosition(page: Page, ratio: number): Promise<ViewportPosition> {
  const viewport = transcript(page);
  await viewport.evaluate((node, scrollRatio) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 24 }));
    node.scrollTop = Math.max(1, (node.scrollHeight - node.clientHeight) * scrollRatio);
    node.dispatchEvent(new Event('scroll'));
    node.dispatchEvent(new Event('scrollend'));
  }, ratio);
  await page.waitForTimeout(100);
  return viewportPosition(page);
}

async function expectStableViewportPosition(page: Page, expected: ViewportPosition) {
  await expect.poll(async () => {
    const actual = await viewportPosition(page);
    if (actual.rowId !== expected.rowId || actual.turnId !== expected.turnId) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.abs(actual.offset - expected.offset);
  }, { timeout: 2_000 }).toBeLessThanOrEqual(2);
}

async function viewportPosition(page: Page): Promise<ViewportPosition> {
  return transcript(page).evaluate((viewport) => {
    const viewportTop = viewport.getBoundingClientRect().top;
    const rows = [...viewport.querySelectorAll<HTMLElement>(
      '[data-transcript-row-id][data-turn-id]',
    )];
    const row = rows.find((candidate) => candidate.getBoundingClientRect().bottom > viewportTop + 1);
    if (!row?.dataset.transcriptRowId || !row.dataset.turnId) {
      throw new Error('No visible transcript row is available.');
    }
    return {
      offset: Math.round(row.getBoundingClientRect().top - viewportTop),
      rowId: row.dataset.transcriptRowId,
      turnId: row.dataset.turnId,
    };
  });
}

async function transcriptBottomDistance(page: Page) {
  return transcript(page).evaluate((viewport) =>
    Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop));
}

async function latestTranscriptRequest(page: Page) {
  return page.evaluate(() => {
    const requests = (window as any).__agentFixture.requestLog
      .filter((entry: { method: string }) => entry.method === 'remux/agent/transcript/resources/read')
      .flatMap((entry: { summary: string }) => JSON.parse(entry.summary));
    return requests.at(-1) ?? null;
  });
}

async function transcriptReadCount(page: Page, prefix: string) {
  return page.evaluate((keyPrefix) => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === 'remux/agent/transcript/resources/read')
    .flatMap((entry: { summary: string }) => JSON.parse(entry.summary))
    .filter((request: { key: string }) => request.key.startsWith(keyPrefix)).length, prefix);
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
    return request ? JSON.parse(request.summary).commandId as string : null;
  });
}

async function computedBackgroundImage(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).backgroundImage);
}

async function computedBackgroundColor(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).backgroundColor);
}

async function computedThemeColor(page: Page, variable: string) {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, variable);
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
