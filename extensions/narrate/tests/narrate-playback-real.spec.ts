import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  installRealViewerBridge,
  narrationDebugSnapshot,
  startRealRemuxRuntime,
  stopRealRemuxRuntime,
  type RealRemuxRuntime,
} from '../../codex/tests/realRemuxHarness';

let fixturePath: string;
let runtime: RealRemuxRuntime;

test.beforeAll(async () => {
  runtime = await startRealRemuxRuntime();
  fixturePath = join(runtime.root, 'narrate-viewer-acceptance.md');
  await writeFile(fixturePath, [
    '# Narrate viewer acceptance',
    '',
    'Misaki aligns spoken words while Kokoro produces the final audio.',
    '',
    '```ts',
    'const voice = "af_heart";',
    '```',
  ].join('\n'));
});

test.afterAll(async () => {
  if (runtime) await stopRealRemuxRuntime(runtime);
});

test('prepares, plays, highlights, seeks, survives backgrounding, and closes', async ({ context, page }) => {
  await installRealViewerBridge(context, runtime);
  await page.goto(
    `${runtime.baseUrl}/viewers/narrate/?remuxResourceKind=file&remuxResourceId=${encodeURIComponent(fixturePath)}`,
  );
  await expect(page.getByRole('heading', { name: 'Narrate viewer acceptance' })).toBeVisible();

  await page.getByRole('button', { name: 'Narrate markdown' }).click();
  await expect(page.getByRole('button', { name: 'Preparing narration' })).toBeVisible();

  await expect.poll(async () => {
    const snapshot = await narrationDebugSnapshot(page) as NarrateDebugSnapshot | undefined;
    return snapshot?.client.store.artifactKey ?? null;
  }).not.toBeNull();
  await expect(page.getByRole('button', { name: /^(Play|Pause) narration$/u })).toBeVisible({
    timeout: 180_000,
  });
  if (await page.getByRole('button', { name: 'Play narration' }).isVisible()) {
    await page.getByRole('button', { name: 'Play narration' }).click();
  }
  await expect(page.getByRole('button', { name: 'Pause narration' })).toBeVisible();
  const firstSample = ((await narrationDebugSnapshot(page)) as NarrateDebugSnapshot).client.store.currentSample;
  await expect.poll(async () => (
    ((await narrationDebugSnapshot(page)) as NarrateDebugSnapshot).client.store.currentSample
  )).toBeGreaterThan(firstSample);
  await expect(page.locator('.remux-markdown-narration-context-rect').first()).toBeVisible();
  await expect(page.locator('.remux-markdown-narration-word-rect').first()).toBeVisible();

  await page.getByRole('button', { name: 'Pause narration' }).click();
  const firstBlock = ((await narrationDebugSnapshot(page)) as NarrateDebugSnapshot).client.store.currentBlockId;
  await page.getByRole('button', { name: 'Next narrated block' }).click();
  await expect.poll(async () => (
    ((await narrationDebugSnapshot(page)) as NarrateDebugSnapshot).client.store.currentBlockId
  )).not.toBe(firstBlock);

  await page.getByRole('button', { name: 'Play narration' }).click();
  await expect(page.getByRole('button', { name: 'Pause narration' })).toBeVisible();
  await page.evaluate(() => (
    window as typeof window & {
      __realNarrationBridge?: { lifecycle: (state: 'background') => void };
    }
  ).__realNarrationBridge?.lifecycle('background'));
  await expect(page.getByRole('button', { name: 'Play narration' })).toBeVisible();
  expect(((await narrationDebugSnapshot(page)) as NarrateDebugSnapshot).client.store.phase).toBe('paused');

  await page.evaluate(() => (
    window as typeof window & {
      __realNarrationBridge?: { lifecycle: (state: 'active') => void };
    }
  ).__realNarrationBridge?.lifecycle('active'));
  await expect(page.getByRole('button', { name: 'Play narration' })).toBeVisible();
  await page.getByRole('button', { name: 'Close narration' }).click();
  await expect(page.getByRole('button', { name: 'Narrate markdown' })).toBeVisible();
  await expect(page.locator('.remux-markdown-narration-paint-layer')).toHaveCount(0);
  expect(((await narrationDebugSnapshot(page)) as NarrateDebugSnapshot).client.store.phase).toBe('idle');
});

type NarrateDebugSnapshot = {
  client: {
    store: {
      artifactKey: string | null;
      currentBlockId: string | null;
      currentSample: number;
      phase: string;
    };
  };
};
