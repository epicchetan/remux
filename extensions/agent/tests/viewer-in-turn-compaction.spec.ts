import { expect, test, type Page } from '@playwright/test';

import { FIXTURE_CONVERSATION_ID, installAgentHost } from './viewer-fixture';

const TURN_ID = 'turn-in-turn-compaction';
const NEIGHBOURS = ['turn-3', TURN_ID, 'turn-after-compaction'];

test('in-turn compaction notices keep modeled geometry aligned collapsed and expanded', async ({ page }) => {
  await installAgentHost(page);
  await page.goto(`/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}&fixtureInTurnCompaction=1`);
  const turn = page.locator(`[data-turn-id="${TURN_ID}"]`).first();
  await expect(turn.getByText('Compacted 269k → 8k tokens')).toBeVisible();
  await expect(turn.getByText('Compacted 272k → 12k tokens')).toBeVisible();
  await expect(turn.locator('[data-row-kind="notice"]')).toHaveCount(2);
  await expect(turn.locator('[data-row-kind="workSection"]')).toHaveCount(3);
  await expect(turn.locator('.codex-work-header-title')).toHaveText(['Worked for 1s', 'Worked for 1s', 'Worked for 1s']);
  await expectRowsMatchModel(page, TURN_ID);
  await expectTurnsContiguous(page, NEIGHBOURS);

  for (const header of await turn.locator('.codex-work-header').all()) await header.click();
  await expect(turn.locator('.codex-work-content')).toHaveCount(3);
  await expectRowsMatchModel(page, TURN_ID);
  await expectTurnsContiguous(page, NEIGHBOURS);
});

async function expectRowsMatchModel(page: Page, turnId: string) {
  const turn = page.locator(`[data-turn-id="${turnId}"]`).first();
  await expect.poll(() => turn.evaluate((node) => {
    const article = node as HTMLElement;
    const rows = [...article.querySelectorAll<HTMLElement>('.codex-transcript-row')];
    const rowDrift = rows.map((row) => Math.abs(row.getBoundingClientRect().height -
      (Number(row.dataset.collapsedHeight) + Number(row.dataset.expandedAdditionalHeight))));
    const modeled = Number(article.dataset.collapsedHeight) +
      rows.reduce((sum, row) => sum + Number(row.dataset.expandedAdditionalHeight), 0);
    return Math.max(...rowDrift, Math.abs(article.getBoundingClientRect().height - modeled));
  })).toBeLessThanOrEqual(2);
}

async function expectTurnsContiguous(page: Page, turnIds: string[]) {
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
