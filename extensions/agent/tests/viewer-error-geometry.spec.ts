import { expect, test, type Page } from '@playwright/test';

import { FIXTURE_CONVERSATION_ID, installAgentHost } from './viewer-fixture';

test.beforeEach(async ({ page }) => {
  await installAgentHost(page);
  await page.goto(`/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}&fixtureErrorGeometry=1`);
});

test('keeps failed-turn modeled geometry aligned through wrapping, resize, and virtual remount', async ({ page }) => {
  await expect(page.getByText('Geometry answer 48.', { exact: true })).toBeVisible();
  await scrollTurnIntoView(page, 'turn-27');

  await expect(page.locator('[data-turn-id="turn-26"] .codex-turn-error')).toHaveText('Short capacity error.');
  await expect(page.locator('[data-turn-id="turn-27"] .codex-turn-error')).toContainText('Selected model is at capacity.');
  await expectTurnGeometry(page, ['turn-24', 'turn-25', 'turn-26', 'turn-27', 'turn-28']);
  await expect(page.locator('[data-turn-id="turn-27"] .codex-turn-error')).toHaveJSProperty('scrollHeight',
    await page.locator('[data-turn-id="turn-27"] .codex-turn-error').evaluate((node) => node.clientHeight));

  await page.setViewportSize({ width: 360, height: 720 });
  await scrollTurnIntoView(page, 'turn-27');
  await expectTurnGeometry(page, ['turn-26', 'turn-27', 'turn-28']);

  const viewport = page.getByTestId('agent-transcript-scroll');
  await viewport.evaluate((node) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
    node.dispatchEvent(new Event('scrollend'));
  });
  await expect(page.locator('[data-turn-id="turn-27"]')).toHaveCount(0);
  await scrollTurnIntoView(page, 'turn-27');
  await expectTurnGeometry(page, ['turn-26', 'turn-27', 'turn-28']);
});

test('preserves a reading anchor when an error clears and reappears and keeps bottom follow', async ({ page }) => {
  await expect(page.getByText('Geometry answer 48.', { exact: true })).toBeVisible();
  await scrollTurnIntoView(page, 'turn-28');
  await page.getByRole('button', { name: 'Previous turn' }).click();
  await expectMessageAnchor(page, 'turn-27');
  await page.getByRole('button', { name: 'Next turn or bottom' }).click();
  await expectMessageAnchor(page, 'turn-28');
  const before = await turnViewportOffset(page, 'turn-28');

  await page.evaluate(() => (window as any).__agentFixture.setTurnError('turn-27', null));
  await expect(page.locator('[data-turn-id="turn-27"] .codex-turn-error')).toHaveCount(0);
  await expect.poll(async () => Math.abs(await turnViewportOffset(page, 'turn-28') - before)).toBeLessThanOrEqual(2);
  await expectTurnGeometry(page, ['turn-27', 'turn-28']);

  await page.evaluate(async () => {
    const modulePath = '/src/transcript/resourceStore.ts';
    const resources = await import(modulePath);
    resources.setTranscriptProjectionErrorForTest('turn-28', {
      code: 'projectionFailed',
      message: 'Fixture projection failed.',
    });
  });
  await expect(page.getByRole('button', { name: 'Retry turn projection' })).toBeVisible();
  await expectTurnGeometry(page, ['turn-27', 'turn-28']);
  await page.evaluate(async () => {
    const modulePath = '/src/transcript/resourceStore.ts';
    const resources = await import(modulePath);
    resources.setTranscriptProjectionErrorForTest('turn-28', null);
  });
  await expect(page.getByRole('button', { name: 'Retry turn projection' })).toHaveCount(0);
  await expectTurnGeometry(page, ['turn-27', 'turn-28']);

  const restored = 'Selected model is at capacity. Please try a different model. '.repeat(5);
  await page.evaluate((message) => (window as any).__agentFixture.setTurnError('turn-27', message), restored);
  await expect(page.locator('[data-turn-id="turn-27"] .codex-turn-error')).toHaveText(restored);
  await expect.poll(async () => Math.abs(await turnViewportOffset(page, 'turn-28') - before)).toBeLessThanOrEqual(2);
  await expectTurnGeometry(page, ['turn-27', 'turn-28']);

  const viewport = page.getByTestId('agent-transcript-scroll');
  await viewport.evaluate((node) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
    node.dispatchEvent(new Event('scrollend'));
  });
  await page.waitForTimeout(150);
  await expect.poll(() => viewport.evaluate((node) => Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop)))
    .toBeLessThanOrEqual(2);
  await page.evaluate(() => (window as any).__agentFixture.setTurnError('turn-47', 'A newly visible terminal error.'));
  await expect(page.locator('[data-turn-id="turn-47"] .codex-turn-error')).toBeVisible();
  await expect.poll(() => viewport.evaluate((node) => Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop)))
    .toBeLessThanOrEqual(2);
  const bottomScrollTop = await viewport.evaluate((node) => node.scrollTop);
  await page.getByRole('button', { name: 'Previous turn' }).click();
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeLessThan(bottomScrollTop);
  const previousScrollTop = await viewport.evaluate((node) => node.scrollTop);
  await page.getByRole('button', { name: 'Next turn' }).click();
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(previousScrollTop);
  await expectTurnGeometry(page, ['turn-47', 'turn-48']);
});

test('keeps terminal footer geometry adjacent to expanded work and collapses cleanly', async ({ page }) => {
  await expect(page.getByText('Healthy answer after work.', { exact: true })).toBeVisible();
  const failedTurn = page.locator('article[data-turn-id="turn-work-error"]');
  const nextTurn = page.locator('article[data-turn-id="turn-after-work-error"]');
  const workRow = failedTurn.locator('.codex-transcript-row-work');
  const header = failedTurn.locator('.codex-work-header');
  await expect(failedTurn.locator('.codex-turn-error')).toHaveText('Failure after expanded work.');
  await expectTurnGeometry(page, ['turn-work-error', 'turn-after-work-error']);

  const collapsedHeight = Number(await failedTurn.getAttribute('data-collapsed-height'));
  await header.click();
  await expect(failedTurn.locator('.codex-work-content')).toBeVisible();
  await expect.poll(async () => Number(await workRow.getAttribute('data-expanded-additional-height')))
    .toBeGreaterThan(0);
  await expect.poll(async () => {
    const failedBox = await failedTurn.boundingBox();
    const nextBox = await nextTurn.boundingBox();
    const additional = Number(await workRow.getAttribute('data-expanded-additional-height'));
    if (!failedBox || !nextBox) return Number.POSITIVE_INFINITY;
    return Math.abs(nextBox.y - failedBox.y - collapsedHeight - additional);
  }).toBeLessThanOrEqual(2);
  await expect.poll(async () => {
    const actualHeight = await failedTurn.evaluate((node) => node.getBoundingClientRect().height);
    const additional = Number(await workRow.getAttribute('data-expanded-additional-height'));
    return Math.abs(actualHeight - collapsedHeight - additional);
  }).toBeLessThanOrEqual(2);

  await header.click();
  await expect(failedTurn.locator('.codex-work-content')).toHaveCount(0);
  await expectTurnGeometry(page, ['turn-work-error', 'turn-after-work-error']);
});

async function expectTurnGeometry(page: Page, turnIds: string[]) {
  for (const turnId of turnIds) {
    await expect.poll(async () => page.locator(`[data-turn-id="${turnId}"]`).first().evaluate((node) => {
      const element = node as HTMLElement;
      return Math.abs(element.getBoundingClientRect().height - Number(element.dataset.collapsedHeight));
    })).toBeLessThanOrEqual(2);
  }
  for (let index = 1; index < turnIds.length; index += 1) {
    const previous = page.locator(`[data-turn-id="${turnIds[index - 1]}"]`).first();
    const next = page.locator(`[data-turn-id="${turnIds[index]}"]`).first();
    await expect.poll(async () => {
      const previousBox = await previous.boundingBox();
      const nextBox = await next.boundingBox();
      return previousBox && nextBox ? Math.abs(nextBox.y - (previousBox.y + previousBox.height)) : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(2);
  }
}

async function scrollTurnIntoView(page: Page, turnId: string) {
  const locator = page.locator(`[data-turn-id="${turnId}"]`).first();
  if (await locator.count() === 0) {
    const previous = page.getByRole('button', { name: 'Previous turn' });
    for (let attempt = 0; attempt < 24 && await locator.count() === 0; attempt += 1) {
      await previous.click();
    }
    await expect(locator).toBeAttached();
  }
  await locator.evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await page.getByTestId('agent-transcript-scroll').evaluate((node) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
    node.dispatchEvent(new Event('scroll'));
    node.dispatchEvent(new Event('scrollend'));
  });
  await expect(locator).toBeVisible();
}

async function turnViewportOffset(page: Page, turnId: string) {
  const viewport = page.getByTestId('agent-transcript-scroll');
  const turn = page.locator(`[data-turn-id="${turnId}"]`).first();
  return turn.evaluate((node, viewportNode) =>
    Math.round(node.getBoundingClientRect().top - (viewportNode as HTMLElement).getBoundingClientRect().top),
  await viewport.elementHandle());
}

async function expectMessageAnchor(page: Page, turnId: string) {
  const viewport = page.getByTestId('agent-transcript-scroll');
  const body = page.getByTestId('agent-transcript-body');
  const content = page.getByTestId('agent-transcript-content');
  const row = page.locator(`article[data-turn-id="${turnId}"] .codex-transcript-row-userMessage`);
  await expect.poll(async () => viewport.evaluate((viewportNode) => {
    const viewportTop = viewportNode.getBoundingClientRect().top;
    const nearest = [...viewportNode.querySelectorAll<HTMLElement>('.codex-transcript-row-userMessage')]
      .map((candidate) => ({
        distance: Math.abs(candidate.getBoundingClientRect().top - viewportTop - 24),
        turnId: candidate.dataset.turnId,
      }))
      .sort((left, right) => left.distance - right.distance)[0];
    return nearest?.turnId ?? null;
  })).toBe(turnId);
  await expect.poll(async () => {
    const [actualOffset, rowTop, paddingTop] = await Promise.all([
      row.evaluate((node, viewportNode) =>
        node.getBoundingClientRect().top - (viewportNode as HTMLElement).getBoundingClientRect().top,
      await viewport.elementHandle()),
      row.evaluate((node, bodyNode) =>
        node.getBoundingClientRect().top - (bodyNode as HTMLElement).getBoundingClientRect().top,
      await body.elementHandle()),
      content.evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingTop)),
    ]);
    const navigationOffset = Math.max(24, paddingTop);
    const expectedOffset = Math.min(paddingTop + rowTop, navigationOffset);
    return Math.abs(actualOffset - expectedOffset);
  }).toBeLessThanOrEqual(2);
}
