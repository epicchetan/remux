import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_CONVERSATION_ID, installAgentHost } from './viewer-fixture';

const base = `/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}`;
const viewport = (page: Page) => page.getByTestId('agent-transcript-scroll');
const continuation = (page: Page) => page.locator('[data-section-kind="continuation"]').last();
const report = 'This is a substantial continuation report with enough text to occupy the viewport.\n\n'.repeat(60);

async function anchorError(page: Page) {
  return continuation(page).evaluate(row => {
    const scroll = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
    const content = document.querySelector<HTMLElement>('[data-testid="agent-transcript-content"]')!;
    return Math.abs(row.getBoundingClientRect().top - scroll.getBoundingClientRect().top -
      Math.max(24, parseFloat(getComputedStyle(content).paddingTop)));
  });
}

test.beforeEach(async ({ page }) => { await installAgentHost(page); });

test('reload starts a long continuation report at its divider', async ({ page }) => {
  await page.goto(`${base}&fixtureLong=1&fixtureLongFinal=1&fixtureContinuationChain=1`);
  await expect.poll(() => anchorError(page)).toBeLessThanOrEqual(2);
  await page.reload();
  await expect.poll(() => anchorError(page)).toBeLessThanOrEqual(2);
  await expect(page.getByRole('button', { name: 'New update', exact: true })).toHaveCount(0);
});

test('short continuation reload uses the natural bottom', async ({ page }) => {
  await page.goto(`${base}&fixtureLong=1&fixtureContinuation=1`);
  await expect(continuation(page)).toBeVisible();
  await expect.poll(() => viewport(page).evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThanOrEqual(2);
});

test('route and host focus can address a continuation with no human message', async ({ page }) => {
  await page.goto(`${base}&fixtureLong=1&fixtureLongFinal=1&fixtureContinuation=1&remuxFocusKind=turn&remuxFocusId=turn-72`);
  await expect.poll(() => anchorError(page)).toBeLessThanOrEqual(2);
  await page.evaluate(({ conversationId }) => {
    const row = document.querySelector<HTMLElement>('[data-section-kind="continuation"]')!;
    (window as any).__agentFixture.navigate('agentConversation', conversationId, 'section',
      JSON.stringify([row.dataset.turnId, row.dataset.segmentId]));
  }, { conversationId: FIXTURE_CONVERSATION_ID });
  await expect.poll(() => anchorError(page)).toBeLessThanOrEqual(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a new continuation preserves the reading position and offers a jump', async ({ page }) => {
  await page.goto(`${base}&fixtureLong=1&fixtureLongFinal=1`);
  await expect(page.locator('[data-row-kind="userMessage"]').last()).toBeVisible();
  await viewport(page).evaluate(el => {
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    el.scrollTop -= 300;
    el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(250);
  const before = await viewport(page).evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const row = Array.from(el.querySelectorAll<HTMLElement>('[data-transcript-row-id]'))
      .find(row => row.getBoundingClientRect().bottom > top + 30)!;
    return { id: row.dataset.transcriptRowId!, offset: row.getBoundingClientRect().top - top };
  });
  const turnId = await page.evaluate(text => (window as any).__agentFixture.appendContinuation(text), report);
  const jump = page.getByRole('button', { name: 'New update', exact: true });
  await expect(jump).toBeVisible();
  const after = await viewport(page).evaluate((el, id) => {
    const row = Array.from(el.querySelectorAll<HTMLElement>('[data-transcript-row-id]'))
      .find(row => row.dataset.transcriptRowId === id)!;
    return row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, before.id);
  expect(Math.abs(after - before.offset)).toBeLessThanOrEqual(2);
  await jump.click();
  await expect(page.locator(`[data-section-kind="continuation"][data-turn-id="${turnId}"]`)).toBeVisible();
  await expect.poll(() => anchorError(page)).toBeLessThanOrEqual(2);
  await expect(jump).toHaveCount(0);
});

test('running continuation reload anchors its divider above active work', async ({ page }) => {
  await page.goto(`${base}&fixtureLong=1&fixtureRunning=1&fixtureTallWork=1&fixtureContinuation=1`);
  await expect(continuation(page)).toBeVisible();
  await expect.poll(() => anchorError(page)).toBeLessThanOrEqual(2);
  await page.reload();
  await expect.poll(() => anchorError(page)).toBeLessThanOrEqual(2);
});

test('cold section focus overrides the default latest continuation', async ({ page }) => {
  const address = encodeURIComponent(JSON.stringify(['turn-70', 'notice:fixture-client:turn-70']));
  await page.goto(`${base}&fixtureLong=1&fixtureLongFinal=1&fixtureContinuationChain=1&remuxFocusKind=section&remuxFocusId=${address}`);
  const row = page.locator('[data-section-kind="continuation"][data-turn-id="turn-70"]');
  await expect(row).toBeVisible();
  await expect.poll(() => row.evaluate(el => {
    const scroll = document.querySelector('[data-testid="agent-transcript-scroll"]')!;
    return Math.abs(el.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 24);
  })).toBeLessThanOrEqual(2);
});

test('missing continuation section reports a dismissible focus error', async ({ page }) => {
  const address = encodeURIComponent(JSON.stringify(['turn-72', 'notice:missing']));
  await page.goto(`${base}&fixtureLong=1&fixtureContinuation=1&remuxFocusKind=section&remuxFocusId=${address}`);
  await expect(page.getByRole('alert')).toContainText('The requested update could not be loaded.');
  await page.getByRole('button', { name: 'Dismiss turn focus error' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
