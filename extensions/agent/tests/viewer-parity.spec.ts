import { expect, test } from '@playwright/test';

import { FIXTURE_CONVERSATION_ID, installAgentHost } from './viewer-fixture';

test.beforeEach(async ({ page }) => {
  await installAgentHost(page);
});

test('contains rich Markdown while preserving its presentation primitives', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureMarkdown=1'));

  await expect(page.getByRole('heading', { name: 'Rendered answer' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.locator('.codex-md-code-block')).toBeVisible();
  await expect(page.locator('.codex-md-file-link')).toHaveAttribute('title', 'src/index.ts:12');

  const containment = await page.getByTestId('agent-transcript-scroll').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(containment.scrollWidth).toBeLessThanOrEqual(containment.clientWidth + 1);
});

test('keeps long user and assistant content inside the mobile transcript rail', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'This regression targets the phone-width transcript rail.');
  await page.goto(conversationUrl('&fixtureOverflow=1'));

  await expect(page.getByText('Automated recovery retry:', { exact: false })).toBeVisible();
  await expect(page.getByText('What an extension is', { exact: true })).toBeVisible();

  const containment = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]');
    const content = document.querySelector<HTMLElement>('[data-testid="agent-transcript-content"]');
    if (!scroller || !content) throw new Error('Transcript containment elements are missing.');

    const contentRect = content.getBoundingClientRect();
    const candidates = Array.from(document.querySelectorAll<HTMLElement>([
      '.codex-user-bubble',
      '.codex-markdown',
      '.codex-md-block-frame',
      '.codex-md-text-line',
    ].join(',')));
    return {
      content: { left: contentRect.left, right: contentRect.right, width: contentRect.width },
      layoutWidth: Number(content.dataset.layoutWidth),
      offenders: candidates.flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const exceedsRail = rect.left < contentRect.left - 1 || rect.right > contentRect.right + 1;
        const hasIntrinsicOverflow = element.scrollWidth > element.clientWidth + 1;
        return exceedsRail || hasIntrinsicOverflow
          ? [{
              className: element.className,
              clientWidth: element.clientWidth,
              left: rect.left,
              right: rect.right,
              scrollWidth: element.scrollWidth,
            }]
          : [];
      }),
      scroller: { clientWidth: scroller.clientWidth, scrollWidth: scroller.scrollWidth },
    };
  });

  expect(containment.content.width).toBeGreaterThan(0);
  expect(containment.layoutWidth).toBeGreaterThanOrEqual(containment.content.width - 1);
  expect(containment.offenders).toEqual([]);
  expect(containment.scroller.scrollWidth).toBeLessThanOrEqual(containment.scroller.clientWidth + 1);
});

test('loads oversized exact content only after an explicit viewer action', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureExact=1'));

  await expect(page.getByText('Exact preview.', { exact: true })).toBeVisible();
  expect(await artifactRequestCount(page)).toBe(0);
  await page.getByRole('button', { name: /Open exact response/u }).click();
  await expect(page.getByRole('dialog', { name: 'Exact response' })).toBeVisible();
  expect(await artifactRequestCount(page)).toBe(0);
  await page.getByRole('button', { name: 'Load next chunk' }).click();
  await expect(page.getByRole('dialog', { name: 'Exact response' })).toContainText(
    'Exact preview. The remaining',
  );
  await expect.poll(() => artifactRequestCount(page)).toBe(1);
});

test('loads semantic inference traces and child scopes only after disclosure', async ({ page }) => {
  await page.goto('/viewers/agent/');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Inspect work details');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();

  const workHeader = page.locator('.codex-work-header');
  await expect(workHeader).toHaveAttribute('aria-expanded', 'false');
  expect(await transcriptRequestTypes(page)).not.toContain('executionScope');
  await workHeader.click();
  await expect(page.locator('.agent-commentary-block')).toContainText(
    'Grounding the change in the current workspace.',
  );
  const reasoning = page.locator('.agent-reasoning-block');
  await expect(reasoning.first()).toContainText('Checking context.');
  const parentInference = page.locator('.agent-inference').first();
  await expect(parentInference.locator(':scope > .agent-reasoning-block')).toHaveCount(1);
  await expect(parentInference.locator(':scope > .agent-commentary-block')).toHaveCount(1);
  const parentSurfaceOrder = await parentInference.locator(':scope > *').evaluateAll((elements) =>
    elements.map((element) => element.classList.contains('agent-reasoning-block')
      ? 'reasoning'
      : element.classList.contains('agent-commentary-block')
        ? 'commentary'
        : element.classList.contains('agent-action-sequence')
          ? 'actions'
          : 'unknown'));
  expect(parentSurfaceOrder).toEqual(['reasoning', 'commentary', 'actions']);
  await expect(parentInference.locator(':scope > .agent-commentary-block')).toHaveCSS(
    'font-weight',
    '400',
  );
  await expect(reasoning.first().locator('.codex-md-inline-strong')).toHaveCSS(
    'font-weight',
    '400',
  );
  const parentActions = page.getByRole('button', { name: /Edited index\.ts · Read 1 file/u });
  await expect(parentActions).toBeVisible();
  expect(await transcriptRequestTypes(page)).toContain('executionScope');
  expect((await transcriptRequestTypes(page) as string[])
    .filter((type) => type === 'executionScope')).toHaveLength(1);

  const focusedUnit = page.getByRole('button', { name: /Verify the focused seam/u });
  await expect(focusedUnit).toBeVisible();
  expect(await focusedUnit.locator(':scope > span').evaluateAll((elements) =>
    elements.map((element) => element.className))).toEqual([
    'agent-work-unit-state',
    'agent-work-unit-copy',
    'agent-work-unit-chevron',
  ]);
  await expect(page.locator('.codex-work-separator')).toHaveCount(1);
  await expect(page.locator('.agent-work-unit')).toHaveCSS('border-left-width', '0px');
  await expect(reasoning.first()).toHaveCSS('border-left-width', '0px');
  await focusedUnit.hover();
  await expect(focusedUnit).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await focusedUnit.click();
  await expect(page.getByText('Assignment', { exact: true })).toBeVisible();
  await expect(page.getByText('The exact contract and implementation agree.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verified' })).toBeVisible();
  await expect(page.getByText('Handoff', { exact: true })).toBeVisible();
  await expect(page.getByText(
    'The focused seam matches its exact contract without changing unrelated runtime behavior.',
  )).toBeVisible();
  await expect(page.getByText('Returned resources', { exact: true })).toBeVisible();
  await expect(page.locator('.agent-work-unit-outcome').getByText(
    'Verified implementation.',
  )).toBeVisible();
  expect((await transcriptRequestTypes(page) as string[])
    .filter((type) => type === 'executionScope')).toHaveLength(2);
  expect(await transcriptRequestTypes(page)).not.toContain('operationDetail');
  const childReasoning = reasoning.filter({ hasText: 'Compared the implementation with its contract.' });
  await expect(childReasoning).toContainText(
    'Compared the implementation with its contract.',
  );
  const childActions = page.getByRole('button', { name: /Ran 1 command/u });
  await childActions.click();
  const childTool = page.locator('.agent-tool-call').filter({ hasText: 'bash' });
  await expect(childTool).toHaveCSS('border-left-width', '0px');
  await expect(page.locator('.agent-work-unit-assignment')).toHaveCSS('border-bottom-width', '0px');
  await expect(page.locator('.agent-work-unit-outcome')).toHaveCSS('border-top-width', '0px');
  await childTool.locator('> button').click();
  await expect(childTool).toContainText('1 test passed');
  expect(await transcriptRequestTypes(page)).toContain('operationDetail');

  await parentActions.click();
  const readRow = page.locator('.agent-tool-call').filter({ hasText: 'workspace.read' });
  await readRow.locator('> button').click();
  await expect(page.getByText('Read the workspace overview before editing.')).toBeVisible();
  await expect(page.getByText(/Fixture file output/u)).toBeVisible();

  const editRow = page.locator('.agent-tool-call').filter({ hasText: 'workspace.edit' });
  await editRow.locator('> button').click();
  await expect(editRow).toContainText('+export const value = 1;');

  const workContainment = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]');
    const content = document.querySelector<HTMLElement>('[data-testid="agent-transcript-content"]');
    if (!scroller || !content) throw new Error('Transcript containment elements are missing.');
    const rail = content.getBoundingClientRect();
    const offenders = Array.from(document.querySelectorAll<HTMLElement>([
      '.agent-execution-scope',
      '.agent-action-run',
      '.agent-work-unit',
      '.agent-tool-call',
      '.agent-work-unit .codex-markdown',
      '.agent-work-unit .codex-md-text-line',
      '.agent-reasoning-block .codex-md-text-line',
    ].join(','))).flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const exceedsRail = rect.left < rail.left - 1 || rect.right > rail.right + 1;
      const hasIntrinsicOverflow = element.scrollWidth > element.clientWidth + 1;
      return exceedsRail || hasIntrinsicOverflow
        ? [{
            className: element.className,
            clientWidth: element.clientWidth,
            left: rect.left,
            right: rect.right,
            scrollWidth: element.scrollWidth,
          }]
        : [];
    });
    return {
      offenders,
      scrollerClientWidth: scroller.clientWidth,
      scrollerScrollWidth: scroller.scrollWidth,
    };
  });
  expect(workContainment.offenders).toEqual([]);
  expect(workContainment.scrollerScrollWidth).toBeLessThanOrEqual(
    workContainment.scrollerClientWidth + 1,
  );

  await workHeader.click();
  await expect(workHeader).toHaveAttribute('aria-expanded', 'false');
});

test('opens work traces while the running server still serves the prior inference shape', async ({ page }) => {
  await page.goto('/viewers/agent/?fixtureLegacyInferenceTrace=1');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Inspect work details');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();

  await page.locator('.codex-work-header').click();
  const parentInference = page.locator('.agent-inference').first();
  await expect(parentInference.locator(':scope > .agent-reasoning-block')).toContainText(
    'Checking context.',
  );
  await expect(parentInference.locator(':scope > .agent-commentary-block')).toContainText(
    'Grounding the change in the current workspace.',
  );
  await expect(page.getByRole('button', { name: /Edited index\.ts · Read 1 file/u })).toBeVisible();

  await page.getByRole('button', { name: /Verify the focused seam/u }).click();
  await expect(page.getByText('Compared the implementation with its contract.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Ran 1 command/u })).toBeVisible();
  await expect(page.locator('.agent-work-unit-outcome .codex-markdown strong').first()).toHaveCSS(
    'text-transform',
    'none',
  );
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
});

test('refreshes an open execution scope as one semantic revision', async ({ page }) => {
  await page.goto('/viewers/agent/');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Create paged work');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
  await page.locator('.codex-work-header').click();
  await expect(page.locator('.agent-inference')).toHaveCount(1);
  const readsBefore = (await transcriptRequestTypes(page) as string[])
    .filter((type) => type === 'executionScope').length;
  await page.evaluate(() => (window as any).__agentFixture.reviseLatestExecutionScope());
  await expect(page.locator('.agent-inference')).toHaveCount(2);
  await expect(page.getByText('Validated the refreshed execution-scope revision.', { exact: true }).first())
    .toBeVisible();
  const readsAfter = (await transcriptRequestTypes(page) as string[])
    .filter((type) => type === 'executionScope').length;
  expect(readsAfter).toBeGreaterThan(readsBefore);
  await expect(page.locator('.agent-inference').filter({ hasText: 'Checking context.' })).toHaveCount(1);
});

test('pages only after a user scroll and preserves the mounted row anchor', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureLong=1'));
  await expect(page.getByText('Historical answer 72.')).toBeVisible();

  const mountedBefore = await page.locator('.codex-transcript-turn').count();
  expect(mountedBefore).toBeGreaterThan(0);
  expect(mountedBefore).toBeLessThan(24);

  const syncCount = () => transcriptSyncCount(page);
  await expect.poll(syncCount).toBe(1);

  const viewport = page.getByTestId('agent-transcript-scroll');
  await viewport.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event('scrollend'));
  });
  await page.waitForTimeout(250);
  expect(await syncCount()).toBe(1);

  const anchor = page.locator('[data-transcript-row-id^="turn-49:"]').first();
  await expect(anchor).toBeVisible();
  const beforeTop = await anchor.evaluate((node) => node.getBoundingClientRect().top);
  await viewport.evaluate((node) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -12 }));
    node.dispatchEvent(new Event('scrollend'));
  });
  await expect.poll(syncCount).toBe(2);
  expect(await latestTranscriptSyncWindow(page)).toMatchObject({
    before: 16,
    kind: 'around',
    turnId: 'turn-49',
  });
  const afterTop = await anchor.evaluate((node) => node.getBoundingClientRect().top);
  expect(Math.abs(afterTop - beforeTop)).toBeLessThanOrEqual(1);

  const mountedAfter = await page.locator('.codex-transcript-turn').count();
  expect(mountedAfter).toBeLessThanOrEqual(32);
});

test('keeps a sent message visible while work and assistant output settle', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureLong=1'));
  await expect(page.getByText('Historical answer 72.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Message' }).fill('Anchor this user request');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  await expect(page.getByTestId('agent-transcript-scroll').getByText('Anchor this user request')).toBeVisible();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
  await expect(page.getByTestId('agent-transcript-scroll').getByText('Anchor this user request')).toBeVisible();
});

function conversationUrl(extra = '') {
  return `/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}${extra}`;
}

async function transcriptRequestTypes(page: import('@playwright/test').Page) {
  return page.evaluate(() => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === 'remux/agent/transcript/resources/read')
    .flatMap((entry: { summary: string }) => JSON.parse(entry.summary).map((request: { type: string }) => request.type)));
}

async function artifactRequestCount(page: import('@playwright/test').Page) {
  return page.evaluate(() => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === 'remux/agent/artifact/read').length);
}

async function transcriptSyncCount(page: import('@playwright/test').Page) {
  return page.evaluate(() => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string; summary: string }) => {
      if (entry.method !== 'remux/agent/transcript/resources/read') return false;
      return JSON.parse(entry.summary).some((request: { type?: string }) => request.type === 'transcriptSync');
    }).length);
}

async function latestTranscriptSyncWindow(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const entries = (window as any).__agentFixture.requestLog
      .filter((entry: { method: string }) => entry.method === 'remux/agent/transcript/resources/read');
    const requests = JSON.parse(entries.at(-1)?.summary ?? '[]');
    return requests.find((request: { type?: string }) => request.type === 'transcriptSync')?.window;
  });
}
