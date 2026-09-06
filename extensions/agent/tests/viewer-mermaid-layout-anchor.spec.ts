import { expect, test } from '@playwright/test';
import { FIXTURE_CONVERSATION_ID, installAgentHost } from './viewer-fixture';

test('preserves the visible paragraph inside a message when diagram dimensions arrive', async ({ page }) => {
  await installAgentHost(page);
  await page.goto(`/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}`);
  const paragraphs = (prefix: string) => Array.from({ length: 24 }, (_, index) => `${prefix} paragraph ${index}.`).join('\n\n');
  await page.evaluate(async (text) => {
    const path = '/src/transcript/components/markdown/diagramMetrics.ts';
    const metrics = await import(path);
    (window as any).__releaseDiagramMetrics = metrics.holdDiagramMetricsUpdates();
    (window as any).__agentFixture.appendCompletedTurn('Read after diagram', text);
  }, `${paragraphs('Before')}\n\n\`\`\`mermaid\ngraph LR\nA-->B\n\`\`\`\n\nKeep this paragraph anchored.\n\n${paragraphs('After')}`);
  const diagram = page.locator('.agent-diagram');
  await expect(diagram).toHaveAttribute('data-diagram-state', 'ready');
  await expect.poll(() => diagram.evaluate((node) => node.getBoundingClientRect().height)).toBe(240);
  const transcript = page.getByTestId('agent-transcript-scroll');
  const paragraph = page.getByText('Keep this paragraph anchored.', { exact: true });
  await paragraph.evaluate((node) => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
    viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    viewport.scrollTop += node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 5;
    viewport.dispatchEvent(new Event('scroll'));
    viewport.dispatchEvent(new Event('scrollend'));
  });
  await expect(paragraph).toBeVisible();
  const beforeTop = await paragraph.evaluate((node) => node.getBoundingClientRect().top);
  await page.evaluate(() => (window as any).__releaseDiagramMetrics());
  await expect.poll(() => diagram.evaluate((node) => node.getBoundingClientRect().height)).toBeLessThan(240);
  await expect.poll(async () => Math.abs(await paragraph.evaluate((node) => node.getBoundingClientRect().top) - beforeTop)).toBeLessThanOrEqual(2);
  const row = diagram.locator('xpath=ancestor::*[@data-transcript-row-id][1]');
  expect(await row.evaluate((node) => Math.abs(node.getBoundingClientRect().height - Number((node as HTMLElement).dataset.collapsedHeight)))).toBeLessThanOrEqual(2);
  expect(await transcript.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
});
