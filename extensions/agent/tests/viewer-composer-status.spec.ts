import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_CONVERSATION_ID, installAgentHost } from './viewer-fixture';

test.beforeEach(async ({ page }) => {
  await installAgentHost(page);
  await page.goto(`/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}`);
  await expect(page.getByTestId('agent-transcript-body').getByText('Recovered from authoritative resources.')).toBeVisible();
  await expect(page.locator('.remux-composer-inline-status')).toContainText('GPT-5.6 Sol');
});

test('keeps composer, actions, and transcript geometry fixed through history and submission phases', async ({ page }) => {
  const footer = page.locator('.remux-composer-inline-status');
  const baseline = await geometry(page);
  for (const state of ['indexed', 'loading', 'ready']) {
    await page.evaluate((state) => (window as any).__agentFixture.setHistoryState(state), state);
    await expect(footer).toContainText(state === 'ready' ? 'GPT-5.6 Sol' : 'Syncing history');
    await expectGeometry(page, baseline);
  }
  for (const phase of ['starting-conversation', 'sending', 'updating-transcript', 'waiting-for-connection']) {
    await page.evaluate(async (phase) => {
      const path = '/src/composer/store.ts';
      const { useComposerStore } = await import(path);
      useComposerStore.getState().beginSubmission({ kind: 'send', phase });
    }, phase);
    await expect(footer).not.toContainText('GPT-5.6 Sol');
    await expect(footer).toContainText('36% context');
    await expectGeometry(page, baseline);
  }
  await page.evaluate(async () => {
    const path = '/src/composer/store.ts';
    const { useComposerStore } = await import(path);
    useComposerStore.getState().clearSubmission();
  });
  await expect(footer).toContainText('GPT-5.6 Sol');
  await expectGeometry(page, baseline);
  expect(await page.locator('button button').count()).toBe(0);
});

test('keeps long errors bounded and readable without moving the composer', async ({ page }, testInfo) => {
  const baseline = await geometry(page);
  const message = 'Fixture submission failed. '.repeat(24) + 'Specific final diagnostic.';
  await page.evaluate(async (message) => {
    const path = '/src/composer/store.ts';
    const { useComposerStore } = await import(path);
    useComposerStore.setState({ submission: null, submissionError: message, isSubmitting: false });
  }, message);
  const footer = page.locator('.remux-composer-inline-status');
  await expect(page.getByRole('alert')).toContainText(message);
  // Background history activity must not mute the selected submission error.
  await page.evaluate(() => (window as any).__agentFixture.setHistoryState('loading'));
  await expect(page.getByRole('alert')).toContainText(message);
  await expectGeometry(page, baseline);
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Specific final diagnostic.');
  await page.screenshot({ path: testInfo.outputPath('error-details.png') });
  await expectGeometry(page, baseline);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Details', exact: true })).toBeFocused();
  await expectGeometry(page, baseline);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('retries failed history in place and keeps usage available during syncing', async ({ page }, testInfo) => {
  const baseline = await geometry(page);
  const footer = page.locator('.remux-composer-inline-status');
  await page.evaluate(() => (window as any).__agentFixture.setHistoryState('failed'));
  await expect(page.getByRole('alert')).toContainText('Fixture history read failed.');
  await expectGeometry(page, baseline);
  await footer.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(footer).toContainText('GPT-5.6 Sol');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectGeometry(page, baseline);

  await page.evaluate(() => (window as any).__agentFixture.setHistoryState('loading'));
  await expect(footer).toContainText('Syncing history');
  await page.screenshot({ path: testInfo.outputPath('syncing-footer.png') });
  await footer.getByRole('button', { name: 'Show usage details' }).click();
  await expect(page.getByRole('region', { name: 'Usage details' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expectGeometry(page, baseline);
});

async function geometry(page: Page) {
  return page.evaluate(() => {
    const selectors = ['[data-remux-composer-root]', '.remux-composer-actions', '[role="textbox"][contenteditable]', '[data-testid="agent-transcript-scroll"]', '.remux-composer-inline-status'];
    return selectors.flatMap((selector) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return [rect.y, rect.height];
    });
  });
}

async function expectGeometry(page: Page, baseline: number[]) {
  await expect.poll(async () => {
    const current = await geometry(page);
    return Math.max(...current.map((value, index) => Math.abs(value - baseline[index]!)));
  }).toBeLessThanOrEqual(1);
}
