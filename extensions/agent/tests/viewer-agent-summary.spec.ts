import { expect, test } from '@playwright/test';
import { installAgentHost } from './viewer-fixture';

const summary = [
  'Implemented in [session.rs](/home/ubuntu/ledger/crates/service/src/session.rs:2322).',
  '',
  '## Verification',
  '',
  '- **Passed:** regression coverage.',
  '- Added `session::tests::projection_delivery_survives_broadcast_without_receivers_and_preserves_every_subsequent_notification`.',
  '',
  '| Check | Result |',
  '| --- | --- |',
  '| Tests | Passed |',
  '',
  '```diff',
  '- return;',
  '+ if let Err(error) = send_targeted_notification(&output_tx, client_instance_id, method, params).await {',
  '+     continue;',
  '+ }',
  '```',
  '',
  'Report complete.',
].join('\n');

test('agent completion summary keeps Markdown and wide content inside the detail viewport', async ({ page }) => {
  await installAgentHost(page);
  await page.goto('/viewers/agent/');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Complete the focused child review');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
  await page.evaluate((value) => (window as any).__agentFixture.setLatestChildSummary(value), summary);
  await page.getByRole('button', { name: 'View 1 subagent', exact: true }).click();
  await page.getByRole('button', { name: /Native subagent/u }).click();
  const report = page.locator('.agent-execution-assignment');
  await expect(report).toContainText('Report complete.');
  const overflow = () => page.locator('.agent-execution-detail-scroll').evaluate((node) => node.scrollWidth - node.clientWidth);
  await expect.poll(overflow).toBeLessThanOrEqual(1);
  await expect(report.getByRole('heading', { name: 'Verification' })).toBeVisible();
  await expect(report.getByRole('table')).toBeVisible();
  await expect(report.locator('.codex-md-code-block')).toHaveCount(1);
  await expect(report).not.toContainText('```');
  await expect(report).not.toContainText('| --- |');
  const original = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: original.height });
  await expect.poll(overflow).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 900, height: original.height });
  await expect.poll(overflow).toBeLessThanOrEqual(1);
  await page.setViewportSize(original);
  await page.evaluate((value) => (window as any).__agentFixture.setLatestChildSummary(value),
    `Legacy preview: ${summary.replace(/\s+/gu, ' ')}`);
  await expect(report).toContainText('Legacy preview:');
  await expect.poll(overflow).toBeLessThanOrEqual(1);
});
