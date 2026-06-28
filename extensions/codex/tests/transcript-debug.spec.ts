import { expect, test } from '@playwright/test';

import { transcriptDebugEnabled } from '../viewer/transcript/debug';

type TranscriptDebugGlobal = typeof globalThis & {
  __REMUX_CODEX_TRANSCRIPT_DEBUG__?: unknown;
};

test.afterEach(() => {
  delete (globalThis as TranscriptDebugGlobal).__REMUX_CODEX_TRANSCRIPT_DEBUG__;
});

test.describe('transcript debug logging', () => {
  test('is disabled by default outside an explicit browser opt-in', () => {
    delete (globalThis as TranscriptDebugGlobal).__REMUX_CODEX_TRANSCRIPT_DEBUG__;

    expect(transcriptDebugEnabled()).toBe(false);
  });

  test('can be enabled by a global override', () => {
    (globalThis as TranscriptDebugGlobal).__REMUX_CODEX_TRANSCRIPT_DEBUG__ = true;

    expect(transcriptDebugEnabled()).toBe(true);
  });

  test('can be disabled by a global override', () => {
    (globalThis as TranscriptDebugGlobal).__REMUX_CODEX_TRANSCRIPT_DEBUG__ = false;

    expect(transcriptDebugEnabled()).toBe(false);
  });
});
