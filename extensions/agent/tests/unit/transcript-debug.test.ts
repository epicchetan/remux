import assert from 'node:assert/strict';
import { test } from '@playwright/test';

import { duplicateStrings, transcriptDebugEnabled } from '../../viewer/src/transcript/debug.ts';

type AgentDebugGlobal = typeof globalThis & {
  __REMUX_AGENT_TRANSCRIPT_DEBUG__?: unknown;
};

test.afterEach(() => {
  delete (globalThis as AgentDebugGlobal).__REMUX_AGENT_TRANSCRIPT_DEBUG__;
});

test('transcript debug logging is opt-in outside a browser', () => {
  assert.equal(transcriptDebugEnabled(), false);
});

test('transcript debug logging honors boolean and string overrides', () => {
  (globalThis as AgentDebugGlobal).__REMUX_AGENT_TRANSCRIPT_DEBUG__ = true;
  assert.equal(transcriptDebugEnabled(), true);
  (globalThis as AgentDebugGlobal).__REMUX_AGENT_TRANSCRIPT_DEBUG__ = '1';
  assert.equal(transcriptDebugEnabled(), true);
  (globalThis as AgentDebugGlobal).__REMUX_AGENT_TRANSCRIPT_DEBUG__ = false;
  assert.equal(transcriptDebugEnabled(), false);
});

test('duplicate detection reports each repeated resource key once', () => {
  assert.deepEqual(duplicateStrings(['a', 'b', 'a', 'a', 'c', 'b']), ['a', 'b']);
});
