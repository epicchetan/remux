import { expect, test, type Page } from '@playwright/test';

import { FIXTURE_CONVERSATION_ID, FIXTURE_SECOND_CONVERSATION_ID, installAgentHost } from './viewer-fixture';

test.beforeEach(async ({ page }) => {
  await installAgentHost(page);
  await page.goto(conversationUrl('&fixtureLong=1'));
});

test('renders authoritative subagent lifecycle copy in one fixed-height row', async ({ page }) => {
  const row = page.locator('.remux-subagent-activity');
  await setLifecycle(page, { state: 'running', runningCount: 1 });
  await expect(row).toHaveText(/1 subagent running/u);
  await expect.poll(() => row.evaluate((node) => node.getBoundingClientRect().height)).toBe(36);

  await setLifecycle(page, { state: 'running', runningCount: 2, checkingCount: 1 });
  await expect(row).toContainText('2 subagents running · 1 checking');
  await expect.poll(() => row.evaluate((node) => node.getBoundingClientRect().height)).toBe(36);

  await setLifecycle(page, { state: 'checking', checkingCount: 1 });
  await expect(row).toContainText('Checking subagents…');
  await setLifecycle(page, { state: 'stopping', stoppingCount: 2, stopRequested: true });
  await expect(row).toContainText('Stopping 2 subagents…');
  await setLifecycle(page, { state: 'unavailable', checkingCount: 1 });
  await expect(row).toContainText('Subagent status unavailable');
  await setLifecycle(page, { state: 'idle', stopErrorCount: 2 });
  await expect(row).toContainText('Couldn’t stop 2 subagents');
  await setLifecycle(page, { state: 'idle' });
  await expect(row).toHaveCount(0);
});

test('shows checking while disconnected and stops children when the root is idle', async ({ page }) => {
  await setLifecycle(page, { state: 'running', runningCount: 1 });
  await page.evaluate(() => (window as any).__agentFixture.connection('reconnecting'));
  await expect(page.locator('.remux-subagent-activity')).toContainText('Checking subagents…');
  await page.evaluate(() => (window as any).__agentFixture.connection('connected'));
  await expect(page.getByRole('button', { name: 'Stop turn', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop turn', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__agentFixture.requestLog
    .filter((entry: any) => entry.method === 'remux/agent/conversation/interrupt').length)).toBe(1);
});

test('preserves reading anchors, bottom follow, and Agents return position', async ({ page }) => {
  const viewport = page.getByTestId('agent-transcript-scroll');
  await viewport.evaluate((node) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -60 }));
    node.scrollTop = (node.scrollHeight - node.clientHeight) * 0.45;
    node.dispatchEvent(new Event('scroll'));
  });
  const before = await visibleAnchor(page);
  await setLifecycle(page, { state: 'running', runningCount: 1 });
  await expect.poll(async () => Math.abs(await anchorTop(page, before.id) - before.top)).toBeLessThanOrEqual(2);

  await page.locator('.remux-subagent-activity').click();
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('.remux-main-pane')!.getBoundingClientRect();
    const agents = document.querySelector<HTMLElement>('.agent-executions-view')!.getBoundingClientRect();
    return Math.abs(main.bottom - agents.bottom);
  })).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Back to chat' }).click();
  await expect.poll(async () => Math.abs(await anchorTop(page, before.id) - before.top)).toBeLessThanOrEqual(2);

  await viewport.evaluate((node) => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
  await setLifecycle(page, { state: 'idle' });
  await expect.poll(() => viewport.evaluate((node) =>
    Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop))).toBeLessThanOrEqual(2);
});

test('does not flash lifecycle counts across conversation switches', async ({ page }) => {
  await setLifecycle(page, { state: 'running', runningCount: 3 });
  await expect(page.locator('.remux-subagent-activity')).toContainText('3 subagents running');
  await page.evaluate((id) => {
    const fixture = (window as any).__agentFixture;
    fixture.addConversation({ id, title: 'Quiet conversation' });
    fixture.setRuntimeLifecycle({ state: 'idle' }, id);
    fixture.navigate('agentConversation', id);
  }, FIXTURE_SECOND_CONVERSATION_ID);
  await expect.poll(() => new URL(page.url()).searchParams.get('remuxResourceId'))
    .toBe(FIXTURE_SECOND_CONVERSATION_ID);
  await expect(page.locator('.remux-subagent-activity')).toHaveCount(0);
});

async function setLifecycle(page: Page, lifecycle: Record<string, unknown>) {
  await page.evaluate((value) => (window as any).__agentFixture.setRuntimeLifecycle(value), lifecycle);
}

async function visibleAnchor(page: Page) {
  return page.getByTestId('agent-transcript-scroll').evaluate((viewport) => {
    const bounds = viewport.getBoundingClientRect();
    const row = [...viewport.querySelectorAll<HTMLElement>('[data-transcript-row-id]')]
      .find((candidate) => candidate.getBoundingClientRect().bottom > bounds.top + 1)!;
    return { id: row.dataset.transcriptRowId, top: row.getBoundingClientRect().top };
  });
}

async function anchorTop(page: Page, id: string | undefined) {
  return page.locator(`[data-transcript-row-id="${id}"]`).evaluate((row) =>
    row.getBoundingClientRect().top);
}

function conversationUrl(extra = '') {
  return `/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}${extra}`;
}
