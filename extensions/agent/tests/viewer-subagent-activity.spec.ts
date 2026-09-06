import { expect, test, type Page } from '@playwright/test';

import { FIXTURE_CONVERSATION_ID, FIXTURE_SECOND_CONVERSATION_ID, installAgentHost } from './viewer-fixture';

test.beforeEach(async ({ page }) => {
  await installAgentHost(page);
  await page.goto(conversationUrl('&fixtureLong=1'));
});

test('colors the Agents icon for authoritative subagent lifecycle state', async ({ page }) => {
  const icon = page.locator('.remux-agents-icon');
  await setLifecycle(page, { state: 'running', runningCount: 1 });
  await expect(page.locator('.remux-composer-agents-button')).toHaveAttribute('aria-label', /1 subagent running/u);
  await expect(icon).toHaveAttribute('data-active', 'true');
  await expect(icon).toHaveCSS('color', 'rgb(249, 115, 22)');
  await expect(page.locator('.remux-subagent-badge')).toHaveCount(0);
  await expect(page.locator('.remux-composer-agents-button')).toHaveAttribute('title', '1 subagent running');

  await setLifecycle(page, { state: 'running', runningCount: 2, checkingCount: 1 });
  await expect(page.locator('.remux-composer-agents-button')).toHaveAttribute('aria-label', /2 subagents running · 1 checking/u);
  await expect(icon).toHaveAttribute('data-state', 'running');

  await setLifecycle(page, { state: 'checking', checkingCount: 1 });
  await expect(page.locator('.remux-composer-agents-button')).toHaveAttribute('aria-label', /Checking subagents…/u);
  await setLifecycle(page, { state: 'stopping', stoppingCount: 2, stopRequested: true });
  await expect(page.locator('.remux-composer-agents-button')).toHaveAttribute('aria-label', /Stopping 2 subagents…/u);
  await setLifecycle(page, { state: 'unavailable', checkingCount: 1 });
  await expect(page.locator('.remux-composer-agents-button')).toHaveAttribute('aria-label', /Subagent status unavailable/u);
  await setLifecycle(page, { state: 'idle', stopErrorCount: 2 });
  await expect(page.locator('.remux-composer-agents-button')).toHaveAttribute('aria-label', /Couldn’t stop 2 subagents/u);
  await setLifecycle(page, { state: 'idle' });
  await expect(icon).not.toHaveAttribute('data-active', 'true');
});

test('shows checking while disconnected and stops children when the root is idle', async ({ page }) => {
  await setLifecycle(page, { state: 'running', runningCount: 1 });
  await page.evaluate(() => (window as any).__agentFixture.connection('reconnecting'));
  await expect(page.locator('.remux-composer-agents-button')).toHaveAttribute('aria-label', /Checking subagents…/u);
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

  await page.locator('.remux-composer-agents-button').click();
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
  await expect(page.locator('.remux-composer-agents-button')).toHaveAttribute('aria-label', /3 subagents running/u);
  await page.evaluate((id) => {
    const fixture = (window as any).__agentFixture;
    fixture.addConversation({ id, title: 'Quiet conversation' });
    fixture.setRuntimeLifecycle({ state: 'idle' }, id);
    fixture.navigate('agentConversation', id);
  }, FIXTURE_SECOND_CONVERSATION_ID);
  await expect.poll(() => new URL(page.url()).searchParams.get('remuxResourceId'))
    .toBe(FIXTURE_SECOND_CONVERSATION_ID);
  await expect(page.locator('.remux-agents-icon')).not.toHaveAttribute('data-active', 'true');
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
