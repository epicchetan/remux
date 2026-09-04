import assert from 'node:assert/strict';
import { test } from '@playwright/test';

import type { AgentTurnRenderFrame, AgentTurnSegment } from '../../shared/transcript.ts';
import { transcriptLayout } from '../../viewer/src/transcript/layout/constants.ts';
import { TranscriptMeasureCache } from '../../viewer/src/transcript/layout/measureCache.ts';
import { measureCollapsedTranscript } from '../../viewer/src/transcript/layout/measureCollapsed.ts';
import { reconcileMeasuredTranscript } from '../../viewer/src/transcript/layout/reconcileMeasured.ts';
import { resolveTranscriptContentWidth } from '../../viewer/src/transcript/measureWidth.ts';
import {
  autoScrollModeAfterNativeScrollSettles,
  autoScrollModeForStreamingTurn,
  initialTranscriptScrollTarget,
  nativeScrollOwnsTranscriptViewport,
  nextUserMessageScrollAnchor,
  previousUserMessageScrollAnchor,
  resolveInitialTranscriptScrollTarget,
  resolveSentMessageScroll,
  transcriptMessageAnchorTopOffset,
  transcriptNativeScrollPhaseAfterEvent,
  userMessageRowMatchesId,
} from '../../viewer/src/transcript/virtualizerScroll.ts';
import {
  computeTranscriptSpacerRange,
  computeTranscriptVirtualRange,
} from '../../viewer/src/transcript/virtualizerRange.ts';
import {
  discardTranscriptUserMessage,
  getTranscriptViewportState,
  resetTranscriptViewportForConversation,
  trackTranscriptUserMessage,
} from '../../viewer/src/transcript/viewportStore.ts';

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

test('includes attachment rails in virtual user-message heights', () => {
  const textOnly = measureCollapsedTranscript({
    turns: [frame('turn-text', [user('user-text', 'Use this image')])],
    width: 600,
  }).turns[0]?.rows[0]?.height;
  const textAndImage = measureCollapsedTranscript({
    turns: [frame('turn-image', [imageUser('user-image', 'Use this image')])],
    width: 600,
  }).turns[0]?.rows[0]?.height;
  const imageOnly = measureCollapsedTranscript({
    turns: [frame('turn-image-only', [imageUser('user-image-only', '')])],
    width: 600,
  }).turns[0]?.rows[0]?.height;

  assert.equal(textAndImage, (textOnly ?? 0) + 62 + transcriptLayout.user.bubbleGap);
  assert.equal(imageOnly,
    62 +
    transcriptLayout.user.bubblePaddingY * 2 +
    transcriptLayout.user.bubbleBorderWidth * 2 +
    transcriptLayout.user.actionTopGap +
    transcriptLayout.user.actionHeight +
    transcriptLayout.row.defaultGap);
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

test('navigates compact transcript tails by user-message identity instead of clamped scroll position', () => {
  const anchors = [
    { contentBottom: 150, contentTop: 124, segmentId: 'user-1', scrollTop: 100, turnId: 'turn-1' },
    { contentBottom: 270, contentTop: 244, segmentId: 'user-2', scrollTop: 220, turnId: 'turn-2' },
    { contentBottom: 390, contentTop: 364, segmentId: 'user-3', scrollTop: 340, turnId: 'turn-3' },
  ];

  assert.deepEqual(previousUserMessageScrollAnchor({
    anchors,
    atBottom: true,
    scrollTop: 300,
  }), anchors[1]);
  assert.deepEqual(previousUserMessageScrollAnchor({
    anchors,
    atBottom: false,
    currentSegmentId: 'user-3',
    scrollTop: 340,
  }), anchors[1]);
  assert.deepEqual(nextUserMessageScrollAnchor({
    anchors,
    atBottom: false,
    currentSegmentId: 'user-2',
    maxScrollTop: 400,
    scrollTop: 220,
  }), anchors[2]);
  assert.equal(nextUserMessageScrollAnchor({
    anchors,
    atBottom: false,
    currentSegmentId: 'user-3',
    maxScrollTop: 400,
    scrollTop: 340,
  }), null);
});

test('next-turn navigation does not manufacture runway for an unreachable message anchor', () => {
  const anchors = [
    { contentBottom: 120, contentTop: 60, segmentId: 'user-1', scrollTop: 36, turnId: 'turn-1' },
    { contentBottom: 250, contentTop: 190, segmentId: 'user-2', scrollTop: 166, turnId: 'turn-2' },
    { contentBottom: 380, contentTop: 320, segmentId: 'user-3', scrollTop: 296, turnId: 'turn-3' },
  ];

  assert.equal(nextUserMessageScrollAnchor({
    anchors,
    atBottom: false,
    currentSegmentId: 'user-1',
    maxScrollTop: 150,
    scrollTop: 36,
  }), null, 'an anchor beyond the natural bottom is represented by the bottom destination instead');
});

test('previous-turn navigation skips every user message already visible at the compact tail', () => {
  const anchors = [
    { contentBottom: 120, contentTop: 60, segmentId: 'user-1', scrollTop: 36, turnId: 'turn-1' },
    { contentBottom: 250, contentTop: 190, segmentId: 'user-2', scrollTop: 166, turnId: 'turn-2' },
    { contentBottom: 380, contentTop: 320, segmentId: 'user-3', scrollTop: 296, turnId: 'turn-3' },
    { contentBottom: 510, contentTop: 450, segmentId: 'user-4', scrollTop: 426, turnId: 'turn-4' },
  ];

  assert.deepEqual(previousUserMessageScrollAnchor({
    anchors,
    atBottom: true,
    scrollTop: 180,
  }), anchors[0], 'visible tail messages are skipped in favor of the newest fully hidden row');
  assert.equal(previousUserMessageScrollAnchor({
    anchors,
    atBottom: true,
    scrollTop: 0,
  }), null, 'Up is unavailable when every user message is already in view');
});

test('discards a rejected message anchor without disturbing the draft conversation', () => {
  resetTranscriptViewportForConversation('conversation');
  trackTranscriptUserMessage('conversation', 'rejected-client-message');
  assert.deepEqual(getTranscriptViewportState().pendingUserMessageIds, ['rejected-client-message']);

  discardTranscriptUserMessage('rejected-client-message');
  assert.deepEqual(getTranscriptViewportState().pendingUserMessageIds, []);
  assert.equal(getTranscriptViewportState().conversationId, 'conversation');
});

test('rejects collapsed WebView samples and recovers width from the transcript lane', () => {
  assert.equal(resolveTranscriptContentWidth({
    contentWidth: 1,
    laneBorderWidth: 375,
    lanePaddingLeft: 16,
    lanePaddingRight: 16,
    viewportWidth: 390,
  }), 343);
  assert.equal(resolveTranscriptContentWidth({
    contentWidth: 1,
    laneBorderWidth: 1,
    lanePaddingLeft: 0,
    lanePaddingRight: 0,
    viewportWidth: 390,
  }), null);
  assert.equal(resolveTranscriptContentWidth({
    contentWidth: 868,
    laneBorderWidth: 900,
    lanePaddingLeft: 16,
    lanePaddingRight: 16,
    viewportWidth: 1_280,
  }), 868);
});

test('keeps native scroll ownership from touch through momentum settlement', () => {
  let phase = transcriptNativeScrollPhaseAfterEvent('idle', 'touch-start');
  assert.equal(phase, 'touch');
  assert.equal(nativeScrollOwnsTranscriptViewport(phase), true);

  phase = transcriptNativeScrollPhaseAfterEvent(phase, 'touch-end');
  assert.equal(phase, 'momentum');
  assert.equal(nativeScrollOwnsTranscriptViewport(phase), true);

  phase = transcriptNativeScrollPhaseAfterEvent(phase, 'settle');
  assert.equal(phase, 'idle');
  assert.equal(nativeScrollOwnsTranscriptViewport(phase), false);
});

test('restores bottom stickiness only after native scrolling settles at the bottom', () => {
  assert.deepEqual(autoScrollModeAfterNativeScrollSettles({
    currentMode: { type: 'off' },
    nearBottom: true,
    userInitiated: true,
  }), { type: 'bottom' });
  assert.deepEqual(autoScrollModeAfterNativeScrollSettles({
    currentMode: { type: 'bottom' },
    nearBottom: false,
    userInitiated: true,
  }), { type: 'off' });
  assert.deepEqual(autoScrollModeAfterNativeScrollSettles({
    currentMode: { type: 'bottom' },
    nearBottom: false,
    userInitiated: false,
  }), { type: 'bottom' });
});

test('holds a pinned sent-message anchor with runway after content collapses', () => {
  assert.deepEqual(resolveSentMessageScroll({
    currentScrollTop: 500,
    desiredScrollTop: 500,
    naturalMaxScrollTop: 420,
    phase: 'anchored',
    runwayHeight: 0,
    wasPinned: true,
  }), {
    phase: 'anchored',
    runwayHeight: 80,
    scrollTop: 500,
  });
});

test('keeps an established sent-message anchor pinned when the viewport grows', () => {
  assert.deepEqual(resolveSentMessageScroll({
    currentScrollTop: 500,
    desiredScrollTop: 500,
    naturalMaxScrollTop: 420,
    phase: 'anchored',
    runwayHeight: 80,
    wasPinned: true,
  }), {
    phase: 'anchored',
    runwayHeight: 80,
    scrollTop: 500,
  });
});

test('does not establish a new message pin during a transient viewport resize', () => {
  assert.deepEqual(resolveSentMessageScroll({
    anchorActivationAllowed: false,
    currentScrollTop: 560,
    desiredScrollTop: 500,
    naturalMaxScrollTop: 600,
    phase: 'catching-up',
    runwayHeight: 0,
    wasPinned: false,
  }), {
    phase: 'catching-up',
    runwayHeight: 0,
    scrollTop: 560,
  });
  assert.deepEqual(resolveSentMessageScroll({
    anchorActivationAllowed: true,
    currentScrollTop: 560,
    desiredScrollTop: 500,
    naturalMaxScrollTop: 600,
    phase: 'catching-up',
    runwayHeight: 0,
    wasPinned: false,
  }), {
    phase: 'anchored',
    runwayHeight: 0,
    scrollTop: 500,
  });
});

test('resolves initial transcript placement to an exact message anchor or sticky bottom', () => {
  const anchors = [
    { contentBottom: 170, contentTop: 144, segmentId: 'user-1', scrollTop: 120, turnId: 'turn-1' },
    { contentBottom: 690, contentTop: 664, segmentId: 'user-2', scrollTop: 640, turnId: 'turn-2' },
  ];
  const streamingTarget = initialTranscriptScrollTarget({
    anchors,
    conversationId: 'conversation',
    streamingTurnId: 'turn-1',
  });
  assert.deepEqual(streamingTarget, {
    mode: {
      phase: 'catching-up',
      segmentId: 'user-1',
      conversationId: 'conversation',
      type: 'sent-message-anchor',
      turnId: 'turn-1',
    },
    scrollTop: 120,
  });
  assert.deepEqual(resolveInitialTranscriptScrollTarget({
    maxScrollTop: 80,
    target: streamingTarget,
  }), {
    mode: streamingTarget?.mode,
    scrollTop: 80,
  });
  assert.deepEqual(resolveInitialTranscriptScrollTarget({
    maxScrollTop: 500,
    target: initialTranscriptScrollTarget({
      anchors,
      conversationId: 'conversation',
      streamingTurnId: null,
    }),
  }), {
    mode: { type: 'bottom' },
    scrollTop: 500,
  });
  assert.deepEqual(resolveInitialTranscriptScrollTarget({ maxScrollTop: 500, target: null }), {
    mode: { type: 'bottom' },
    scrollTop: 500,
  });
});

test('uses a safe-area-aware offset and accounts for expanded rows outside the render range', () => {
  assert.equal(transcriptMessageAnchorTopOffset(8), 24);
  assert.equal(transcriptMessageAnchorTopOffset(44), 44);

  const turns = Array.from({ length: 30 }, (_, index) =>
    frame(`turn-${index}`, [user(`user-${index}`, `Request ${index}`)]));
  const layout = measureCollapsedTranscript({ turns, width: 600 });
  const activeTurnIds = layout.turns.slice(20, 25).map((turn) => turn.turnId);
  const withoutExpansion = computeTranscriptSpacerRange({ activeTurnIds, turns: layout.turns });
  const withExpansion = computeTranscriptSpacerRange({
    activeTurnIds,
    expandedRows: [{ additionalHeight: 240, rowId: 'turn-3:user-3', turnId: 'turn-3' }],
    turns: layout.turns,
  });
  assert.equal(withExpansion.topSpacerHeight, withoutExpansion.topSpacerHeight + 240);
  assert.equal(withExpansion.bottomSpacerHeight, withoutExpansion.bottomSpacerHeight);
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

function imageUser(id: string, text: string): AgentTurnSegment {
  return {
    id,
    type: 'userMessage',
    clientMessageId: null,
    revision: '1',
    text,
    parts: [
      ...(text ? [{ text, type: 'text' as const }] : []),
      {
        artifactHash: 'a'.repeat(64),
        mimeType: 'image/png',
        name: 'fixture.png',
        sizeBytes: 1,
        type: 'image' as const,
      },
    ],
  };
}

function assistant(id: string, text: string): AgentTurnSegment {
  return { id, type: 'assistantMessage', revision: '1', text };
}
