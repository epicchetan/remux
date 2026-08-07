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

  await expect(page.getByText('Anchor this user request')).toBeVisible();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
  await expect(page.getByText('Anchor this user request')).toBeVisible();
});

function conversationUrl(extra = '') {
  return `/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}${extra}`;
}

async function transcriptRequestTypes(page: import('@playwright/test').Page) {
  return page.evaluate(() => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === 'remux/agent/transcript/resources/read')
    .flatMap((entry: { summary: string }) => JSON.parse(entry.summary).map((request: { type: string }) => request.type)));
}
