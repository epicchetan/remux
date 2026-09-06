import { expect, test, type CDPSession, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { FIXTURE_CONVERSATION_ID, installAgentHost } from './viewer-fixture';

const viewerUrl = `/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}`;
const gestureDiagram = `${Array.from({ length: 36 }, (_, index) => `Gesture setup paragraph ${index + 1}.`).join('\n\n')}

\`\`\`mermaid
graph LR
  One --> Two --> Three --> Four
\`\`\`

${Array.from({ length: 24 }, (_, index) => `Gesture trailing paragraph ${index + 1}.`).join('\n\n')}`;

test.beforeEach(async ({ page }) => {
  await installAgentHost(page);
  await page.goto(viewerUrl);
  await page.evaluate((text) => (window as any).__agentFixture.appendCompletedTurn('Diagram gestures', text), gestureDiagram);
  await expect(page.locator('.agent-diagram').last()).toHaveAttribute('data-diagram-state', 'ready');
});

test('supports keyboard zoom and reset without changing transcript geometry', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop keyboard contract');
  const diagram = page.locator('.agent-diagram').last();
  const viewport = diagram.getByLabel('Diagram viewport');
  const cardHeight = await diagram.evaluate((node) => node.getBoundingClientRect().height);
  const transcript = page.getByTestId('agent-transcript-scroll');

  await viewport.focus();
  const scrollTop = await transcript.evaluate((node) => node.scrollTop);
  await page.keyboard.press('+');
  await expect.poll(() => zoom(viewport)).toBeGreaterThan(1);
  await expect(diagram.getByRole('button', { name: 'Reset view' })).toBeVisible();
  await expectHeight(diagram, cardHeight);
  expect(await transcript.evaluate((node) => node.scrollTop)).toBe(scrollTop);
  await page.keyboard.press('0');
  await expect.poll(() => zoom(viewport)).toBe(1);
  await expect(diagram.getByRole('button', { name: 'Reset view' })).toHaveCount(0);
  await page.keyboard.press('+');
  await diagram.getByRole('button', { name: 'Reset view' }).click();
  await expect.poll(() => zoom(viewport)).toBe(1);
  await expect(diagram.getByRole('button', { name: 'Expand diagram' })).toHaveCount(0);
});

test('coordinates scroll handoff, pinch zoom, bounded drag, cancellation, and outside input', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile touch contract');
  const diagram = page.locator('.agent-diagram').last();
  const viewport = diagram.getByLabel('Diagram viewport');
  const transcript = page.getByTestId('agent-transcript-scroll');
  const cardHeight = await diagram.evaluate((node) => node.getBoundingClientRect().height);
  await viewport.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await transcript.evaluate(async (node) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
    node.dispatchEvent(new Event('scroll'));
    node.dispatchEvent(new Event('scrollend'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  let box = await viewport.boundingBox();
  if (!box) throw new Error('Diagram viewport has no bounds');
  const cdp = await page.context().newCDPSession(page);
  let center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(await page.evaluate(({ x, y }) => {
    const viewport = document.querySelector('[aria-label="Diagram viewport"]');
    const target = document.elementFromPoint(x, y);
    return Boolean(viewport && target && viewport.contains(target));
  }, center)).toBe(true);

  const beforeNative = await transcript.evaluate((node) => node.scrollTop);
  await page.evaluate(() => {
    (window as any).__diagramTouchEvents = [];
    for (const type of ['touchstart', 'touchmove', 'touchend']) {
      document.addEventListener(type, (event) => (window as any).__diagramTouchEvents.push(event), { capture: true });
    }
  });
  await touch(cdp, 'touchStart', [{ id: 1, x: center.x, y: center.y }]);
  await touch(cdp, 'touchMove', [{ id: 1, x: center.x, y: center.y - 40 }]);
  await touch(cdp, 'touchMove', [{ id: 1, x: center.x, y: center.y - 100 }]);
  await touch(cdp, 'touchEnd', []);
  const nativeEvents = await page.evaluate(() => ((window as any).__diagramTouchEvents as TouchEvent[]).map((event) => ({
    defaultPrevented: event.defaultPrevented,
    target: (event.target as Element | null)?.className ?? null,
    type: event.type,
  })));
  expect(nativeEvents.some((event) => event.type === 'touchmove')).toBe(true);
  expect(nativeEvents.every((event) => !event.defaultPrevented)).toBe(true);
  expect(nativeEvents.every((event) => String(event.target).includes('agent-diagram-viewport'))).toBe(true);
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).not.toBe(beforeNative);
  await expect.poll(() => zoom(viewport)).toBe(1);
  await page.waitForTimeout(150);

  box = await viewport.boundingBox();
  if (!box) throw new Error('Diagram viewport moved outside the virtual window');
  center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await mkdir('/tmp/remux-html-preview', { recursive: true });
  await page.screenshot({ path: '/tmp/remux-html-preview/agent-mermaid-compact.png' });

  const beforePinchScroll = await transcript.evaluate((node) => node.scrollTop);
  await touch(cdp, 'touchStart', [
    { id: 2, x: center.x - 35, y: center.y }, { id: 3, x: center.x + 35, y: center.y },
  ]);
  await touch(cdp, 'touchMove', [
    { id: 2, x: center.x - 90, y: center.y }, { id: 3, x: center.x + 90, y: center.y },
  ]);
  await touch(cdp, 'touchEnd', []);
  await expect.poll(() => zoom(viewport)).toBeGreaterThan(1);
  await page.screenshot({ path: '/tmp/remux-html-preview/agent-mermaid-zoom.png' });
  await expectHeight(diagram, cardHeight);
  expect(Math.abs(await transcript.evaluate((node) => node.scrollTop) - beforePinchScroll)).toBeLessThanOrEqual(2);

  const imageBefore = await viewport.getByRole('img', { name: 'Mermaid diagram' }).getAttribute('style');
  await touch(cdp, 'touchStart', [{ id: 4, x: center.x, y: center.y }]);
  await touch(cdp, 'touchMove', [{ id: 4, x: center.x + 500, y: center.y + 300 }]);
  await touch(cdp, 'touchEnd', []);
  await expect(viewport.getByRole('img', { name: 'Mermaid diagram' })).not.toHaveAttribute('style', imageBefore ?? '');
  const bounded = await viewport.evaluate((node) => {
    const outer = node.getBoundingClientRect();
    const image = node.querySelector('img')!.getBoundingClientRect();
    return image.right >= outer.right - 1 && image.left <= outer.left + 1
      && image.bottom >= outer.bottom - 1 && image.top <= outer.top + 1;
  });
  expect(bounded).toBe(true);

  await diagram.getByRole('button', { name: 'Reset view' }).click();
  await touch(cdp, 'touchStart', [{ id: 5, x: center.x, y: center.y }]);
  await touch(cdp, 'touchMove', [{ id: 5, x: center.x, y: center.y + 30 }]);
  await touch(cdp, 'touchStart', [
    { id: 5, x: center.x, y: center.y + 30 }, { id: 6, x: center.x + 40, y: center.y + 30 },
  ]);
  await touch(cdp, 'touchMove', [
    { id: 5, x: center.x - 50, y: center.y + 30 }, { id: 6, x: center.x + 90, y: center.y + 30 },
  ]);
  await touch(cdp, 'touchEnd', []);
  await expect.poll(() => zoom(viewport)).toBe(1);

  await touch(cdp, 'touchStart', [
    { id: 7, x: center.x - 30, y: center.y }, { id: 8, x: center.x + 30, y: center.y },
  ]);
  await touch(cdp, 'touchMove', [
    { id: 7, x: center.x - 80, y: center.y }, { id: 8, x: center.x + 80, y: center.y },
  ]);
  const heldRevision = await page.evaluate(async () => {
    const modulePath = '/src/transcript/components/markdown/diagramMetrics.ts';
    const metrics = await import(modulePath);
    const before = metrics.getDiagramMetricsRevision();
    metrics.publishDiagramMetrics('gesture-cleanup-probe', { height: 90, width: 180 });
    return { after: metrics.getDiagramMetricsRevision(), before };
  });
  expect(heldRevision.after).toBe(heldRevision.before);
  await diagram.getByRole('button', { name: 'Show diagram source' }).evaluate((button) => (button as HTMLButtonElement).click());
  await expect(diagram.getByText('One --> Two --> Three --> Four', { exact: false })).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => {
    const modulePath = '/src/transcript/components/markdown/diagramMetrics.ts';
    return (await import(modulePath)).getDiagramMetricsRevision();
  })).toBeGreaterThan(heldRevision.before);
  await touch(cdp, 'touchCancel', []);
  await diagram.getByRole('button', { name: 'Show diagram' }).click();
  await expect(viewport).toBeVisible();
  const beforeOutside = await transcript.evaluate((node) => node.scrollTop);
  await page.mouse.move(10, 120);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).not.toBe(beforeOutside);
  await expectHeight(diagram, cardHeight);
  await expect(diagram.getByRole('button', { name: 'Expand diagram' })).toHaveCount(0);
});

function zoom(viewport: Locator) {
  return viewport.evaluate((node) => Number((node as HTMLElement).dataset.diagramZoom));
}

async function expectHeight(locator: Locator, expected: number) {
  await expect.poll(() => locator.evaluate((node, height) => Math.abs(node.getBoundingClientRect().height - height), expected))
    .toBeLessThanOrEqual(1);
}

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
  points: Array<{ id: number; x: number; y: number }>) {
  await cdp.send('Input.dispatchTouchEvent', {
    touchPoints: points.map((point) => ({ id: point.id, x: point.x, y: point.y })),
    type,
  });
}
