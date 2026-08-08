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

test('loads work summaries and entry details only after disclosure', async ({ page }) => {
  await page.goto('/viewers/agent/');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Inspect work details');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();

  const workHeader = page.locator('.codex-work-header');
  await expect(workHeader).toHaveAttribute('aria-expanded', 'false');
  expect(await transcriptRequestTypes(page)).not.toContain('workGroup');
  await workHeader.click();
  await expect(page.getByText('Workspace reads')).toBeVisible();
  expect(await transcriptRequestTypes(page)).toContain('workGroup');
  expect(await transcriptRequestTypes(page)).not.toContain('workEntryDetail');
  const readRow = page.getByRole('button', { name: /Read README\.md/u });
  await readRow.click();
  await expect(page.getByText('Read the workspace overview before editing.')).toBeVisible();
  await expect(page.getByText(/Fixture file output/u)).toBeVisible();
  expect(await transcriptRequestTypes(page)).toContain('workEntryDetail');

  await page.getByRole('button', { name: /src\/index\.ts/u }).click();
  await expect(page.locator('.codex-diff-line-added')).toContainText('+export const value = 1;');

  await workHeader.click();
  await expect(workHeader).toHaveAttribute('aria-expanded', 'false');
});

test('recovers stale work pagination without mixing group revisions', async ({ page }) => {
  await page.goto('/viewers/agent/');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Create paged work');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
  await page.evaluate(() => (window as any).__agentFixture.populateLatestWorkGroup(205));

  await page.locator('.codex-work-header').click();
  const activityRows = page.locator('.codex-work-group[data-group-type="activity"] .codex-work-row');
  await expect(activityRows).toHaveCount(200);
  await page.evaluate(() => (window as any).__agentFixture.staleNextWorkPage());
  await page.getByRole('button', { name: 'Load more' }).click();
  const failure = page.locator('.codex-work-error');
  await expect(failure).toContainText('Work changed while the next page was loading.');
  await expect(activityRows).toHaveCount(200);

  await failure.getByRole('button', { name: 'Retry' }).click();
  await expect(failure).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(activityRows).toHaveCount(205);
  expect(await activityRows.evaluateAll((rows) =>
    new Set(rows.map((row) => row.textContent)).size)).toBe(205);
  const continuationRequests = await page.evaluate(() => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === 'remux/agent/transcript/resources/read')
    .flatMap((entry: { summary: string }) => JSON.parse(entry.summary))
    .filter((request: any) => request.type === 'workGroup' && request.cursor));
  expect(continuationRequests.length).toBeGreaterThanOrEqual(2);
  expect(continuationRequests.every((request: any) =>
    !/^\d+$/.test(request.cursor) && request.knownRevision === undefined)).toBe(true);
});

test('keeps the DOM bounded and can request an earlier transcript window', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureLong=1'));
  await expect(page.getByText('Historical answer 72.')).toBeVisible();

  const mountedBefore = await page.locator('[data-turn-id]').count();
  expect(mountedBefore).toBeGreaterThan(0);
  expect(mountedBefore).toBeLessThan(24);

  await page.getByTestId('agent-transcript-scroll').evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.getByRole('button', { name: 'Load earlier turns' }).click();
  await expect(page.getByText('Historical request 33')).toBeVisible();
  const mountedAfter = await page.locator('[data-turn-id]').count();
  expect(mountedAfter).toBeLessThan(24);
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
