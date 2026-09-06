import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { FIXTURE_CONVERSATION_ID, installAgentHost } from './viewer-fixture';

const viewerUrl = `/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}`;
const validDiagram = `\`\`\`mermaid
graph LR
  History[History] --> Replay[Replay]
  Replay --> Chart[Chart]
\`\`\`

Following diagram content.`;

test.beforeEach(async ({ page }) => {
  await installAgentHost(page);
});

test('keeps diagram geometry fixed through loading, ready, source, expansion, and resize', async ({ page }, testInfo) => {
  let releaseMermaid!: () => void;
  const mermaidGate = new Promise<void>((resolve) => { releaseMermaid = resolve; });
  await page.route(/\/node_modules\/\.vite\/deps\/mermaid(?:\.js)?(?:\?.*)?$/u, async (route) => {
    await mermaidGate;
    await route.continue();
  });
  await page.goto(viewerUrl);
  await appendTurn(page, validDiagram);

  const diagram = page.locator('.agent-diagram').last();
  await expect(diagram).toHaveAttribute('data-diagram-state', 'loading');
  const loadingHeight = await diagram.evaluate((node) => node.getBoundingClientRect().height);
  const frame = diagram.locator('xpath=..');
  const loadingFrameHeight = await frame.evaluate((node) => node.getBoundingClientRect().height);
  const following = page.getByText('Following diagram content.', { exact: true });
  const viewport = page.getByTestId('agent-transcript-scroll');
  await viewport.evaluate((node) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 120);
    node.dispatchEvent(new Event('scroll'));
    node.dispatchEvent(new Event('scrollend'));
  });
  const loadingScrollTop = await viewport.evaluate((node) => node.scrollTop);
  const followingGap = await following.evaluate((node, frameNode) =>
    node.getBoundingClientRect().top - (frameNode as HTMLElement).getBoundingClientRect().bottom,
  await frame.elementHandle());

  releaseMermaid();
  await expect(diagram).toHaveAttribute('data-diagram-state', 'ready');
  const image = diagram.getByRole('img', { name: 'Mermaid diagram' });
  await expect(image).toHaveAttribute('src', /^blob:/u);
  await expect.poll(() => image.evaluate((node) => ({
    complete: (node as HTMLImageElement).complete,
    height: (node as HTMLImageElement).naturalHeight,
    width: (node as HTMLImageElement).naturalWidth,
  }))).toMatchObject({ complete: true });
  expect((await image.evaluate((node) => (node as HTMLImageElement).naturalWidth))).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (testInfo.project.name === 'mobile') {
    await mkdir('/tmp/remux-html-preview', { recursive: true });
    await page.screenshot({ path: '/tmp/remux-html-preview/agent-mermaid-inline.png' });
  }
  await expectFixedHeight(diagram, loadingHeight);
  await expectFixedHeight(frame, loadingFrameHeight);
  await expect.poll(async () => Math.abs(await following.evaluate((node, input) =>
    node.getBoundingClientRect().top - (input.frameNode as HTMLElement).getBoundingClientRect().bottom - input.gap,
  { frameNode: await frame.elementHandle(), gap: followingGap })))
    .toBeLessThanOrEqual(2);
  await expect.poll(() => viewport.evaluate((node, expected) => Math.abs(node.scrollTop - expected), loadingScrollTop)).toBeLessThanOrEqual(2);
  await expectRowGeometry(diagram);

  await page.getByRole('button', { name: 'Show diagram source' }).last().click();
  await expect(diagram.getByText('History[History] --> Replay[Replay]', { exact: false })).toBeVisible();
  await expectFixedHeight(diagram, loadingHeight);
  await page.getByRole('button', { name: 'Show diagram' }).last().click();
  await expect(image).toBeVisible();
  await expect.poll(() => viewport.evaluate((node, expected) => Math.abs(node.scrollTop - expected), loadingScrollTop)).toBeLessThanOrEqual(2);

  await page.getByRole('button', { name: 'Expand diagram' }).last().click();
  const expanded = page.locator('.agent-diagram-expanded .agent-diagram-scroll[aria-label="Expanded diagram"]');
  await expect(expanded).toBeVisible();
  await expect(expanded.getByRole('img', { name: 'Mermaid diagram' })).toHaveAttribute('src', /^blob:/u);
  const expandedSheet = page.locator('.agent-diagram-expanded');
  await expect.poll(() => expandedSheet.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return Math.max(
      Math.abs(rect.height - innerHeight * 0.9),
      Math.abs(rect.top - innerHeight * 0.1),
    );
  })).toBeLessThanOrEqual(1);
  if (testInfo.project.name === 'mobile') {
    await page.screenshot({ path: '/tmp/remux-html-preview/agent-mermaid-expanded.png' });
  }
  await page.getByRole('button', { name: 'Close diagram' }).click();
  await expect(expanded).toHaveCount(0);
  await expectFixedHeight(diagram, loadingHeight);
  await expect.poll(() => viewport.evaluate((node, expected) => Math.abs(node.scrollTop - expected), loadingScrollTop)).toBeLessThanOrEqual(2);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => diagram.evaluate((node) => node.getBoundingClientRect().height)).toBe(240);
  await expect.poll(() => diagram.locator('.agent-diagram-scroll').evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expectRowGeometry(diagram);

});

test('shows source within fixed geometry for invalid and oversized diagrams', async ({ page }) => {
  await page.goto(viewerUrl);
  await appendTurn(page, '```mermaid\nthis is not valid mermaid syntax )]\n```');
  let diagram = page.locator('.agent-diagram').last();
  await expect(diagram).toHaveAttribute('data-diagram-state', 'error');
  const invalidHeight = await diagram.evaluate((node) => node.getBoundingClientRect().height);
  await expect(diagram.locator('code')).toContainText('this is not valid mermaid syntax');
  await expectFixedHeight(diagram, invalidHeight);
  await expectRowGeometry(diagram);

  await appendTurn(page, `\`\`\`mermaid\ngraph TD\n${'A'.repeat(20_001)}\n\`\`\``);
  diagram = page.locator('.agent-diagram').last();
  await expect(diagram).toHaveAttribute('data-diagram-state', 'error');
  await expect(diagram.getByText('This diagram is too large to preview.', { exact: false })).toBeVisible();
  await expect(diagram.getByText('A'.repeat(200), { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expectRowGeometry(diagram);
});

test('keeps a partial Mermaid fence as code until the closing fence arrives', async ({ page }) => {
  await page.goto(viewerUrl);
  const partial = '```mermaid\ngraph LR\n  A --> B';
  await appendTurn(page, partial);
  await expect(page.locator('.agent-diagram')).toHaveCount(0);
  await expect(page.locator('.codex-md-code-block').last()).toContainText('A --> B');

  await page.evaluate(({ conversationId, text }) => {
    (window as any).__agentFixture.reviseLatestAssistant(conversationId, text);
  }, { conversationId: FIXTURE_CONVERSATION_ID, text: `${partial}\n\`\`\`` });
  const diagram = page.locator('.agent-diagram').last();
  await expect(diagram).toHaveAttribute('data-diagram-state', 'ready');
  await expect(diagram.getByRole('img', { name: 'Mermaid diagram' })).toHaveAttribute('src', /^blob:/u);
  await expectRowGeometry(diagram);
});

test('restores a middle-turn diagram from the saved render after a real virtual remount', async ({ page }) => {
  await page.goto(`${viewerUrl}&fixtureErrorGeometry=1`);
  await page.evaluate(({ markdown, turnId }) => {
    const fixture = (window as any).__agentFixture;
    const turn = fixture.turns.find((candidate: any) => candidate.id === turnId);
    const assistant = turn?.segments.find((segment: any) => segment.type === 'assistantMessage');
    if (!assistant) throw new Error(`Missing assistant segment for ${turnId}`);
    assistant.text = markdown;
    fixture.setTurnError(turnId, null);
  }, { markdown: validDiagram, turnId: 'turn-27' });

  await scrollTurnIntoView(page, 'turn-27');
  let diagram = page.locator('[data-turn-id="turn-27"] .agent-diagram');
  await expect(diagram).toHaveAttribute('data-diagram-state', 'ready');
  const firstSvg = await diagram.getByRole('img', { name: 'Mermaid diagram' }).evaluate(async (node) =>
    fetch((node as HTMLImageElement).src).then((response) => response.text()));
  await expectRowGeometry(diagram);

  const viewport = page.getByTestId('agent-transcript-scroll');
  await viewport.evaluate((node) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
    node.dispatchEvent(new Event('scrollend'));
  });
  await expect(diagram).toHaveCount(0);

  await scrollTurnIntoView(page, 'turn-27');
  diagram = page.locator('[data-turn-id="turn-27"] .agent-diagram');
  await expect(diagram).toHaveAttribute('data-diagram-state', 'ready');
  const remountedSvg = await diagram.getByRole('img', { name: 'Mermaid diagram' }).evaluate(async (node) =>
    fetch((node as HTMLImageElement).src).then((response) => response.text()));
  expect(remountedSvg).toBe(firstSvg);
  await expectRowGeometry(diagram);
});

async function appendTurn(page: Page, markdown: string) {
  await page.evaluate((text) => (window as any).__agentFixture.appendCompletedTurn('Render diagram', text), markdown);
}

async function expectFixedHeight(diagram: Locator, expected: number) {
  await expect.poll(() => diagram.evaluate((node) => node.getBoundingClientRect().height))
    .toBeCloseTo(expected, 0);
}

async function expectRowGeometry(diagram: Locator) {
  const row = diagram.locator('xpath=ancestor::*[contains(@class,"codex-transcript-row")][1]');
  await expect.poll(async () => row.evaluate((node) =>
    Math.abs(node.getBoundingClientRect().height - Number((node as HTMLElement).dataset.collapsedHeight))))
    .toBeLessThanOrEqual(2);
}

async function scrollTurnIntoView(page: Page, turnId: string) {
  const turn = page.locator(`[data-turn-id="${turnId}"]`).first();
  const previous = page.getByRole('button', { name: 'Previous turn' });
  for (let attempt = 0; attempt < 30 && await turn.count() === 0; attempt += 1) {
    await previous.click();
  }
  await expect(turn).toBeAttached();
  await turn.evaluate((node) => node.scrollIntoView({ block: 'start' }));
  const viewport = page.getByTestId('agent-transcript-scroll');
  await viewport.evaluate(async (node) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    node.dispatchEvent(new Event('scroll'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(turn).toBeVisible();
}
