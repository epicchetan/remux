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
  await expect(page.locator('.codex-work-header')).toContainText(/^Worked for \S+$/u);
});

test('keeps a send fence pending when the first follow-up transcript read fails', async ({ page }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await page.evaluate(() => {
    const fixture = (window as any).__agentFixture;
    fixture.delayNextTranscript(220);
    fixture.failNextTranscriptReads(1);
  });

  await messageBox(page).fill('Recover the causally fenced send');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(transcript(page).getByText('Recover the causally fenced send')).toBeVisible();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
  await expect.poll(() => transcriptRequestCount(page, 'transcriptSync')).toBeGreaterThanOrEqual(3);
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

test('runs one narrow catch-up when a mounted tab becomes active again', async ({ page }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await page.waitForTimeout(100);
  const resourcesBefore = await resourceReadCount(page);
  const transcriptBefore = await transcriptRequestCount(page, 'transcriptSync');

  await page.evaluate(() => {
    const fixture = (window as any).__agentFixture;
    fixture.lifecycle('inactive', 'tabActive');
    fixture.lifecycle('active', 'tabActive');
  });

  await expect.poll(() => resourceReadCount(page)).toBe(resourcesBefore + 1);
  await expect.poll(() => transcriptRequestCount(page, 'transcriptSync')).toBe(transcriptBefore + 1);
  await page.waitForTimeout(150);
  expect(await resourceReadCount(page)).toBe(resourcesBefore + 1);
  expect(await transcriptRequestCount(page, 'transcriptSync')).toBe(transcriptBefore + 1);
  expect(await lastResourceRequestKeys(page)).toEqual([
    `agent/queue:${FIXTURE_CONVERSATION_ID}`,
    `agent/runtime:${FIXTURE_CONVERSATION_ID}`,
  ]);
});

test('releases composer focus while preserving its draft across tab lifecycle changes', async ({ page }) => {
  await page.goto(conversationUrl());
  await page.getByRole('button', { name: 'Edit message', exact: true }).click();
  await expect(page.getByText('Editing message', { exact: true })).toBeVisible();
  const textbox = messageBox(page);
  await expect(textbox).toBeFocused();
  await expect(textbox).toContainText('Resume this conversation');

  await page.evaluate(() => (window as any).__agentFixture.lifecycle('inactive', 'tabActive'));
  await expect(textbox).not.toBeFocused();
  await page.waitForTimeout(350);
  await expect(textbox).not.toBeFocused();
  await expect(textbox).toContainText('Resume this conversation');

  await page.evaluate(() => (window as any).__agentFixture.lifecycle('active', 'tabActive'));
  await page.waitForTimeout(350);
  await expect(textbox).not.toBeFocused();
  await expect(textbox).toContainText('Resume this conversation');
});

test('recovers after suspension drops every invalidation and the first resume read fails', async ({ page }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await page.evaluate(() => {
    const fixture = (window as any).__agentFixture;
    fixture.lifecycle('background');
    fixture.dropInvalidations(true);
    fixture.appendCompletedTurn('Missed background request', 'Recovered without an invalidation.');
    fixture.dropInvalidations(false);
    fixture.failNextTranscriptReads(1);
    fixture.lifecycle('active', 'foreground');
  });

  await expect(transcript(page).getByText('Recovered without an invalidation.')).toBeVisible();
});

test('refreshes an open composer usage tray after suspended invalidations are lost', async ({ page }) => {
  await page.goto(conversationUrl());
  await page.getByRole('button', { name: 'Show usage details' }).click();
  const tray = page.getByRole('region', { name: 'Usage details' });
  await expect(tray.getByText('36,000 / 100,000 · 36%')).toBeVisible();
  await expect(tray.getByRole('progressbar', { name: 'Weekly used' }))
    .toHaveAttribute('aria-valuenow', '42');

  await page.evaluate(() => {
    const fixture = (window as any).__agentFixture;
    fixture.lifecycle('background');
    fixture.dropInvalidations(true);
    fixture.updateComposerUsage({
      contextUsedTokens: 72_000,
      fiveHourUsedPercent: 77,
      weeklyUsedPercent: 88,
    });
    fixture.dropInvalidations(false);
    fixture.lifecycle('active', 'foreground');
  });

  await expect(tray.getByText('72,000 / 100,000 · 72%')).toBeVisible();
  await expect(tray.getByRole('progressbar', { name: '5 hours used' }))
    .toHaveAttribute('aria-valuenow', '77');
  await expect(tray.getByRole('progressbar', { name: 'Weekly used' }))
    .toHaveAttribute('aria-valuenow', '88');
});

test('abandons an interrupted transcript read so foreground recovery cannot be wedged', async ({ page }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  const readsBefore = await transcriptRequestCount(page, 'transcriptSync');
  await page.evaluate(() => {
    const fixture = (window as any).__agentFixture;
    fixture.delayNextTranscript(10_000);
    fixture.appendCompletedTurn('Interrupted request', 'This delayed response must not block resume.');
  });
  await expect.poll(() => transcriptRequestCount(page, 'transcriptSync')).toBeGreaterThan(readsBefore);

  await page.evaluate(() => {
    const fixture = (window as any).__agentFixture;
    fixture.lifecycle('background');
    fixture.dropInvalidations(true);
    fixture.appendCompletedTurn('Post-suspension request', 'Recovered ahead of the abandoned read.');
    fixture.dropInvalidations(false);
    fixture.lifecycle('active', 'foreground');
  });

  await expect(transcript(page).getByText('Recovered ahead of the abandoned read.')).toBeVisible();
});

test('retains foreground recovery until a disconnected host reconnects', async ({ page }) => {
  await page.goto(conversationUrl());
  await expect(transcript(page).getByText('Recovered from authoritative resources.')).toBeVisible();
  await page.evaluate(() => {
    const fixture = (window as any).__agentFixture;
    fixture.lifecycle('background');
    fixture.connection('reconnecting');
    fixture.dropInvalidations(true);
    fixture.appendCompletedTurn('Reconnect request', 'Recovered after the socket returned.');
    fixture.dropInvalidations(false);
    fixture.lifecycle('active', 'foreground-before-connected');
  });
  await expect(page.getByText('Recovered after the socket returned.')).toHaveCount(0);
  await page.evaluate(() => (window as any).__agentFixture.connection('connected'));
  await expect(transcript(page).getByText('Recovered after the socket returned.')).toBeVisible();
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

test('preserves open native activity and reloads its turn frame across a server generation reset', async ({ page }) => {
  await page.goto('/viewers/agent/');
  await messageBox(page).fill('Inspect durable work across restart');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();

  const workHeader = page.locator('.codex-work-header');
  await workHeader.click();
  const actionSummary = page.locator('.agent-action-run > button');
  await actionSummary.click();
  const readRow = page.locator('.agent-tool-call').filter({ hasText: 'workspace.read' });
  await readRow.locator('> button').click();
  await expect(page.getByText('Read the workspace overview before editing.', { exact: true })).toBeVisible();

  const turnReadsBeforeReset = await transcriptRequestCount(page, 'turn');
  await page.evaluate(() => (window as any).__agentFixture.resetGeneration());

  await expect(workHeader).toHaveAttribute('aria-expanded', 'true');
  await expect(actionSummary).toHaveAttribute('aria-expanded', 'true');
  await expect(readRow.locator('> button')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Read the workspace overview before editing.', { exact: true })).toBeVisible();
  await expect.poll(() => transcriptRequestCount(page, 'turn')).toBeGreaterThan(turnReadsBeforeReset);
});

test('revalidates an expanded native activity frame after its background invalidation is lost', async ({ page }) => {
  await page.goto('/viewers/agent/');
  await messageBox(page).fill('Inspect work that changes while suspended');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();

  await page.locator('.codex-work-header').click();
  await expect(page.getByText('Grounding the change in the current workspace.')).toBeVisible();
  const readsBefore = await transcriptRequestCount(page, 'turn');
  await page.evaluate(() => {
    const fixture = (window as any).__agentFixture;
    fixture.lifecycle('background');
    fixture.dropInvalidations(true);
    fixture.reviseLatestExecutionScope();
    fixture.dropInvalidations(false);
    fixture.lifecycle('active', 'foreground');
  });

  await expect.poll(() => transcriptRequestCount(page, 'turn')).toBeGreaterThan(readsBefore);
  await expect(page.getByText('Validated the refreshed execution-scope revision.')).toBeVisible();
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
    .some((request: any) => String(request.key).includes(':around:turn-10:')))).toBe(true);
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

test('reloads a short final response at the live transcript bottom', async ({ page }) => {
  await installTranscriptGeometrySkew(page, false);
  await page.goto(conversationUrl('&fixtureLong=1'));
  await expect(page.getByText('Historical answer 72.')).toBeVisible();
  await expect.poll(() => distanceFromTranscriptBottom(page)).toBeLessThanOrEqual(2);

  await page.reload();
  await expect(page.getByText('Historical answer 72.')).toBeVisible();
  await expect.poll(() => distanceFromTranscriptBottom(page)).toBeLessThanOrEqual(2);
  const samples = await sampleTranscriptPlacement(page, 'bottom');
  expect(Math.max(...samples)).toBeLessThanOrEqual(2);
});

test('reloads a long final response with the last user message at the live anchor', async ({ page }) => {
  await installTranscriptGeometrySkew(page, true);
  await page.goto(conversationUrl('&fixtureLong=1'));
  await expect(page.getByText('Historical answer 72.')).toBeVisible();
  await expect.poll(() => lastUserMessageAnchorError(page)).toBeLessThanOrEqual(2);

  await page.reload();
  await expect(page.getByText('Historical answer 72.')).toBeVisible();
  await expect.poll(() => lastUserMessageAnchorError(page)).toBeLessThanOrEqual(2);
  const samples = await sampleTranscriptPlacement(page, 'user-message');
  expect(Math.max(...samples)).toBeLessThanOrEqual(2);
});

test('navigates loaded turn anchors by identity after skipping the visible tail', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureLong=1'));
  await expect(page.getByText('Historical answer 72.')).toBeVisible();
  const previous = page.getByRole('button', { name: 'Previous turn' });
  const next = page.getByRole('button', { name: 'Next turn or bottom' });
  const rowTop = (turnId: string) => page.locator(`[data-row-kind="userMessage"][data-turn-id="${turnId}"]`)
    .evaluate((row) => {
      const viewport = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
      return row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    });
  const anchorTop = () => page.getByTestId('agent-transcript-content').evaluate((content) =>
    Math.max(24, Number.parseFloat(getComputedStyle(content).paddingTop)));
  const targets = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
    const viewportTop = viewport.getBoundingClientRect().top;
    const turnIds = Array.from(viewport.querySelectorAll<HTMLElement>('[data-row-kind="userMessage"]'))
      .map((row) => ({
        bottom: row.getBoundingClientRect().bottom,
        turnId: row.dataset.turnId!,
      }));
    const targetIndex = turnIds.findLastIndex(({ bottom }) => bottom <= viewportTop + 1);
    return {
      first: turnIds[targetIndex]?.turnId,
      second: turnIds[targetIndex - 1]?.turnId,
    };
  });
  expect(targets.first).toBeTruthy();
  expect(targets.second).toBeTruthy();

  await expect(previous).toBeEnabled();
  await previous.click();
  await expect.poll(async () => Math.abs(await rowTop(targets.first!) - await anchorTop())).toBeLessThanOrEqual(2);

  await previous.click();
  await expect.poll(async () => Math.abs(await rowTop(targets.second!) - await anchorTop())).toBeLessThanOrEqual(2);

  await next.click();
  await expect.poll(async () => Math.abs(await rowTop(targets.first!) - await anchorTop())).toBeLessThanOrEqual(2);
});

test('navigates to mounted user-message geometry without a corrective snap', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureLong=1'));
  await expect(page.getByText('Historical answer 72.')).toBeVisible();
  const previous = page.getByRole('button', { name: 'Previous turn' });
  const targetTurnId = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
    const viewportTop = viewport.getBoundingClientRect().top;
    return Array.from(viewport.querySelectorAll<HTMLElement>('[data-row-kind="userMessage"]'))
      .filter((row) => row.getBoundingClientRect().bottom <= viewportTop + 1)
      .at(-1)?.dataset.turnId ?? null;
  });
  expect(targetTurnId).toBeTruthy();

  await page.evaluate((turnId) => {
    const row = document.querySelector<HTMLElement>(
      `[data-row-kind="userMessage"][data-turn-id="${turnId}"]`,
    )!;
    // Deliberately create a rendered-vs-modeled geometry difference. The
    // navigation target must come from the mounted row, not scroll there using
    // the model and correct itself after the animation.
    row.style.transform = 'translateY(64px)';
    (window as any).__navigationFrames = [];
    const startedAt = performance.now();
    const sample = () => {
      const viewport = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
      const target = document.querySelector<HTMLElement>(
        `[data-row-kind="userMessage"][data-turn-id="${turnId}"]`,
      );
      if (target) {
        (window as any).__navigationFrames.push({
          top: target.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
          t: performance.now() - startedAt,
        });
      }
      if (performance.now() - startedAt < 450) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, targetTurnId);

  await expect(previous).toBeEnabled();
  await previous.click();
  await page.waitForTimeout(500);
  const result = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('[data-testid="agent-transcript-content"]')!;
    const anchorTop = Math.max(24, Number.parseFloat(getComputedStyle(content).paddingTop));
    const frames = (window as any).__navigationFrames as Array<{ top: number; t: number }>;
    return {
      anchorTop,
      finalTop: frames.at(-1)?.top ?? Number.NaN,
      maxTop: Math.max(...frames.map(({ top }) => top)),
      sampleCount: frames.length,
    };
  });

  expect(result.sampleCount).toBeGreaterThan(8);
  expect(result.maxTop).toBeLessThanOrEqual(result.anchorTop + 3);
  expect(Math.abs(result.finalTop - result.anchorTop)).toBeLessThanOrEqual(2);
  await expect(page.getByTestId('agent-transcript-anchor-runway')).toHaveCSS('height', '0px');
});

test('previous-turn navigation skips user messages already visible in a short mobile tail', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'This regression requires the compact mobile transcript viewport.');
  await page.goto(conversationUrl('&fixtureContextTurns=1'));
  await expect(transcript(page).getByText('Context answer 7.')).toBeVisible();

  const initial = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
    const viewportBounds = viewport.getBoundingClientRect();
    const rows = Array.from(viewport.querySelectorAll<HTMLElement>('[data-row-kind="userMessage"]'))
      .map((row) => {
        const bounds = row.getBoundingClientRect();
        return {
          bottom: bounds.bottom,
          top: bounds.top,
          turnId: row.dataset.turnId!,
          visible: bounds.bottom > viewportBounds.top + 1 && bounds.top < viewportBounds.bottom - 1,
        };
      });
    return {
      newestHiddenTurnId: rows.filter(({ bottom }) => bottom <= viewportBounds.top + 1).at(-1)?.turnId,
      visibleTurnIds: rows.filter(({ visible }) => visible).map(({ turnId }) => turnId),
    };
  });

  expect(initial.visibleTurnIds.length).toBeGreaterThanOrEqual(2);
  expect(initial.newestHiddenTurnId).toBeTruthy();
  expect(initial.visibleTurnIds).not.toContain(initial.newestHiddenTurnId);

  const previous = page.getByRole('button', { name: 'Previous turn' });
  await expect(previous).toBeEnabled();
  await previous.click();
  await expect.poll(() => page.locator(
    `[data-row-kind="userMessage"][data-turn-id="${initial.newestHiddenTurnId}"]`,
  ).evaluate((row) => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
    const content = document.querySelector<HTMLElement>('[data-testid="agent-transcript-content"]')!;
    const anchorTop = Math.max(24, Number.parseFloat(getComputedStyle(content).paddingTop));
    return Math.abs(row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchorTop);
  })).toBeLessThanOrEqual(2);
  await expect(page.getByTestId('agent-transcript-anchor-runway')).toHaveCSS('height', '0px');

  const next = page.getByRole('button', { name: 'Next turn or bottom' });
  await expect(next).toBeEnabled();
  await next.click();
  await expect.poll(() => page.getByTestId('agent-transcript-scroll').evaluate((viewport) =>
    Math.abs(viewport.scrollTop - (viewport.scrollHeight - viewport.clientHeight)))).toBeLessThanOrEqual(2);
  await expect(page.getByTestId('agent-transcript-anchor-runway')).toHaveCSS('height', '0px');
  await expect(next).toBeDisabled();
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

async function installTranscriptGeometrySkew(page: Page, longFinalResponse: boolean) {
  await page.addInitScript((longTail) => {
    const install = () => {
      if (!document.head || document.querySelector('[data-transcript-geometry-skew]')) {
        return Boolean(document.head);
      }
      const style = document.createElement('style');
      style.dataset.transcriptGeometrySkew = 'true';
      style.textContent = `
        .codex-transcript-row-assistantMessage { padding-bottom: 40px !important; }
        ${longTail
          ? '.codex-transcript-turn:last-child .codex-transcript-row-assistantMessage { min-height: 900px !important; }'
          : ''}
      `;
      document.head.append(style);
      return true;
    };
    if (install()) return;
    const observer = new MutationObserver(() => {
      if (!install()) return;
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  }, longFinalResponse);
}

async function distanceFromTranscriptBottom(page: Page) {
  return transcript(page).evaluate((viewport) =>
    Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop));
}

async function lastUserMessageAnchorError(page: Page) {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
    const content = document.querySelector<HTMLElement>('[data-testid="agent-transcript-content"]')!;
    const row = Array.from(viewport.querySelectorAll<HTMLElement>('[data-row-kind="userMessage"]')).at(-1)!;
    const anchorTop = Math.max(24, Number.parseFloat(getComputedStyle(content).paddingTop));
    return Math.abs(row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchorTop);
  });
}

async function sampleTranscriptPlacement(page: Page, target: 'bottom' | 'user-message') {
  return page.evaluate(async (placementTarget) => {
    const samples: number[] = [];
    for (let frame = 0; frame < 8; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const viewport = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
      if (placementTarget === 'bottom') {
        samples.push(Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop));
        continue;
      }
      const content = document.querySelector<HTMLElement>('[data-testid="agent-transcript-content"]')!;
      const row = Array.from(viewport.querySelectorAll<HTMLElement>('[data-row-kind="userMessage"]')).at(-1)!;
      const anchorTop = Math.max(24, Number.parseFloat(getComputedStyle(content).paddingTop));
      samples.push(Math.abs(row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchorTop));
    }
    return samples;
  }, target);
}

async function resourceReadCount(page: Page) {
  return page.evaluate(() => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === 'remux/agent/resources/read').length);
}

async function lastResourceRequestKeys(page: Page) {
  return page.evaluate(() => {
    const entries = (window as any).__agentFixture.requestLog
      .filter((entry: { method: string }) => entry.method === 'remux/agent/resources/read');
    const params = JSON.parse(entries.at(-1)?.summary ?? '{}');
    return (params.requests ?? []).map((request: { key: string }) => request.key).sort();
  });
}

async function transcriptRequestCount(page: Page, type: string) {
  return page.evaluate((requestType) => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === 'remux/agent/transcript/resources/read')
    .flatMap((entry: { summary: string }) => JSON.parse(entry.summary))
    .filter((request: { key: string }) => requestType === 'turn'
      ? request.key.startsWith('agent/turn:')
      : request.key.startsWith('agent/transcript:')).length, type);
}

async function focusedTurnRequestCount(page: Page, turnId: string) {
  return page.evaluate((focusedTurnId) => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === 'remux/agent/transcript/resources/read')
    .flatMap((entry: { summary: string }) => JSON.parse(entry.summary))
    .filter((request: any) => String(request.key).includes(`:around:${focusedTurnId}:`)).length, turnId);
}
