import assert from 'node:assert/strict';
import { test } from '@playwright/test';

import type { AgentTurnRenderFrame, AgentTurnSegment } from '../../shared/transcript.ts';
import { transcriptLayout } from '../../viewer/src/transcript/layout/constants.ts';
import { TranscriptMeasureCache } from '../../viewer/src/transcript/layout/measureCache.ts';
import { measureCollapsedTranscript } from '../../viewer/src/transcript/layout/measureCollapsed.ts';
import { reconcileMeasuredTranscript } from '../../viewer/src/transcript/layout/reconcileMeasured.ts';
import { autoScrollModeForStreamingTurn, userMessageRowMatchesId } from '../../viewer/src/transcript/virtualizerScroll.ts';
import { computeTranscriptVirtualRange } from '../../viewer/src/transcript/virtualizerRange.ts';

if (typeof globalThis.OffscreenCanvas === 'undefined') {
  globalThis.OffscreenCanvas = class {
    constructor(_width: number, _height: number) {}

    getContext() {
      return { measureText: (text: string) => ({ width: text.length * 8 }) };
    }
  } as unknown as typeof OffscreenCanvas;
}

test('measures turn prefixes and reserves actions for the latest user message', () => {
  const layout = measureCollapsedTranscript({
    turns: [
      frame('turn-1', [user('user-1', 'First')]),
      frame('turn-2', [user('user-2', 'Second'), assistant('assistant-2', 'Done')]),
    ],
    width: 600,
  });

  assert.equal(layout.turns[1]?.collapsedTop, layout.turns[0]?.collapsedHeight);
  assert.equal(layout.turns[0]?.rows[0]?.showUserActions, false);
  assert.equal(layout.turns[1]?.rows[0]?.showUserActions, true);
  assert.equal(
    layout.totalCollapsedHeight,
    layout.turns.reduce((total, turn) => total + turn.collapsedHeight, 0),
  );
});

test('reuses cached measurements for an unchanged frame revision', () => {
  const cache = new TranscriptMeasureCache();
  const turn = frame('turn-1', [user('user-1', 'Stable text')]);
  const first = measureCollapsedTranscript({ cache, conversationId: 'conversation', turns: [turn], width: 600 });
  const second = reconcileMeasuredTranscript({
    cache,
    previousTurnOrder: first.turns.map((item) => item.turnId),
    previousTurnsById: first.turnsById,
    conversationId: 'conversation',
    turns: [turn],
    width: 600,
  });

  assert.equal(second.turns[0]?.collapsedHeight, first.turns[0]?.collapsedHeight);
  assert.equal(second.turns[0]?.rows[0]?.height, first.turns[0]?.rows[0]?.height);
  assert.equal(cache.stats().entries, 1);
});

test('virtualizes a long measured window with top and bottom spacers', () => {
  const turns = Array.from({ length: 60 }, (_, index) =>
    frame(`turn-${index}`, [user(`user-${index}`, `Request ${index}`), assistant(`assistant-${index}`, `Answer ${index}`)]));
  const layout = measureCollapsedTranscript({ turns, width: 600 });
  const range = computeTranscriptVirtualRange({
    scrollTop: layout.totalCollapsedHeight / 2,
    topPadding: transcriptLayout.viewport.padY,
    turns: layout.turns,
    viewportHeight: 500,
  });

  assert.ok(range.activeTurnIds.length > 0 && range.activeTurnIds.length < turns.length);
  assert.ok(range.topSpacerHeight > 0);
  assert.ok(range.bottomSpacerHeight > 0);
});

test('preserves sent-message identity and never steals manual scroll during streaming', () => {
  assert.equal(userMessageRowMatchesId('segment', 'client-message', 'client-message'), true);
  assert.deepEqual(autoScrollModeForStreamingTurn({
    currentMode: { type: 'off' },
    nearBottom: false,
    streamingTurnId: 'turn',
  }), { type: 'off' });
  assert.deepEqual(autoScrollModeForStreamingTurn({
    currentMode: { type: 'bottom' },
    nearBottom: true,
    streamingTurnId: 'turn',
  }), { type: 'bottom' });
});

function frame(id: string, segments: AgentTurnSegment[]): AgentTurnRenderFrame {
  return {
    id,
    status: 'completed',
    startedAt: 0,
    completedAt: 1_000,
    durationMs: 1_000,
    error: null,
    renderRevision: `${id}:1`,
    layoutRevision: `${id}:1`,
    segments,
  };
}

function user(id: string, text: string): AgentTurnSegment {
  return { id, type: 'userMessage', clientMessageId: null, revision: '1', text };
}

function assistant(id: string, text: string): AgentTurnSegment {
  return { id, type: 'assistantMessage', revision: '1', text };
}
