import { expect, test, type Page } from '@playwright/test';

import { FIXTURE_CONVERSATION_ID, installAgentHost } from './viewer-fixture';

test.beforeEach(async ({ page }) => {
  await installAgentHost(page);
});

test('ignores a delayed stale transcript response after a newer terminal frame', async ({ page }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await page.evaluate(() => (window as any).__agentFixture.delayNextTranscript(220));

  await messageBox(page).fill('Exercise the streaming race');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
  await page.waitForTimeout(260);
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
  await expect(page.locator('.codex-work-header-status')).toHaveText('completed');
});

test('defers background transcript work and catches up on resume', async ({ page }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await page.evaluate(() => {
    const fixture = (window as any).__agentFixture;
    fixture.lifecycle('background');
    fixture.appendCompletedTurn('Background request', 'Recovered after resume.');
  });

  await page.waitForTimeout(120);
  await expect(page.getByText('Recovered after resume.')).toHaveCount(0);
  await page.evaluate(() => (window as any).__agentFixture.lifecycle('active', 'foreground'));
  await expect(page.getByText('Recovered after resume.')).toBeVisible();
});

test('re-reads resources after reconnect without losing the visible conversation', async ({ page }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  const before = await resourceReadCount(page);
  await page.evaluate(() => (window as any).__agentFixture.reconnect());

  await expect.poll(() => resourceReadCount(page)).toBeGreaterThan(before);
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
});

test('reconstructs and lazily continues a durable conversation across a server generation reset', async ({ page }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await page.evaluate(() => (window as any).__agentFixture.resetGeneration());

  await expect(messageBox(page)).toBeEditable();
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await expect(page.getByText('Conversation unavailable')).toHaveCount(0);
  await messageBox(page).fill('Continue after the runtime reset');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
});

test('preserves open work and reloads its lazy detail across a server generation reset', async ({ page }) => {
  await page.goto('/viewers/agent/');
  await messageBox(page).fill('Inspect durable work across restart');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();

  const workHeader = page.locator('.codex-work-header');
  await workHeader.click();
  const readRow = page.getByRole('button', { name: /Read README\.md/u });
  await readRow.click();
  await expect(page.getByText('Read the workspace overview before editing.')).toBeVisible();

  const detailReadsBeforeReset = await transcriptRequestCount(page, 'workEntryDetail');
  await page.evaluate(() => (window as any).__agentFixture.resetGeneration());

  await expect(workHeader).toHaveAttribute('aria-expanded', 'true');
  await expect(readRow).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Read the workspace overview before editing.')).toBeVisible();
  await expect.poll(() => transcriptRequestCount(page, 'workEntryDetail'))
    .toBeGreaterThan(detailReadsBeforeReset);
});

test('fences a delayed old-generation transcript after fresh recovery', async ({ page }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await page.evaluate(() => {
    const fixture = (window as any).__agentFixture;
    fixture.delayNextTranscript(220);
    fixture.appendCompletedTurn('Old generation request', 'Old generation answer.');
    fixture.resetGeneration();
    fixture.appendCompletedTurn('New generation request', 'New generation answer.');
  });

  await expect(transcript(page).getByText('New generation answer.')).toBeVisible();
  await page.waitForTimeout(260);
  await expect(transcript(page).getByText('New generation answer.')).toBeVisible();
  await expect(transcript(page).getByText('Old generation answer.')).toBeVisible();
});

test('loads an old focused turn before measuring and scrolling to it', async ({ page }) => {
  await page.goto(conversationUrl(
    '&fixtureLong=1&remuxFocusKind=turn&remuxFocusId=turn-10',
  ));

  await expect(transcript(page).getByText('Historical answer 10.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === 'remux/agent/transcript/resources/read')
    .flatMap((entry: { summary: string }) => JSON.parse(entry.summary))
    .some((request: any) => request.type === 'transcriptSync' &&
      request.window?.kind === 'around' && request.window.turnId === 'turn-10'))).toBe(true);
});

test('offers retry and dismiss when a requested turn cannot be focused', async ({ page }) => {
  await page.goto(conversationUrl(
    '&fixtureLong=1&remuxFocusKind=turn&remuxFocusId=missing-turn',
  ));

  const failure = page.getByRole('alert').filter({ hasText: 'The requested turn could not be loaded.' });
  await expect(failure).toBeVisible();
  const aroundReadsBeforeRetry = await focusedTurnRequestCount(page, 'missing-turn');
  await failure.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => focusedTurnRequestCount(page, 'missing-turn'))
    .toBeGreaterThan(aroundReadsBeforeRetry);
  await expect(failure).toBeVisible();
  await failure.getByRole('button', { name: 'Dismiss' }).click();
  await expect(failure).toHaveCount(0);
});

test('provides previous and next transcript navigation without forcing bottom mode', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureLong=1'));
  await expect(page.getByText('Historical answer 72.')).toBeVisible();
  const viewport = page.getByTestId('agent-transcript-scroll');
  const previous = page.getByRole('button', { name: 'Previous turn' });
  await expect(previous).toBeEnabled();
  const bottom = await viewport.evaluate((element) => element.scrollTop);
  await previous.click();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(bottom);
  const afterPrevious = await viewport.evaluate((element) => element.scrollTop);
  await page.getByRole('button', { name: 'Next turn or bottom' }).click();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(afterPrevious);
});

test('keeps excluded Codex surfaces out of the Agent shell', async ({ page }) => {
  await page.goto('/viewers/agent/');
  await page.getByRole('button', { name: 'Preferences' }).click();
  for (const name of ['Attach', 'Compact', 'Review', 'Speed', 'Narration', 'Queue']) {
    await expect(page.getByText(name, { exact: false })).toHaveCount(0);
  }
});

test('keeps the focused mobile composer above reported keyboard geometry', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'mobile geometry scenario');
  await page.goto('/viewers/agent/');
  const textbox = messageBox(page);
  await textbox.focus();
  await page.evaluate(() => (window as any).__agentFixture.setViewportMetrics({
    keyboardHeight: 344,
    keyboardVisible: true,
    visibleBottom: 500,
    viewportHeight: 844,
    viewportWidth: 390,
  }));

  await expect(textbox).toBeFocused();
  await expect.poll(async () => {
    const box = await page.locator('.remux-bottom-bar').boundingBox();
    return Math.ceil(box?.y ?? 999) + Math.ceil(box?.height ?? 999);
  }).toBeLessThanOrEqual(502);
  await textbox.fill('mobile line one');
  await textbox.press('End');
  await textbox.press('Enter');
  await textbox.type('mobile line two');
  await expect.poll(() => textbox.evaluate((element) => (element as HTMLElement).innerText))
    .toBe('mobile line one\nmobile line two');
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

async function resourceReadCount(page: Page) {
  return page.evaluate(() => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === 'remux/agent/resources/read').length);
}

async function transcriptRequestCount(page: Page, type: string) {
  return page.evaluate((requestType) => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === 'remux/agent/transcript/resources/read')
    .flatMap((entry: { summary: string }) => JSON.parse(entry.summary))
    .filter((request: { type: string }) => request.type === requestType).length, type);
}

async function focusedTurnRequestCount(page: Page, turnId: string) {
  return page.evaluate((focusedTurnId) => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === 'remux/agent/transcript/resources/read')
    .flatMap((entry: { summary: string }) => JSON.parse(entry.summary))
    .filter((request: any) => request.type === 'transcriptSync' &&
      request.window?.kind === 'around' && request.window.turnId === focusedTurnId).length, turnId);
}
