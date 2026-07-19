import { expect, type Page, test } from '@playwright/test';

type HostRequest = {
  id?: number | string;
  method?: string;
  params?: unknown;
  type?: string;
};

const markdown = [
  '# Narrate viewer',
  '',
  'Misaki aligns **spoken words** with [Markdown](https://example.test) and $x^2$.',
  '',
  '<p data-narration-block-id="forged">Sanitized HTML remains safe.</p>',
  '',
  '```ts',
  'const voice = "af_heart";',
  '```',
].join('\n');

const scrollMarkdown = [
  'First automatic narration paragraph keeps enough prose on screen to exercise stable document following. ',
  'Second automatic narration paragraph keeps enough prose on screen to exercise stable document following. ',
  'Third automatic narration paragraph keeps enough prose on screen to exercise stable document following. ',
  'Fourth automatic narration paragraph keeps enough prose on screen to exercise stable document following. ',
  'Fifth automatic narration paragraph keeps enough prose on screen to exercise stable document following. ',
  'Sixth automatic narration paragraph keeps enough prose on screen to exercise stable document following. ',
].map((sentence) => sentence.repeat(18).trim()).join('\n\n');

const structuralMarkdown = [
  '```ts',
  'const answer = 42;',
  '```',
  '',
  '| Plan | Price |',
  '| --- | ---: |',
  '| Starter | $5 |',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '$$',
  'E = mc^2',
  '$$',
].join('\n');

function silentWav(seconds: number) {
  const sampleRate = 24_000;
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + samples * 2, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

async function installMockHost(
  page: Page,
  options: { content?: string; narrationStatus?: 'preparing' | 'ready' } = {},
) {
  await page.route('**/remux/media/sha256/*', async (route) => {
    const wav = silentWav(5);
    await route.fulfill({
      body: wav,
      contentType: 'audio/wav',
      headers: { 'accept-ranges': 'bytes' },
    });
  });

  await page.addInitScript(({ content, initialNarrationStatus }) => {
    const NativeAudio = window.Audio;
    const audioElements: HTMLAudioElement[] = [];
    const TrackingAudio = function TrackingAudio(source?: string) {
      const audio = new NativeAudio(source);
      audioElements.push(audio);
      return audio;
    };
    TrackingAudio.prototype = NativeAudio.prototype;
    Object.defineProperty(window, 'Audio', {
      configurable: true,
      value: TrackingAudio,
    });
    Object.defineProperty(window, '__narrateSetAudioTime', {
      configurable: true,
      value: (seconds: number) => {
        const audio = audioElements.at(-1);
        if (!audio) return false;
        audio.currentTime = seconds;
        audio.dispatchEvent(new Event('timeupdate'));
        return true;
      },
    });

    const resources = new Map<string, Record<string, unknown>>();
    const manifests = new Map<string, Record<string, unknown>>();
    let narrationStatus = initialNarrationStatus;

    const dispatch = (message: unknown) => {
      const event = new MessageEvent('message', { data: JSON.stringify(message) });
      window.dispatchEvent(event);
      document.dispatchEvent(event);
    };
    const respond = (request: HostRequest, result: unknown) => {
      dispatch({ id: request.id, result, type: 'remux/response' });
    };
    const resultFor = (request: HostRequest) => {
      if (request.method === 'remux/fs/readFile') {
        const requestedPath = (request.params as { path?: string } | undefined)?.path ?? '/tmp/narration.md';
        const requestedContent = requestedPath === '/tmp/narration.md'
          ? content
          : '# Replacement document\n\nThis revision has different narration blocks.';
        return {
          content: requestedContent,
          encoding: 'utf8',
          isBinary: false,
          modifiedAtMs: requestedPath === '/tmp/narration.md' ? 1_782_000_000_000 : 1_782_000_000_001,
          name: requestedPath.split('/').at(-1) ?? 'narration.md',
          path: requestedPath,
          sizeBytes: requestedContent.length,
          tooLarge: false,
        };
      }
      if (request.method === 'remux/narrate/narration/start') {
        const blocks = ((request.params as {
          document?: { blocks?: Array<{ highlightMode: 'block' | 'text'; id: string; text: string }> };
        }).document?.blocks ?? []);
        const artifactKey = `sha256-${'1'.repeat(64)}`;
        const totalSamples = Math.max(24_000, blocks.length * 24_000);
        const sentences = blocks.map((block, index) => ({
          blockId: block.id,
          endSample: (index + 1) * 24_000,
          id: `${block.id}/sentence/0`,
          startSample: index * 24_000,
          textEnd: block.text.length,
          textStart: 0,
        }));
        const wordCues = blocks.flatMap((block, index) => {
          if (block.highlightMode === 'block') return [];
          const match = /[\p{L}\p{N}]+/u.exec(block.text);
          return match ? [{
            blockId: block.id,
            endSample: index * 24_000 + 22_000,
            sentenceId: `${block.id}/sentence/0`,
            startSample: index * 24_000,
            textEnd: match.index + match[0].length,
            textStart: match.index,
          }] : [];
        });
        const manifest = {
          artifactKey,
          audio: {
            channels: 1,
            mimeType: 'audio/wav',
            sampleRate: 24_000,
            sha256: `sha256-${'0'.repeat(64)}`,
            sizeBytes: 44 + totalSamples * 2,
            totalSamples,
            url: `/remux/media/sha256/${'0'.repeat(64)}`,
          },
          blocks: blocks.map((block, index) => ({
            blockId: block.id,
            endSample: (index + 1) * 24_000,
            startSample: index * 24_000,
          })),
          documentHash: `sha256-${'2'.repeat(64)}`,
          offsetEncoding: 'utf16CodeUnit',
          profile: {
            phonemizer: 'misaki-rs-0.3.0-us-no-default-features',
            plannerVersion: 1,
            pronunciationReviewer: {
              directPhoneValidatorVersion: 1,
              effort: 'low',
              kokoroVocabularySha256: `sha256-${'5'.repeat(64)}`,
              model: 'gpt-5.6-sol',
              outputSchemaVersion: 4,
              phoneAlphabetSha256: `sha256-${'6'.repeat(64)}`,
              phoneAlphabetVersion: 1,
              profileDigest: `sha256-${'7'.repeat(64)}`,
              promptVersion: 4,
              serviceTier: 'priority',
              windowPlannerVersion: 3,
            },
            sentenceVersion: 1,
            sourceMapperVersion: 1,
            structuralTranscript: {
              effort: 'low',
              model: 'gpt-5.6-sol',
              outputSchemaVersion: 2,
              profileDigest: `sha256-${'8'.repeat(64)}`,
              promptVersion: 2,
              serviceTier: 'priority',
              windowPlannerVersion: 1,
            },
            synthesizerHash: `sha256-${'9'.repeat(64)}`,
            timingVersion: 2,
            wordSegmenterVersion: 1,
          },
          pronunciationPlanSha256: `sha256-${'3'.repeat(64)}`,
          schemaVersion: 4,
          sentences,
          structuralTranscriptPlanSha256: `sha256-${'4'.repeat(64)}`,
          wordCues,
        };
        const resource = {
          artifactKey,
          complete: narrationStatus === 'ready',
          error: null,
          manifest: narrationStatus === 'ready' ? manifest : null,
          progress: {
            auditWindowsCompleted: narrationStatus === 'ready' ? 1 : 0,
            auditWindowsTotal: 1,
            chunksCompleted: narrationStatus === 'ready' ? blocks.length : 0,
            chunksTotal: blocks.length,
            sentences: blocks.length,
            stage: narrationStatus === 'ready' ? 'ready' : 'languagePlanning',
            transcriptWindowsCompleted: narrationStatus === 'ready' ? 1 : 0,
            transcriptWindowsTotal: 1,
            words: wordCues.length,
          },
          revision: '1',
          status: narrationStatus,
        };
        manifests.set(artifactKey, manifest);
        resources.set(artifactKey, resource);
        return { artifactKey, resource, status: 'accepted' };
      }
      if (request.method === 'remux/narrate/narration/resources/read') {
        const key = (request.params as { artifactKey?: string }).artifactKey ?? '';
        const resource = resources.get(key) ?? null;
        return { resource, status: resource ? 'ok' : 'missing' };
      }
      if (request.method === 'remux/narrate/narration/cancel') {
        const artifactKey = (request.params as { artifactKey?: string }).artifactKey ?? '';
        const resource = resources.get(artifactKey);
        if (resource) {
          resource.complete = false;
          resource.manifest = null;
          resource.revision = String(Number.parseInt(String(resource.revision ?? '1'), 10) + 1);
          resource.status = 'cancelled';
        }
        return {
          artifactKey,
          status: 'accepted',
        };
      }
      return { ok: true };
    };

    Object.defineProperty(window, 'ReactNativeWebView', {
      configurable: true,
      value: {
        postMessage(raw: string) {
          const request = JSON.parse(raw) as HostRequest;
          if (request.type === 'remux/ready') {
            dispatch({
              error: null,
              status: { cwd: '/tmp', type: 'connected', websocketUrl: 'ws://mock' },
              type: 'remux/status',
            });
            dispatch({
              lifecycle: { epoch: 1, reason: 'connect', state: 'active' },
              type: 'remux/lifecycle',
            });
            return;
          }
          if (request.id != null && request.method) {
            respond(request, resultFor(request));
          }
        },
      },
    });
    Object.defineProperty(window, '__narrateSetReady', {
      configurable: true,
      value: () => {
        narrationStatus = 'ready';
        for (const [artifactKey, resource] of resources) {
          resource.complete = true;
          resource.manifest = manifests.get(artifactKey) ?? null;
          resource.revision = String(Number.parseInt(String(resource.revision ?? '1'), 10) + 1);
          resource.status = 'ready';
          const progress = resource.progress as Record<string, unknown>;
          progress.auditWindowsCompleted = 1;
          progress.chunksCompleted = progress.chunksTotal;
          progress.stage = 'ready';
          progress.transcriptWindowsCompleted = 1;
          dispatch({
            message: {
              jsonrpc: '2.0',
              method: 'remux/narrate/narration/updated',
              params: { artifactKey },
            },
            type: 'remux/event',
          });
        }
      },
    });
    Object.defineProperty(window, '__narrateLifecycle', {
      configurable: true,
      value: (state: 'active' | 'background') => {
        dispatch({
          lifecycle: { epoch: state === 'active' ? 3 : 2, reason: 'test', state },
          type: 'remux/lifecycle',
        });
      },
    });
    Object.defineProperty(window, '__narrateNavigate', {
      configurable: true,
      value: (path: string) => dispatch({
        message: {
          jsonrpc: '2.0',
          method: 'host/navigate',
          params: {
            nonce: String(Date.now()),
            resourceId: path,
            resourceKind: 'file',
          },
        },
        type: 'remux/event',
      }),
    });
  }, {
    content: options.content ?? markdown,
    initialNarrationStatus: options.narrationStatus ?? 'ready',
  });
}

test.beforeEach(async ({ page }, testInfo) => {
  page.on('pageerror', (error) => {
    console.error(`Narrate viewer page error: ${error.message}`);
  });
  const autoScrollFixture = /auto-scrolls narration/u.test(testInfo.title);
  const structuralFixture = /rounded structural narration surfaces/u.test(testInfo.title);
  await installMockHost(page, {
    content: autoScrollFixture
      ? scrollMarkdown
      : structuralFixture
        ? structuralMarkdown
        : markdown,
    narrationStatus: /preparation progress|background-completed/u.test(testInfo.title) ? 'preparing' : 'ready',
  });
  await page.goto('/?remuxResourceKind=file&remuxResourceId=%2Ftmp%2Fnarration.md');
  await expect(page.locator('.remux-markdown-document')).toContainText(
    autoScrollFixture
      ? 'First automatic narration'
      : structuralFixture
        ? 'const answer = 42'
        : 'Misaki aligns',
  );
});

test('binds trusted Markdown blocks and groups file actions in the Narrate menu', async ({ page }) => {
  await expect(page.locator('[data-narration-block-id]')).toHaveCount(4);
  await expect(page.locator('[data-narration-block-id="forged"]')).toHaveCount(0);
  await expect(page.locator('[data-narration-text-start]')).not.toHaveCount(0);
  await expect(page.locator('.katex[data-narration-leaf-kind="element"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Open tabs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Narrate markdown' })).toBeEnabled();

  await page.getByRole('button', { name: 'Narrate menu' }).click();
  await expect(page.getByRole('menuitem', { name: 'Reload viewer' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Copy markdown' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Close tab' })).toBeVisible();
});

test('plays, paints, seeks, pauses, and closes through the shared client', async ({ page }) => {
  await page.getByRole('button', { name: 'Narrate markdown' }).click();
  await expect(page.getByRole('button', { name: 'Pause narration' })).toBeVisible();
  await expect(page.locator('.remux-markdown-narration-context-rect').first()).toBeVisible();
  await expect(page.locator('.remux-markdown-narration-word-rect').first()).toBeVisible();
  await expect.poll(async () => page.evaluate(() => (
    (globalThis as typeof globalThis & {
      __remuxNarrationDebugSnapshot?: () => {
        client: { store: { currentSample: number; phase: string } };
      };
    }).__remuxNarrationDebugSnapshot?.().client.store.currentSample ?? 0
  ))).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Pause narration' }).click();
  await expect(page.getByRole('button', { name: 'Play narration' })).toBeVisible();
  const previousBlockId = await page.evaluate(() => (
    (globalThis as typeof globalThis & {
      __remuxNarrationDebugSnapshot?: () => {
        client: { store: { currentBlockId: string | null } };
      };
    }).__remuxNarrationDebugSnapshot?.().client.store.currentBlockId ?? null
  ));
  await page.getByRole('button', { name: 'Next narrated block' }).click();
  await expect.poll(async () => page.evaluate(() => (
    (globalThis as typeof globalThis & {
      __remuxNarrationDebugSnapshot?: () => {
        client: { store: { currentBlockId: string | null } };
      };
    }).__remuxNarrationDebugSnapshot?.().client.store.currentBlockId ?? null
  ))).not.toBe(previousBlockId);
  const nextBlockId = await page.evaluate(() => (
    (globalThis as typeof globalThis & {
      __remuxNarrationDebugSnapshot?: () => {
        client: { store: { currentBlockId: string | null } };
      };
    }).__remuxNarrationDebugSnapshot?.().client.store.currentBlockId ?? null
  ));
  await expect(page.locator(`[data-narration-block-id="${nextBlockId}"] .remux-markdown-narration-context-rect`).first()).toBeVisible();

  await page.getByRole('button', { name: 'Close narration' }).click();
  await expect(page.getByRole('button', { name: 'Narrate markdown' })).toBeVisible();
  await expect(page.locator('.remux-markdown-narration-paint-layer')).toHaveCount(0);
});

test('shows preparation progress and always exposes cancellation', async ({ page }) => {
  await page.getByRole('button', { name: 'Narrate markdown' }).click();
  await expect(page.getByRole('button', { name: 'Preparing narration' })).toBeVisible();
  await expect(page.getByText('Preparing speech 0 of 2')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel narration preparation' }).click();
  await expect(page.getByRole('button', { name: 'Narrate markdown' })).toBeVisible();
});

test('keeps background-completed narration ready instead of autoplaying', async ({ page }) => {
  await page.getByRole('button', { name: 'Narrate markdown' }).click();
  await expect(page.getByRole('button', { name: 'Preparing narration' })).toBeVisible();
  await page.evaluate(() => {
    const mock = window as typeof window & {
      __narrateLifecycle?: (state: 'active' | 'background') => void;
      __narrateSetReady?: () => void;
    };
    mock.__narrateLifecycle?.('background');
    mock.__narrateSetReady?.();
  });
  await expect(page.getByRole('button', { name: 'Play narration' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause narration' })).toHaveCount(0);
});

test('honors seek exclusions, follow ownership, block taps, and playback-rate persistence', async ({ page }) => {
  await page.getByRole('button', { name: 'Narrate markdown' }).click();
  await expect(page.getByRole('button', { name: 'Pause narration' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause narration' }).click();
  const initialBlock = await currentBlockId(page);

  await page.getByRole('link', { name: 'Markdown' }).click();
  expect(await currentBlockId(page)).toBe(initialBlock);

  await page.evaluate(() => {
    const paragraph = document.querySelector<HTMLElement>('[data-narration-block-id="md:1"]');
    const text = paragraph?.querySelector<HTMLElement>('[data-narration-leaf-kind="text"]')?.firstChild;
    if (!paragraph || !text) return;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(text);
    selection?.removeAllRanges();
    selection?.addRange(range);
    paragraph.click();
  });
  expect(await currentBlockId(page)).toBe(initialBlock);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  await page.locator('[data-narration-block-id="md:3"]').click();
  await expect.poll(() => currentBlockId(page)).toBe('md:3');
  await expect.poll(() => narrationPaintBlockId(page)).toBe('md:3');
  await expect(page.locator('[data-narration-block-id="md:3"]')).not.toHaveClass(/remux-markdown-narration-block-active/u);
  await expect(page.locator(
    '[data-narration-block-id="md:3"] [data-narration-render-surface="code"]',
  )).toHaveClass(/remux-markdown-narration-block-active/u);

  await page.locator('.remux-markdown-content-shell').dispatchEvent('wheel');
  await expect.poll(() => narrationStoreValue(page, 'followEnabled')).toBe(false);
  await expect(page.getByRole('button', { name: 'Enable narration auto-scroll' })).toBeVisible();
  await page.getByRole('button', { name: 'Previous narrated block' }).click();
  await expect.poll(() => narrationStoreValue(page, 'followEnabled')).toBe(true);
  await expect(page.getByRole('button', { name: 'Disable narration auto-scroll' })).toBeVisible();

  await page.getByRole('button', { name: 'Narration speed 1x' }).click();
  await page.getByRole('menuitem', { name: '1.5x' }).click();
  await expect(page.getByRole('button', { name: 'Narration speed 1.5x' })).toBeVisible();
  expect(await narrationStoreValue(page, 'playbackRate')).toBe(1.5);

  await page.getByRole('button', { name: 'Close narration' }).click();
  await page.getByRole('button', { name: 'Narrate markdown' }).click();
  await expect(page.getByRole('button', { name: 'Narration speed 1.5x' })).toBeVisible();
});

test('paints rounded structural narration surfaces without changing layout', async ({ page }) => {
  await expect(page.locator('[data-narration-block-id]')).toHaveCount(4);
  await expect(page.locator('.remux-markdown-mermaid-diagram')).toBeVisible();
  const document = page.locator('.remux-markdown-document');
  const initialHeight = await document.evaluate((element) => element.getBoundingClientRect().height);

  await page.getByRole('button', { name: 'Narrate markdown' }).click();
  await expect(page.getByRole('button', { name: 'Pause narration' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause narration' }).click();

  const blocks = [
    { className: 'remux-markdown-code-highlight', id: 'md:0', kind: 'code' },
    { className: 'remux-markdown-table-scroll', id: 'md:1', kind: 'table' },
    { className: 'remux-markdown-mermaid-card', id: 'md:2', kind: 'diagram' },
    { className: 'katex-display', id: 'md:3', kind: 'code' },
  ] as const;

  for (const [index, expected] of blocks.entries()) {
    if (index > 0) {
      expect(await setAudioTime(page, index + 0.25)).toBe(true);
    }
    await expect.poll(() => currentBlockId(page)).toBe(expected.id);
    await expect.poll(() => narrationPaintBlockId(page)).toBe(expected.id);
    await expect.poll(() => structuralSurfaceSnapshot(page, expected.id, expected.kind)).toMatchObject({
      activeSurfaceCount: 1,
      borderRadius: '8px',
      className: expect.stringContaining(expected.className),
      found: true,
      kind: expected.kind,
      logicalActive: expected.id === 'md:3',
      surfaceActive: true,
    });
    const snapshot = await structuralSurfaceSnapshot(page, expected.id, expected.kind);
    expect(snapshot.boxShadow).not.toBe('none');
    expect(snapshot.outlineStyle).toBe('none');
  }

  expect(await document.evaluate((element) => element.getBoundingClientRect().height)).toBe(initialHeight);
  await page.getByRole('button', { name: 'Close narration' }).click();
  await expect(page.locator('.remux-markdown-narration-block-active')).toHaveCount(0);
});

test('auto-scrolls narration by cue, yields to the user, and can be reclaimed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Narrate markdown' }).click();
  await expect(page.getByRole('button', { name: 'Pause narration' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause narration' }).click();
  const autoScrollButton = page.getByRole('button', { name: 'Disable narration auto-scroll' });
  await expect(autoScrollButton).toBeVisible();
  expect(await actionBarGeometry(page)).toEqual({
    buttonSizes: Array.from({ length: 8 }, () => ({ height: 36, width: 39 })),
    edgeLeft: 16,
    edgeRight: 16,
    groupGap: 4,
    leftButtonGap: 7,
    rightButtonGaps: [7, 7, 7, 7, 7],
  });

  const actionBarFits = await page.locator('.remux-extension-action-bar').evaluate((element) => (
    element.scrollWidth <= element.clientWidth
  ));
  expect(actionBarFits).toBe(true);

  expect(await setAudioTime(page, 3.25)).toBe(true);
  await expect.poll(() => currentBlockId(page)).toBe('md:3');
  await expect.poll(() => cuePositionInViewport(page, 'md:3')).toBeGreaterThanOrEqual(0.18);
  await expect.poll(() => cuePositionInViewport(page, 'md:3')).toBeLessThanOrEqual(0.68);
  const shell = page.locator('.remux-markdown-content-shell');
  await expect.poll(() => shell.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await shell.dispatchEvent('wheel');
  await expect.poll(() => narrationStoreValue(page, 'followEnabled')).toBe(false);
  await expect(page.getByRole('button', { name: 'Enable narration auto-scroll' })).toBeVisible();
  const userOwnedScrollTop = await shell.evaluate((element) => element.scrollTop);

  expect(await setAudioTime(page, 4.25)).toBe(true);
  await expect.poll(() => currentBlockId(page)).toBe('md:4');
  await page.waitForTimeout(150);
  expect(Math.abs(await shell.evaluate((element) => element.scrollTop) - userOwnedScrollTop)).toBeLessThan(2);

  await page.getByRole('button', { name: 'Enable narration auto-scroll' }).click();
  await expect.poll(() => narrationStoreValue(page, 'followEnabled')).toBe(true);
  await expect.poll(() => cuePositionInViewport(page, 'md:4')).toBeGreaterThanOrEqual(0.18);
  await expect.poll(() => cuePositionInViewport(page, 'md:4')).toBeLessThanOrEqual(0.68);
  await expect(page.getByRole('button', { name: 'Disable narration auto-scroll' })).toBeVisible();
});

test('pauses active audio on background and fences a file navigation immediately', async ({ page }) => {
  await page.getByRole('button', { name: 'Narrate markdown' }).click();
  await expect(page.getByRole('button', { name: 'Pause narration' })).toBeVisible();
  await page.evaluate(() => (
    window as typeof window & {
      __narrateLifecycle?: (state: 'active' | 'background') => void;
    }
  ).__narrateLifecycle?.('background'));
  await expect(page.getByRole('button', { name: 'Play narration' })).toBeVisible();
  expect(await narrationStoreValue(page, 'phase')).toBe('paused');

  await page.evaluate(() => (
    window as typeof window & { __narrateNavigate?: (path: string) => void }
  ).__narrateNavigate?.('/tmp/replacement.md'));
  await expect(page.getByRole('heading', { name: 'Replacement document' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Narrate markdown' })).toBeVisible();
  expect(await narrationStoreValue(page, 'phase')).toBe('idle');
  await expect(page.locator('.remux-markdown-narration-paint-layer')).toHaveCount(0);
});

async function currentBlockId(page: Page) {
  return narrationStoreValue(page, 'currentBlockId') as Promise<string | null>;
}

async function narrationPaintBlockId(page: Page) {
  return page.evaluate(() => (
    (globalThis as typeof globalThis & {
      __remuxNarrationDebugSnapshot?: () => { paint: { blockId: string | null } };
    }).__remuxNarrationDebugSnapshot?.().paint.blockId ?? null
  ));
}

async function narrationStoreValue(page: Page, key: string) {
  return page.evaluate((storeKey) => {
    const snapshot = (globalThis as typeof globalThis & {
      __remuxNarrationDebugSnapshot?: () => { client: { store: Record<string, unknown> } };
    }).__remuxNarrationDebugSnapshot?.();
    return snapshot?.client.store[storeKey] ?? null;
  }, key);
}

async function setAudioTime(page: Page, seconds: number) {
  return page.evaluate((nextTime) => (
    globalThis as typeof globalThis & { __narrateSetAudioTime?: (time: number) => boolean }
  ).__narrateSetAudioTime?.(nextTime) ?? false, seconds);
}

async function structuralSurfaceSnapshot(page: Page, blockId: string, kind: string) {
  return page.evaluate(({ id, surfaceKind }) => {
    const logical = document.querySelector<HTMLElement>(`[data-narration-block-id="${id}"]`);
    const selector = `[data-narration-render-surface="${surfaceKind}"]`;
    const surface = logical?.matches(selector)
      ? logical
      : logical?.parentElement?.closest<HTMLElement>(selector)
        ?? logical?.querySelector<HTMLElement>(selector)
        ?? null;
    const style = surface ? getComputedStyle(surface) : null;
    return {
      activeSurfaceCount: document.querySelectorAll('.remux-markdown-narration-block-active').length,
      borderRadius: style?.borderRadius ?? null,
      boxShadow: style?.boxShadow ?? null,
      className: surface?.className ?? '',
      found: Boolean(surface),
      kind: surface?.dataset.narrationRenderSurface ?? null,
      logicalActive: logical?.classList.contains('remux-markdown-narration-block-active') ?? false,
      outlineStyle: style?.outlineStyle ?? null,
      surfaceActive: surface?.classList.contains('remux-markdown-narration-block-active') ?? false,
    };
  }, { id: blockId, surfaceKind: kind });
}

async function cuePositionInViewport(page: Page, blockId: string) {
  return page.evaluate((id) => {
    const shell = document.querySelector<HTMLElement>('.remux-markdown-content-shell');
    const block = document.querySelector<HTMLElement>(`[data-narration-block-id="${id}"]`);
    if (!shell || !block) return -1;
    const viewport = shell.getBoundingClientRect();
    const cue = block.querySelector<HTMLElement>('.remux-markdown-narration-word-rect')
      ?? block.querySelector<HTMLElement>('.remux-markdown-narration-context-rect')
      ?? block;
    return (cue.getBoundingClientRect().top - viewport.top) / Math.max(1, viewport.height);
  }, blockId);
}

async function actionBarGeometry(page: Page) {
  return page.locator('.remux-extension-action-bar').evaluate((element) => {
    const bar = element.getBoundingClientRect();
    const buttons = [...element.querySelectorAll<HTMLElement>('.remux-extension-action-button')]
      .map((button) => button.getBoundingClientRect());
    const gap = (left: DOMRect, right: DOMRect) => right.left - left.right;
    return {
      buttonSizes: buttons.map((button) => ({ height: button.height, width: button.width })),
      edgeLeft: buttons[0].left - bar.left,
      edgeRight: bar.right - buttons.at(-1)!.right,
      groupGap: gap(buttons[1], buttons[2]),
      leftButtonGap: gap(buttons[0], buttons[1]),
      rightButtonGaps: buttons.slice(3).map((button, index) => gap(buttons[index + 2], button)),
    };
  });
}
