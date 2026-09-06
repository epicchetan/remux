import { expect, test } from '@playwright/test';
import { FIXTURE_CONVERSATION_ID, installAgentHost } from './viewer-fixture';

for (const outcome of ['completed', 'failed'] as const) {
  test(`manual compaction appears before completion, survives reload, and settles ${outcome} in place`, async ({ page }) => {
    await installAgentHost(page);
    await page.goto(`/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}&fixtureHoldManualCompaction=1`);
    const divider = page.locator('.agent-work-compaction-divider-transcript');
    const row = page.locator('[data-row-kind="compaction"]');
    await expect(page.getByTestId('agent-transcript-scroll').getByText('Recovered from authoritative resources.')).toBeVisible();
    await expect(divider).toHaveCount(0);
    const turnCount = await page.locator('article[data-turn-id]').count();
    await page.getByRole('button', { name: 'Show usage details' }).click();
    await page.getByRole('region', { name: 'Usage details' }).getByRole('button', { name: 'Compact', exact: true }).click();
    await expect(divider).toHaveCount(1);
    await expect(divider).toHaveAttribute('data-state', 'compacting');
    await expect(page.getByRole('button', { name: 'Compacting…', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    const rowId = await row.getAttribute('data-transcript-row-id');
    const height = await row.evaluate((node) => node.getBoundingClientRect().height);
    expect(rowId).toBeTruthy();
    await expect(page.locator('article[data-turn-id]')).toHaveCount(turnCount);

    await page.reload();
    await expect(divider).toHaveCount(1);
    await expect(divider).toHaveAttribute('data-state', 'compacting');
    await expect(row).toHaveAttribute('data-transcript-row-id', rowId!);
    await page.evaluate((outcome) => (window as any).__agentFixture.finishManualCompaction(outcome), outcome);
    await expect(divider).toHaveCount(1);
    await expect(divider).toHaveAttribute('data-state', outcome === 'completed' ? 'compacted' : 'failed');
    await expect(row).toHaveAttribute('data-transcript-row-id', rowId!);
    expect(await row.evaluate((node) => node.getBoundingClientRect().height)).toBe(height);
    await expect(page.locator('article[data-turn-id]')).toHaveCount(turnCount);
    // A repeated resource invalidation must update the existing operation.
    await page.evaluate((outcome) => (window as any).__agentFixture.finishManualCompaction(outcome), outcome);
    await expect(divider).toHaveCount(1);
    await page.getByRole('button', { name: 'Show usage details' }).click();
    await expect(page.getByRole('region', { name: 'Usage details' }).getByRole('button', { name: 'Compact', exact: true })).toBeEnabled();
  });
}
