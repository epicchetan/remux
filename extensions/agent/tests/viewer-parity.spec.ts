import { expect, test, type Page } from '@playwright/test';

import { FIXTURE_CONVERSATION_ID, installAgentHost } from './viewer-fixture';

test.beforeEach(async ({ page }) => {
  await installAgentHost(page);
});

test('contains rich Markdown while preserving its presentation primitives', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureMarkdown=1'));

  await expect(page.getByRole('heading', { name: 'Rendered answer' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.locator('.codex-md-code-block')).toBeVisible();
  await expect(page.locator('.codex-md-file-link')).toHaveAttribute('title', 'src/index.ts:12');

  const containment = await page.getByTestId('agent-transcript-scroll').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(containment.scrollWidth).toBeLessThanOrEqual(containment.clientWidth + 1);
});

test('keeps long user and assistant content inside the mobile transcript rail', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'This regression targets the phone-width transcript rail.');
  await page.goto(conversationUrl('&fixtureOverflow=1'));

  await expect(page.getByText('Automated recovery retry:', { exact: false })).toBeVisible();
  await expect(page.getByText('What an extension is', { exact: true })).toBeVisible();

  const containment = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]');
    const content = document.querySelector<HTMLElement>('[data-testid="agent-transcript-content"]');
    if (!scroller || !content) throw new Error('Transcript containment elements are missing.');
    const contentRect = content.getBoundingClientRect();
    const candidates = Array.from(document.querySelectorAll<HTMLElement>([
      '.codex-user-bubble', '.codex-markdown', '.codex-md-block-frame', '.codex-md-text-line',
    ].join(',')));
    return {
      contentWidth: contentRect.width,
      layoutWidth: Number(content.dataset.layoutWidth),
      offenders: candidates.flatMap((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < contentRect.left - 1 || rect.right > contentRect.right + 1 ||
          element.scrollWidth > element.clientWidth + 1
          ? [{ className: element.className, left: rect.left, right: rect.right }]
          : [];
      }),
      scrollerWidth: scroller.clientWidth,
      scrollerScrollWidth: scroller.scrollWidth,
    };
  });

  expect(containment.contentWidth).toBeGreaterThan(0);
  expect(containment.layoutWidth).toBeGreaterThanOrEqual(containment.contentWidth - 1);
  expect(containment.offenders).toEqual([]);
  expect(containment.scrollerScrollWidth).toBeLessThanOrEqual(containment.scrollerWidth + 1);
});

test('loads oversized exact content only after an explicit viewer action', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureExact=1'));

  await expect(page.getByText('Exact preview.', { exact: true })).toBeVisible();
  expect(await artifactRequestCount(page)).toBe(0);
  await page.getByRole('button', { name: /Open exact response/u }).click();
  await expect(page.getByRole('dialog', { name: 'Exact response' })).toBeVisible();
  expect(await artifactRequestCount(page)).toBe(0);
  await page.getByRole('button', { name: 'Load next chunk' }).click();
  await expect(page.getByRole('dialog', { name: 'Exact response' })).toContainText(
    'Exact preview. The remaining',
  );
  await expect.poll(() => artifactRequestCount(page)).toBe(1);
});

test('renders conversation compaction boundaries as virtualized transcript rows', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureCompaction=1'));
  const dividers = page.locator('.agent-work-compaction-divider-transcript');
  await expect(dividers).toHaveCount(2);
  await expect(dividers.nth(0)).toContainText('Compacted');
  await expect(dividers.nth(0)).toHaveAttribute('data-state', 'compacted');
  await expect(dividers.nth(1)).toContainText('Compacting');
  await expect(dividers.nth(1)).toHaveAttribute('data-state', 'compacting');
  await expect.poll(() => page.locator('[data-row-kind]').evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-row-kind')))).toEqual([
    'compaction', 'userMessage', 'assistantMessage', 'compaction',
  ]);
});

test('loads normalized native activity and operation details only after disclosure', async ({ page }) => {
  await page.goto('/viewers/agent/?fixtureDiff=1');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Inspect native work details');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();

  const workHeader = page.locator('.codex-work-header');
  await expect(workHeader).toHaveAttribute('aria-expanded', 'false');
  const readsBeforeOpen = await nativeTurnReadCount(page);
  expect(readsBeforeOpen).toBeGreaterThan(0);
  await workHeader.click();
  const reasoning = page.locator('.agent-reasoning-block');
  await expect(reasoning).toContainText('Checking context.');
  await expect(reasoning).toContainText('Reviewing workspace state.');
  await expect(reasoning.locator('.agent-reasoning-part')).toHaveCount(2);
  const reasoningLines = reasoning.locator('.codex-md-text-line');
  await expect(reasoningLines).toHaveCount(2);
  const reasoningLineTops = await reasoningLines.evaluateAll((lines) =>
    lines.map((line) => line.getBoundingClientRect().top));
  expect(reasoningLineTops[1] - reasoningLineTops[0]).toBeGreaterThanOrEqual(17);
  await expect(reasoning.locator('.agent-reasoning-parts')).toHaveCSS('gap', '4px');
  await expect(page.locator('.agent-commentary-block')).toContainText(
    'Grounding the change in the current workspace.',
  );
  const actionRuns = page.locator('.agent-action-run > button');
  await expect(actionRuns).toHaveCount(1);
  const toolActions = actionRuns.first();
  await expect(toolActions).toContainText('Read 1 file');
  await expect(toolActions).toContainText('edited index.ts');
  await toolActions.click();
  const readRow = page.locator('.agent-tool-call').filter({ hasText: 'workspace.read' });
  const diffRow = page.locator('.agent-tool-call[data-has-diff="true"]');
  await expect(readRow).toBeVisible();
  await expect(diffRow).toBeVisible();
  await expect(diffRow).toContainText('Edited index.ts');
  await expect(diffRow).toContainText('file_change');
  await expect(page.getByText('native subagent', { exact: false })).toBeVisible();

  const workAlignment = await page.evaluate(() => {
    const left = (selector: string) =>
      document.querySelector(selector)?.getBoundingClientRect().left ?? Number.NaN;
    const right = (selector: string) =>
      document.querySelector(selector)?.getBoundingClientRect().right ?? Number.NaN;
    return {
      proseLeft: left('.agent-reasoning-block'),
      summaryIconLeft: left('.agent-action-run-header .agent-live-activity-icon svg'),
      detailIconLefts: Array.from(document.querySelectorAll('.codex-work-row-icon svg'))
        .map((icon) => icon.getBoundingClientRect().left),
      workChevronRight: right('.codex-work-header-chevron svg'),
      summaryChevronRight: right('.agent-action-run-header > svg:last-child'),
      detailChevronRights: Array.from(document.querySelectorAll('.agent-tool-call-header > svg:last-child'))
        .map((icon) => icon.getBoundingClientRect().right),
    };
  });
  expect(workAlignment.summaryIconLeft).toBeCloseTo(workAlignment.proseLeft, 5);
  for (const iconLeft of workAlignment.detailIconLefts) {
    expect(iconLeft).toBeCloseTo(workAlignment.proseLeft, 5);
  }
  expect(workAlignment.summaryChevronRight).toBeCloseTo(workAlignment.workChevronRight, 5);
  for (const chevronRight of workAlignment.detailChevronRights) {
    expect(chevronRight).toBeCloseTo(workAlignment.workChevronRight, 5);
  }

  const readsBeforeDetail = await nativeTurnReadCount(page);
  await readRow.locator('> button').click();
  await expect(readRow).toContainText('Fixture file output.');
  await expect.poll(() => nativeTurnReadCount(page)).toBeGreaterThan(readsBeforeDetail);
  const artifactReadsBeforeDiff = await artifactRequestCount(page);
  await diffRow.locator('> button').click();
  const expandedChevron = diffRow.locator('> button > svg:last-child');
  await expect(expandedChevron).toHaveClass(/lucide-chevron-down/u);
  expect(await expandedChevron.evaluate((icon) => getComputedStyle(icon).transform)).toBe('none');
  await expect(diffRow.locator('.codex-diff-block')).toBeVisible();
  await expect(diffRow.locator('.codex-diff-line-added')).toContainText('export const value = 1;');
  await expect.poll(() => artifactRequestCount(page)).toBeGreaterThan(artifactReadsBeforeDiff);

  const containment = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]');
    const content = document.querySelector<HTMLElement>('[data-testid="agent-transcript-content"]');
    if (!scroller || !content) throw new Error('Transcript containment elements are missing.');
    const rail = content.getBoundingClientRect();
    const offenders = Array.from(document.querySelectorAll<HTMLElement>([
      '.agent-execution-scope', '.agent-action-run', '.agent-tool-call', '.agent-reasoning-block',
    ].join(','))).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < rail.left - 1 || rect.right > rail.right + 1 ||
        element.scrollWidth > element.clientWidth + 1;
    }).map((element) => element.className);
    return { offenders, clientWidth: scroller.clientWidth, scrollWidth: scroller.scrollWidth };
  });
  expect(containment.offenders).toEqual([]);
  expect(containment.scrollWidth).toBeLessThanOrEqual(containment.clientWidth + 1);

  await workHeader.click();
  await expect(workHeader).toHaveAttribute('aria-expanded', 'false');
});

test('refreshes an open normalized activity frame without flattening its new inference', async ({ page }) => {
  await page.goto('/viewers/agent/');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Create refreshable work');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
  await page.locator('.codex-work-header').click();
  await expect(page.locator('.agent-inference')).toHaveCount(1);
  const readsBefore = await nativeTurnReadCount(page);
  await page.evaluate(() => (window as any).__agentFixture.reviseLatestExecutionScope());
  await expect(page.getByText('Validated the refreshed execution-scope revision.', { exact: false }))
    .toBeVisible();
  await expect(page.locator('.agent-inference')).toHaveCount(2);
  await expect.poll(() => nativeTurnReadCount(page)).toBeGreaterThan(readsBefore);
});

test('pages only after a user scroll and preserves the mounted row anchor', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureLong=1'));
  await expect(page.getByText('Historical answer 72.')).toBeVisible();

  const mountedBefore = await page.locator('.codex-transcript-turn').count();
  expect(mountedBefore).toBeGreaterThan(0);
  expect(mountedBefore).toBeLessThan(24);
  await expect.poll(() => transcriptSyncCount(page)).toBe(1);

  const viewport = page.getByTestId('agent-transcript-scroll');
  await viewport.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event('scrollend'));
  });
  await page.waitForTimeout(250);
  expect(await transcriptSyncCount(page)).toBe(1);

  const anchor = page.locator('[data-transcript-row-id^="turn-49:"]').first();
  await expect(anchor).toBeVisible();
  const beforeTop = await anchor.evaluate((node) => node.getBoundingClientRect().top);
  await viewport.evaluate((node) => {
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -12 }));
    node.dispatchEvent(new Event('scrollend'));
  });
  await expect.poll(() => transcriptSyncCount(page)).toBe(2);
  expect(await latestTranscriptWindowKey(page)).toContain(':around:turn-49:16:');
  const afterTop = await anchor.evaluate((node) => node.getBoundingClientRect().top);
  expect(Math.abs(afterTop - beforeTop)).toBeLessThanOrEqual(1);
  expect(await page.locator('.codex-transcript-turn').count()).toBeLessThanOrEqual(32);
});

test('keeps a sent message visible while work and assistant output settle', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureLong=1'));
  await expect(page.getByText('Historical answer 72.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Message' }).fill('Anchor this user request');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  const transcript = page.getByTestId('agent-transcript-scroll');
  await expect(transcript.getByText('Anchor this user request')).toBeVisible();
  await expect(page.getByText('The fixture stream completed.')).toBeVisible();
  await expect(transcript.getByText('Anchor this user request')).toBeVisible();
});

test('pins streamed work before paint and holds the user message through content collapse', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureLong=1'));
  await expect(page.getByText('Historical answer 72.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Message' }).fill('interrupt anchor frame probe');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  const sentRow = page.locator('[data-row-kind="userMessage"]')
    .filter({ hasText: 'interrupt anchor frame probe' });
  await expect(sentRow).toBeVisible();
  await expect(page.locator('.codex-work-content').last()).toBeVisible();

  const samples = await page.evaluate(async () => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
    const content = document.querySelector<HTMLElement>('[data-testid="agent-transcript-content"]')!;
    const work = document.querySelector<HTMLElement>('.codex-work-content')!;
    const row = Array.from(document.querySelectorAll<HTMLElement>('[data-row-kind="userMessage"]'))
      .find((candidate) => candidate.textContent?.includes('interrupt anchor frame probe'))!;
    const anchorTop = Math.max(24, Number.parseFloat(getComputedStyle(content).paddingTop));
    const sample = () => row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    const afterFrames = async (count: number) => {
      const values: number[] = [];
      for (let frame = 0; frame < count; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        values.push(sample());
      }
      return values;
    };

    const filler = document.createElement('div');
    filler.dataset.anchorProbe = 'true';
    filler.style.height = '700px';
    work.appendChild(filler);
    const growth = await afterFrames(4);
    filler.style.height = '0px';
    // Force layout before ResizeObserver or requestAnimationFrame can repair
    // the position. This is the browser-clamp seam that a native compositor
    // can expose even when every post-frame sample looks correct.
    const collapseImmediate = sample();
    const collapse = await afterFrames(4);
    return { anchorTop, collapse, collapseImmediate, growth };
  });

  expect(Math.abs(samples.growth.at(-1)! - samples.anchorTop)).toBeLessThanOrEqual(2);
  expect(Math.abs(samples.collapseImmediate - samples.anchorTop)).toBeLessThanOrEqual(2);
  for (const offset of samples.collapse) {
    expect(Math.abs(offset - samples.anchorTop)).toBeLessThanOrEqual(2);
  }
  await expect(page.getByTestId('agent-transcript-anchor-runway')).not.toHaveCSS('height', '0px');
});

test('keeps the sent message pinned while the first assistant chunk auto-closes work', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureLong=1'));
  await expect(page.getByText('Historical answer 72.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Message' }).fill('interrupt work collapse probe');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  const sentRow = page.locator('[data-row-kind="userMessage"]')
    .filter({ hasText: 'interrupt work collapse probe' });
  await expect(sentRow).toBeVisible();
  await expect(page.locator('.codex-work-content').last()).toBeVisible();

  const samples = await page.evaluate(async () => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
    const content = document.querySelector<HTMLElement>('[data-testid="agent-transcript-content"]')!;
    const work = Array.from(document.querySelectorAll<HTMLElement>('.codex-work-content')).at(-1)!;
    const row = Array.from(document.querySelectorAll<HTMLElement>('[data-row-kind="userMessage"]'))
      .find((candidate) => candidate.textContent?.includes('interrupt work collapse probe'))!;
    const anchorTop = Math.max(24, Number.parseFloat(getComputedStyle(content).paddingTop));
    const sample = () => row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;

    const filler = document.createElement('div');
    filler.dataset.workCollapseProbe = 'true';
    filler.style.height = '700px';
    work.appendChild(filler);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const before = sample();

    const collapse = new Promise<{ frame: number; immediate: number }>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error('Work did not auto-close after assistant output started.'));
      }, 2_000);
      const observer = new MutationObserver(() => {
        if (work.isConnected) return;
        observer.disconnect();
        window.clearTimeout(timeout);
        const immediate = sample();
        requestAnimationFrame(() => resolve({ frame: sample(), immediate }));
      });
      observer.observe(document.querySelector('[data-testid="agent-transcript-body"]')!, {
        childList: true,
        subtree: true,
      });
      (window as any).__agentFixture.streamLatestAssistantText(
        'The streamed response has started while the turn is still running.',
      );
    });

    return { anchorTop, before, ...(await collapse) };
  });

  expect(Math.abs(samples.before - samples.anchorTop)).toBeLessThanOrEqual(2);
  expect(Math.abs(samples.immediate - samples.anchorTop)).toBeLessThanOrEqual(2);
  expect(Math.abs(samples.frame - samples.anchorTop)).toBeLessThanOrEqual(2);
  await expect(page.getByText('The streamed response has started while the turn is still running.')).toBeVisible();
  await expect(page.locator('.codex-work-content').last()).toBeHidden();
});

test('restores a running user-message anchor before streamed work grows', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureRunning=1'));
  const sentRow = page.locator('[data-row-kind="userMessage"]')
    .filter({ hasText: 'Resume this running turn' });
  await expect(sentRow).toBeVisible();
  await expect(page.locator('.codex-work-content')).toBeVisible();

  const offsets = await page.evaluate(async () => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
    const work = document.querySelector<HTMLElement>('.codex-work-content')!;
    const row = Array.from(document.querySelectorAll<HTMLElement>('[data-row-kind="userMessage"]'))
      .find((candidate) => candidate.textContent?.includes('Resume this running turn'))!;
    const sample = () => row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    const initial = sample();
    const filler = document.createElement('div');
    work.appendChild(filler);
    const growth: number[] = [];
    for (const height of [300, 600, 900, 1_200]) {
      filler.style.height = `${height}px`;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      growth.push(sample());
    }
    return { growth, initial };
  });

  for (const offset of offsets.growth) {
    expect(Math.abs(offset - offsets.initial)).toBeLessThanOrEqual(2);
  }
});

test('keeps an anchored message fixed when an attachment resizes the composer', async ({ page }) => {
  await page.goto(conversationUrl('&fixtureLong=1'));
  await expect(page.getByText('Historical answer 72.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Message' }).fill('interrupt composer resize anchor');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  const sentRow = page.locator('[data-row-kind="userMessage"]')
    .filter({ hasText: 'interrupt composer resize anchor' });
  await expect(sentRow).toBeVisible();
  await expect(page.locator('.codex-work-content').last()).toBeVisible();
  await page.evaluate(async () => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
    const content = document.querySelector<HTMLElement>('[data-testid="agent-transcript-content"]')!;
    const work = Array.from(document.querySelectorAll<HTMLElement>('.codex-work-content')).at(-1)!;
    const row = Array.from(document.querySelectorAll<HTMLElement>('[data-row-kind="userMessage"]'))
      .find((candidate) => candidate.textContent?.includes('interrupt composer resize anchor'))!;
    const anchorTop = Math.max(24, Number.parseFloat(getComputedStyle(content).paddingTop));
    const desiredScrollTop = viewport.scrollTop +
      row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchorTop;
    const naturalMax = viewport.scrollHeight - viewport.clientHeight;
    const filler = document.createElement('div');
    filler.dataset.composerResizeProbe = 'true';
    filler.style.height = `${Math.max(100, Math.ceil(desiredScrollTop - naturalMax + 50))}px`;
    work.appendChild(filler);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const content = page.getByTestId('agent-transcript-content');
  const viewport = page.getByTestId('agent-transcript-scroll');
  const anchoredOffset = () => sentRow.evaluate((row) => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
    return row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  });
  const anchorTop = () => content.evaluate((node) =>
    Math.max(24, Number.parseFloat(getComputedStyle(node).paddingTop)));
  await expect.poll(async () => Math.abs(await anchoredOffset() - await anchorTop())).toBeLessThanOrEqual(2);

  await page.evaluate(async () => {
    const filler = document.querySelector<HTMLElement>('[data-composer-resize-probe="true"]')!;
    filler.style.height = `${Math.max(0, Number.parseFloat(filler.style.height) - 100)}px`;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect.poll(async () => Math.abs(await anchoredOffset() - await anchorTop())).toBeLessThanOrEqual(2);
  await expect(page.getByTestId('agent-transcript-anchor-runway')).not.toHaveCSS('height', '0px');

  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await page.getByText('Photo Library', { exact: true }).click();
  await expect(page.locator('.remux-composer-attachment-card')).toBeVisible();
  await expect.poll(async () => Math.abs(await anchoredOffset() - await anchorTop())).toBeLessThanOrEqual(2);

  const samples = await page.evaluate(async () => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="agent-transcript-scroll"]')!;
    const row = Array.from(document.querySelectorAll<HTMLElement>('[data-row-kind="userMessage"]'))
      .find((candidate) => candidate.textContent?.includes('interrupt composer resize anchor'))!;
    const values: number[] = [];
    document.querySelector<HTMLButtonElement>('[aria-label="Remove picked.png"]')!.click();
    values.push(row.getBoundingClientRect().top - viewport.getBoundingClientRect().top);
    for (let frame = 0; frame < 5; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      values.push(row.getBoundingClientRect().top - viewport.getBoundingClientRect().top);
    }
    return values;
  });

  for (const offset of samples) {
    expect(Math.abs(offset - await anchorTop())).toBeLessThanOrEqual(2);
  }
  await expect(viewport).toBeVisible();
});

function conversationUrl(extra = '') {
  return `/viewers/agent/?remuxResourceKind=agentConversation&remuxResourceId=${FIXTURE_CONVERSATION_ID}${extra}`;
}

async function transcriptKeys(page: Page) {
  return page.evaluate(() => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === 'remux/agent/transcript/resources/read')
    .flatMap((entry: { summary: string }) => JSON.parse(entry.summary)
      .map((request: { key: string }) => request.key)) as string[]);
}

async function nativeTurnReadCount(page: Page) {
  return (await transcriptKeys(page)).filter((key) => key.startsWith('agent/turn:')).length;
}

async function artifactRequestCount(page: Page) {
  return page.evaluate(() => (window as any).__agentFixture.requestLog
    .filter((entry: { method: string }) => entry.method === 'remux/agent/artifact/read').length);
}

async function transcriptSyncCount(page: Page) {
  return (await transcriptKeys(page)).filter((key) => key.startsWith('agent/transcript:')).length;
}

async function latestTranscriptWindowKey(page: Page) {
  return (await transcriptKeys(page)).filter((key) => key.startsWith('agent/transcript:')).at(-1) ?? '';
}
