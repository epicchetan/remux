import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { narrationSourceDocument } from '../viewer/transcript/components/markdown/markdownModel';

import {
  installRealViewerBridge,
  narrationDebugSnapshot,
  startRealRemuxRuntime,
  stopRealRemuxRuntime,
  type RealRemuxRuntime,
} from './realRemuxHarness';

let runtime: RealRemuxRuntime;

test.beforeAll(async () => {
  runtime = await startRealRemuxRuntime();
});

test.afterAll(async () => {
  if (runtime) await stopRealRemuxRuntime(runtime);
});

test('synthesizes, recovers from background, and plays a real aligned WAV', async ({ context, page }) => {
  await installRealViewerBridge(context, runtime);
  await page.goto(
    `${runtime.baseUrl}/viewers/codex/?remuxResourceKind=thread&remuxResourceId=${runtime.threadId}`,
  );
  await expect(page.getByText('Narration acceptance', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Narrate response' }).click();
  await expect(page.locator('.remux-narration-bar')).toContainText('Preparing narration');

  await expect.poll(async () => {
    const snapshot = await narrationDebugSnapshot(page) as any;
    return snapshot?.store?.artifactKey ?? null;
  }).not.toBeNull();
  const artifactKey = (await narrationDebugSnapshot(page) as any).store.artifactKey as string;

  await page.evaluate(() => (
    window as typeof window & {
      __realNarrationBridge?: { lifecycle: (state: 'background') => void };
    }
  ).__realNarrationBridge?.lifecycle('background'));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });

  const backgroundOutcome = await waitForNarrationResource(artifactKey, true);

  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  await page.evaluate(() => (
    window as typeof window & {
      __realNarrationBridge?: { lifecycle: (state: 'active') => void };
    }
  ).__realNarrationBridge?.lifecycle('active'));
  // If Narrate restarted while the WebView was suspended, the first read is
  // `missing`. The foreground reconciliation reissues the deterministic
  // start request and this second wait observes the recovered real job.
  const resource = backgroundOutcome.status === 'ready'
    ? backgroundOutcome.resource
    : (await waitForNarrationResource(artifactKey, false)).resource;

  const audioResponse = await fetch(new URL(resource.manifest.audio.url, runtime.baseUrl), {
    headers: { authorization: `Bearer ${runtime.token}` },
  });
  expect(audioResponse.status).toBe(200);
  expect(audioResponse.headers.get('content-type')).toBe('audio/wav');
  expect(audioResponse.headers.get('accept-ranges')).toBe('bytes');
  const wav = Buffer.from(await audioResponse.arrayBuffer());
  expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(wav.byteLength).toBe(resource.manifest.audio.sizeBytes);
  expect(wav.subarray(44).some((value) => value !== 0)).toBe(true);
  expect(resource.manifest.wordCues.length).toBeGreaterThan(4);
  expect(resource.manifest.sentences.length).toBeGreaterThan(1);

  const composer = page.locator('[data-remux-composer-root]');
  await expect(composer.getByRole('button', { name: 'Play narration' })).toBeVisible({ timeout: 180_000 });

  await composer.getByRole('button', { name: 'Play narration' }).click();
  await expect(composer.getByRole('button', { name: 'Pause narration' })).toBeVisible();
  const firstSample = (await narrationDebugSnapshot(page) as any).store.currentSample as number;
  await expect.poll(async () => (
    (await narrationDebugSnapshot(page) as any).store.currentSample
  )).toBeGreaterThan(firstSample);
  await expect(page.locator('.codex-narration-word-rect')).toBeVisible();
  await expect(page.locator('.codex-narration-context-rect').first()).toBeVisible();
  expect((await page.evaluate(() => (
    window as typeof window & { __realNarrationBridge?: { methods: string[] } }
  ).__realNarrationBridge?.methods ?? []))).not.toContain('remux/narrate/narration/audio/read');

  await page.evaluate(() => (
    window as typeof window & {
      __realNarrationBridge?: { lifecycle: (state: 'background') => void };
    }
  ).__realNarrationBridge?.lifecycle('background'));
  await expect(composer.getByRole('button', { name: 'Play narration' })).toBeVisible();
  let snapshot = await narrationDebugSnapshot(page) as any;
  expect(snapshot.store.phase).toBe('paused');
  expect(snapshot.audio.paused).toBe(true);
  expect(snapshot.audio.playIntent).toBe(false);

  await page.evaluate(() => (
    window as typeof window & {
      __realNarrationBridge?: { lifecycle: (state: 'active') => void };
    }
  ).__realNarrationBridge?.lifecycle('active'));
  await expect(composer.getByRole('button', { name: 'Play narration' })).toBeVisible();
  const pausedSample = snapshot.store.currentSample as number;
  await composer.getByRole('button', { name: 'Play narration' }).click();
  await expect.poll(async () => {
    snapshot = await narrationDebugSnapshot(page) as any;
    return snapshot.store.currentSample;
  }).toBeGreaterThan(pausedSample);

  const diagnostics = await runtime.rpc.request(
    'remux/narrate/narration/diagnostics/read',
    undefined,
    { kind: 'query', resourceKey: 'narration-diagnostics' },
  );
  expect(diagnostics.runs.at(-1)?.phase).toBe('ready');
});

test('authors private structural speech while keeping source-block alignment', async () => {
  test.setTimeout(240_000);
  const document = narrationSourceDocument([
    '# Structural narration acceptance',
    '',
    'This example explains a small request path.',
    '',
    '```ts',
    'const runtime = await Kokoro.load("model.onnx");',
    'runtime.connect("wss://example.test");',
    '```',
    '',
    '| Component | Responsibility |',
    '| --- | --- |',
    '| Codex | Sends JSON blocks |',
    '| Narrate | Produces the WAV |',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  Codex->>Narrate: narration document',
    '  Narrate->>Kokoro: validated phones',
    '```',
  ].join('\n'));
  const structuralBlocks = document.blocks.filter((block) => block.highlightMode === 'block');
  expect(structuralBlocks.map((block) => block.kind)).toEqual(['code', 'table', 'diagram']);

  const started = await runtime.rpc.request(
    'remux/narrate/narration/start',
    { document },
    { kind: 'job-start', operationId: 'narration-real-structural-response' },
  );
  const artifactKey = started.artifactKey as string;
  const { resource } = await waitForNarrationResource(artifactKey, false, 220_000);
  expect(resource.manifest.schemaVersion).toBe(4);
  expect(resource.progress.transcriptWindowsTotal).toBe(1);
  expect(resource.progress.transcriptWindowsCompleted).toBe(1);

  const artifactDirectory = join(
    runtime.root,
    '.remux/cache/narrate/batch-alignment-v4-post-transcript-direct-review',
    artifactKey,
  );
  const plan = JSON.parse(
    await readFile(join(artifactDirectory, 'structural-transcript-plan.json'), 'utf8'),
  );
  expect(plan.blocks.map((block: any) => block.blockId)).toEqual(
    structuralBlocks.map((block) => block.id),
  );
  for (const [index, source] of structuralBlocks.entries()) {
    const projected = plan.blocks[index];
    const transcript = projected.transcript;
    expect(transcript.trim().length).toBeGreaterThan(10);
    expect(transcript).not.toBe(source.text);

    const sentences = resource.manifest.sentences.filter(
      (sentence: any) => sentence.blockId === source.id,
    );
    expect(sentences).toHaveLength(1);
    const leading = source.text.length - source.text.trimStart().length;
    const trailing = source.text.trimEnd().length;
    expect(sentences[0]).toMatchObject({ textStart: leading, textEnd: trailing });
    expect(resource.manifest.wordCues.some((cue: any) => cue.blockId === source.id)).toBe(false);
    expect(resource.manifest.blocks.some((block: any) => block.blockId === source.id)).toBe(true);
  }

  const audioResponse = await fetch(new URL(resource.manifest.audio.url, runtime.baseUrl), {
    headers: { authorization: `Bearer ${runtime.token}` },
  });
  expect(audioResponse.status).toBe(200);
  expect(Buffer.from(await audioResponse.arrayBuffer()).subarray(0, 4).toString('ascii')).toBe('RIFF');
});

test('reviews and deterministically caches a multiwindow technical response', async () => {
  test.setTimeout(360_000);
  const markdown = (await readFile(
    join(process.cwd(), 'docs/specs/narrate-pronunciation-audit.md'),
    'utf8',
  )).split('\n').slice(0, 100).join('\n');
  const document = narrationSourceDocument(markdown);
  const sourceWords = document.blocks
    .flatMap((block) => block.text.match(/[\p{L}\p{N}]+/gu) ?? []);
  expect(sourceWords.length).toBeGreaterThan(500);

  const started = await runtime.rpc.request(
    'remux/narrate/narration/start',
    { document },
    { kind: 'job-start', operationId: 'narration-real-long-response' },
  );
  const artifactKey = started.artifactKey as string;
  const { resource } = await waitForNarrationResource(artifactKey, false, 300_000);
  expect(resource.manifest.schemaVersion).toBe(4);
  expect(resource.manifest.pronunciationPlanSha256).toMatch(/^sha256-[0-9a-f]{64}$/);
  expect(resource.manifest.structuralTranscriptPlanSha256).toMatch(/^sha256-[0-9a-f]{64}$/);
  expect(resource.manifest.profile.pronunciationReviewer).toMatchObject({
    directPhoneValidatorVersion: 1,
    outputSchemaVersion: 4,
    phoneAlphabetVersion: 1,
    promptVersion: 4,
    windowPlannerVersion: 3,
  });
  expect(resource.manifest.profile.pronunciationReviewer.phoneAlphabetSha256)
    .toMatch(/^sha256-[0-9a-f]{64}$/);
  expect(resource.manifest.profile.pronunciationReviewer.kokoroVocabularySha256)
    .toMatch(/^sha256-[0-9a-f]{64}$/);
  expect(resource.manifest.profile.structuralTranscript).toMatchObject({
    outputSchemaVersion: 2,
    promptVersion: 2,
    windowPlannerVersion: 1,
  });
  expect(resource.progress.auditWindowsTotal).toBeGreaterThanOrEqual(2);
  expect(resource.progress.auditWindowsCompleted).toBe(resource.progress.auditWindowsTotal);

  const artifactDirectory = join(
    runtime.root,
    '.remux/cache/narrate/batch-alignment-v4-post-transcript-direct-review',
    artifactKey,
  );
  expect((await readdir(artifactDirectory)).sort()).toEqual([
    'audio.wav',
    'manifest.json',
    'pronunciation-plan.json',
    'source-document.json',
    'structural-transcript-plan.json',
  ]);
  const plan = JSON.parse(await readFile(join(artifactDirectory, 'pronunciation-plan.json'), 'utf8'));
  expect(plan.schemaVersion).toBe(4);
  expect(plan.phoneAlphabetVersion).toBe(1);
  expect(plan.directPhoneValidatorVersion).toBe(1);
  expect(plan.phoneAlphabetSha256).toBe(
    resource.manifest.profile.pronunciationReviewer.phoneAlphabetSha256,
  );
  expect(plan.kokoroVocabularySha256).toBe(
    resource.manifest.profile.pronunciationReviewer.kokoroVocabularySha256,
  );
  expect(plan.windows).toHaveLength(resource.progress.auditWindowsTotal);
  expect(plan.patches.length).toBeGreaterThan(0);
  expect(plan.patches.every((patch: any) => patch.correction?.kind === 'directPhones')).toBe(true);
  expect(JSON.stringify(plan)).not.toContain('spoken');
  const structuralPlan = JSON.parse(
    await readFile(join(artifactDirectory, 'structural-transcript-plan.json'), 'utf8'),
  );
  expect(structuralPlan.schemaVersion).toBe(2);
  expect(structuralPlan.sourceDocumentHash).toBe(resource.manifest.documentHash);
  expect(structuralPlan.blocks.every((block: any) => (
    typeof block.transcript === 'string' && block.transcript.length > 0
  ))).toBe(true);
  expect(JSON.stringify(structuralPlan)).not.toContain('phones');

  const diagnosticsBefore = await runtime.rpc.request(
    'remux/narrate/narration/diagnostics/read',
    undefined,
    { kind: 'query', resourceKey: 'narration-diagnostics-before-cache' },
  );
  const cacheStarted = await runtime.rpc.request(
    'remux/narrate/narration/start',
    { document },
    { kind: 'job-start', operationId: 'narration-real-long-response-cache' },
  );
  expect(cacheStarted.artifactKey).toBe(artifactKey);
  expect(cacheStarted.resource.status).toBe('ready');
  const diagnosticsAfter = await runtime.rpc.request(
    'remux/narrate/narration/diagnostics/read',
    undefined,
    { kind: 'query', resourceKey: 'narration-diagnostics-after-cache' },
  );
  expect(diagnosticsAfter.runs).toHaveLength(diagnosticsBefore.runs.length);
});

async function waitForNarrationResource(
  artifactKey: string,
  returnOnMissing: boolean,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unavailable';
  while (Date.now() < deadline) {
    try {
      const response = await runtime.rpc.request(
        'remux/narrate/narration/resources/read',
        { artifactKey },
        { kind: 'query', resourceKey: `narration:${artifactKey}` },
      );
      lastStatus = response.resource?.status ?? response.status;
      if (lastStatus === 'ready') {
        return { resource: response.resource, status: 'ready' as const };
      }
      if (lastStatus === 'failed' || lastStatus === 'cancelled') {
        throw new Error(`Real narration ended as ${lastStatus}: ${response.resource?.error ?? ''}`);
      }
      if (lastStatus === 'missing' && returnOnMissing) {
        return { resource: null, status: 'missing' as const };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('extension narrate is not running')) throw error;
      lastStatus = 'extension-restarting';
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Real narration did not become ready; last status was ${lastStatus}`);
}
