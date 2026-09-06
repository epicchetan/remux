import assert from 'node:assert/strict';
import { test } from '@playwright/test';

import type { AgentTurnRenderFrame, AgentTurnSegment } from '../../shared/transcript.ts';
import { transcriptLayout } from '../../viewer/src/transcript/layout/constants.ts';
import { TranscriptMeasureCache } from '../../viewer/src/transcript/layout/measureCache.ts';
import { measureCollapsedTranscript } from '../../viewer/src/transcript/layout/measureCollapsed.ts';
import { reconcileMeasuredTranscript } from '../../viewer/src/transcript/layout/reconcileMeasured.ts';
import { TranscriptGeometryIndex } from '../../viewer/src/transcript/geometry/geometryIndex.ts';
import {
  emptyTranscriptDisclosureState,
  reconcileTranscriptDisclosure,
  toggleWorkDisclosure,
} from '../../viewer/src/transcript/disclosure/disclosureReducer.ts';
import { resolveTranscriptContentWidth } from '../../viewer/src/transcript/measureWidth.ts';
import {
  viewportIntentAfterNativeScrollSettles,
  viewportIntentForStreamingTurn,
  historicalMessageNavigationDestination,
  initialTranscriptScrollTarget,
  nextUserMessageScrollAnchor,
  nextTranscriptNavigationDestination,
  previousUserMessageScrollAnchor,
  resolveInitialTranscriptScrollTarget,
  resolveMessageAnchorScroll,
  transcriptMessageAnchorTopOffset,
  transcriptViewportAnchorScrollTop,
  userMessageRowMatchesId,
} from '../../viewer/src/transcript/virtualizerScroll.ts';
import {
  nativeScrollOwnsViewport,
  transcriptScrollOwnerAfterNativeEvent,
} from '../../viewer/src/transcript/viewport/viewportTypes.ts';
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

test('measures terminal error and projection retry footers exactly once and invalidates unchanged frames', () => {
  const cache = new TranscriptMeasureCache();
  const failed = frame('turn-failed', [user('user-failed', 'Please try this')]);
  const healthy = frame('turn-healthy', [user('user-healthy', 'Next'), assistant('assistant-healthy', 'Done')]);
  const terminalError = 'Selected model is at capacity. Please try a different model. '.repeat(4);
  const errorRows = [{ id: 'turn-failed:terminal-error', kind: 'terminal-error' as const, message: terminalError }];
  const withError = { revision: JSON.stringify(errorRows), rows: errorRows };
  const first = measureCollapsedTranscript({
    cache,
    conversationId: 'conversation',
    displayFootersByTurnId: { 'turn-failed': withError },
    turns: [failed, healthy],
    width: 320,
  });
  const withoutFooter = measureCollapsedTranscript({ turns: [failed, healthy], width: 320 });
  const errorHeight = first.turns[0]!.collapsedHeight - withoutFooter.turns[0]!.collapsedHeight;

  assert.ok(errorHeight > transcriptLayout.footer.errorPaddingY * 2);
  assert.equal(first.turns[1]!.collapsedTop - withoutFooter.turns[1]!.collapsedTop, errorHeight);
  assert.equal(first.totalCollapsedHeight - withoutFooter.totalCollapsedHeight, errorHeight);

  const retryRows = [
      ...withError.rows,
      { id: 'turn-failed:projection-retry', kind: 'projection-retry' as const, message: 'projection failed' },
    ];
  const withRetry = { revision: JSON.stringify(retryRows), rows: retryRows };
  const retried = reconcileMeasuredTranscript({
    cache,
    conversationId: 'conversation',
    displayFootersByTurnId: { 'turn-failed': withRetry },
    previousTurnOrder: first.turns.map((turn) => turn.turnId),
    previousTurnsById: first.turnsById,
    turns: [failed, healthy],
    width: 320,
  });
  assert.equal(
    retried.turns[0]!.collapsedHeight - first.turns[0]!.collapsedHeight,
    transcriptLayout.footer.rowGap + transcriptLayout.footer.retryHeight,
  );
  assert.equal(retried.turns[1]!.collapsedTop, retried.turns[0]!.collapsedHeight);

  const cleared = reconcileMeasuredTranscript({
    cache,
    conversationId: 'conversation',
    previousTurnOrder: retried.turns.map((turn) => turn.turnId),
    previousTurnsById: retried.turnsById,
    turns: [failed, healthy],
    width: 320,
  });
  assert.equal(cleared.turns[0]!.collapsedHeight, withoutFooter.turns[0]!.collapsedHeight);
  assert.equal(cleared.turns[1]!.collapsedTop, withoutFooter.turns[1]!.collapsedTop);
  assert.equal(cache.stats().entries, 4);
});

test('matches empty-line footer flow for whitespace-only terminal errors', () => {
  const turn = frame('turn-whitespace-error', [user('user-whitespace-error', 'Try')]);
  const rows = [{
    id: 'turn-whitespace-error:terminal-error',
    kind: 'terminal-error' as const,
    message: '   ',
  }];
  const base = measureCollapsedTranscript({ turns: [turn], width: 320 }).turns[0]!.collapsedHeight;
  const measured = measureCollapsedTranscript({
    displayFootersByTurnId: {
      [turn.id]: { revision: JSON.stringify(rows), rows },
    },
    turns: [turn],
    width: 320,
  }).turns[0]!.collapsedHeight;
  assert.equal(
    measured - base,
    transcriptLayout.footer.errorPaddingY * 2 +
      transcriptLayout.footer.borderWidth * 2 +
      transcriptLayout.footer.turnGap,
  );
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

test('preserves message-anchor identity and never steals manual scroll during streaming', () => {
  assert.equal(userMessageRowMatchesId('segment', 'client-message', 'client-message'), true);
  assert.deepEqual(viewportIntentForStreamingTurn({
    currentIntent: { kind: 'free' },
    nearBottom: false,
    streamingTurnId: 'turn',
  }), { kind: 'free' });
  assert.deepEqual(viewportIntentForStreamingTurn({
    currentIntent: { kind: 'bottom-follow' },
    nearBottom: true,
    streamingTurnId: 'turn',
  }), { kind: 'bottom-follow' });
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
    scrollTop: 220,
  }), anchors[2]);
  assert.equal(nextUserMessageScrollAnchor({
    anchors,
    atBottom: false,
    currentSegmentId: 'user-3',
    scrollTop: 340,
  }), null);
});

test('next-turn navigation selects identity before resolving live reachability', () => {
  const anchors = [
    { contentBottom: 120, contentTop: 60, segmentId: 'user-1', scrollTop: 36, turnId: 'turn-1' },
    { contentBottom: 250, contentTop: 190, segmentId: 'user-2', scrollTop: 166, turnId: 'turn-2' },
    { contentBottom: 380, contentTop: 320, segmentId: 'user-3', scrollTop: 296, turnId: 'turn-3' },
  ];

  assert.deepEqual(nextUserMessageScrollAnchor({
    anchors,
    atBottom: false,
    currentSegmentId: 'user-1',
    scrollTop: 36,
  }), anchors[1]);
  assert.deepEqual(historicalMessageNavigationDestination({
    bottomIfUnreachable: true,
    desiredScrollTop: 166,
    naturalMaxScrollTop: 150,
  }), { kind: 'bottom', scrollTop: 150 });
});

test('next-turn navigation uses only naturally reachable tail destinations', () => {
  const anchors = [
    { contentBottom: 120, contentTop: 60, segmentId: 'user-1', scrollTop: 36, turnId: 'turn-1' },
    { contentBottom: 250, contentTop: 190, segmentId: 'user-2', scrollTop: 166, turnId: 'turn-2' },
  ];

  assert.deepEqual(nextTranscriptNavigationDestination({
    anchors,
    atBottom: false,
    currentSegmentId: 'user-1',
    naturalMaxScrollTop: 150,
    scrollTop: 36,
  }), { kind: 'bottom', scrollTop: 150 }, 'an unreachable later row returns to the natural bottom');
  assert.equal(nextTranscriptNavigationDestination({
    anchors,
    atBottom: false,
    currentSegmentId: 'user-2',
    naturalMaxScrollTop: 150,
    scrollTop: 166,
  }), null, 'synthetic runway alone does not create a destination after the latest row');
  assert.equal(nextTranscriptNavigationDestination({
    anchors,
    atBottom: false,
    currentSegmentId: 'user-1',
    naturalMaxScrollTop: 150,
    scrollTop: 150,
  }), null, 'a stale cursor cannot enable a no-op destination at the natural bottom');
  assert.equal(nextTranscriptNavigationDestination({
    anchors,
    atBottom: false,
    currentSegmentId: 'user-1',
    naturalMaxScrollTop: 150,
    scrollTop: 180,
  }), null, 'a stale cursor beyond the natural bound cannot create a backward Down destination');
  assert.equal(nextTranscriptNavigationDestination({
    anchors,
    atBottom: false,
    naturalContentMaxScrollTop: 150,
    naturalMaxScrollTop: 170,
    scrollTop: 150,
  }), null, 'a fully visible latest row does not turn bottom padding into a destination');
  assert.deepEqual(nextTranscriptNavigationDestination({
    anchors,
    atBottom: false,
    naturalContentMaxScrollTop: 500,
    naturalMaxScrollTop: 520,
    scrollTop: 150,
  }), { anchor: anchors[1], kind: 'message', scrollTop: 166 },
  'growth below an already-visible latest row restores normal forward anchoring');
  assert.equal(nextTranscriptNavigationDestination({
    anchors,
    atBottom: false,
    naturalMaxScrollTop: 150,
    scrollTop: 180,
  }), null, 'free scrolling beyond the natural bound cannot use synthetic extent as a destination');
  assert.deepEqual(nextTranscriptNavigationDestination({
    anchors,
    atBottom: false,
    currentSegmentId: 'user-1',
    naturalMaxScrollTop: 220,
    scrollTop: 36,
  }), { anchor: anchors[1], kind: 'message', scrollTop: 166 }, 'a naturally reachable row keeps exact anchoring');
});

test('restores a compaction viewport anchor after the segment moves to the next turn', () => {
  const segmentId = 'compaction:compact-between';
  const anchor = {
    offset: 7,
    rowId: `turn-1:${segmentId}`,
    segmentId,
    turnId: 'turn-1',
  };

  assert.equal(transcriptViewportAnchorScrollTop(anchor, [
    { rowId: 'turn-1:user:turn-1', scrollTop: 40, segmentId: 'user:turn-1', turnId: 'turn-1' },
    { rowId: `turn-2:${segmentId}`, scrollTop: 320, segmentId, turnId: 'turn-2' },
    { rowId: 'turn-2:user:turn-2', scrollTop: 374, segmentId: 'user:turn-2', turnId: 'turn-2' },
  ]), 327);
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
  let owner = transcriptScrollOwnerAfterNativeEvent('idle', 'touch-start');
  assert.equal(owner, 'native-touch');
  assert.equal(nativeScrollOwnsViewport(owner), true);

  owner = transcriptScrollOwnerAfterNativeEvent(owner, 'touch-end');
  assert.equal(owner, 'native-momentum');
  assert.equal(nativeScrollOwnsViewport(owner), true);

  owner = transcriptScrollOwnerAfterNativeEvent(owner, 'settle');
  assert.equal(owner, 'idle');
  assert.equal(nativeScrollOwnsViewport(owner), false);
});

test('restores bottom stickiness only after native scrolling settles at the bottom', () => {
  assert.deepEqual(viewportIntentAfterNativeScrollSettles({
    currentIntent: { kind: 'free' },
    nearBottom: true,
    userInitiated: true,
  }), { kind: 'bottom-follow' });
  assert.deepEqual(viewportIntentAfterNativeScrollSettles({
    currentIntent: { kind: 'bottom-follow' },
    nearBottom: false,
    userInitiated: true,
  }), { kind: 'free' });
  assert.deepEqual(viewportIntentAfterNativeScrollSettles({
    currentIntent: { kind: 'bottom-follow' },
    nearBottom: false,
    userInitiated: false,
  }), { kind: 'bottom-follow' });
});

test('holds a pinned message anchor with runway after content collapses', () => {
  assert.deepEqual(resolveMessageAnchorScroll({
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

test('keeps an established message anchor pinned when the viewport grows', () => {
  assert.deepEqual(resolveMessageAnchorScroll({
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
  assert.deepEqual(resolveMessageAnchorScroll({
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
  assert.deepEqual(resolveMessageAnchorScroll({
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
    intent: {
      kind: 'message-anchor',
      phase: 'catching-up',
      reason: 'restore',
      segmentId: 'user-1',
      conversationId: 'conversation',
      turnId: 'turn-1',
    },
    scrollTop: 120,
  });
  assert.deepEqual(resolveInitialTranscriptScrollTarget({
    maxScrollTop: 80,
    target: streamingTarget,
  }), {
    intent: streamingTarget?.intent,
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
    intent: { kind: 'bottom-follow' },
    scrollTop: 500,
  });
  assert.deepEqual(resolveInitialTranscriptScrollTarget({ maxScrollTop: 500, target: null }), {
    intent: { kind: 'bottom-follow' },
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

test('uses one geometry index for expanded row, turn, range, and spacer positions', () => {
  const layout = measureCollapsedTranscript({
    turns: [
      frame('turn-1', [user('user-1', 'First'), work('work-1', 'completed')]),
      frame('turn-2', [user('user-2', 'Second'), assistant('assistant-2', 'Done')]),
    ],
    width: 600,
  });
  const workRow = layout.turns[0]?.rows.find((row) => row.segmentId === 'work-1');
  assert.ok(workRow);

  const expandedHeight = 137;
  const geometry = new TranscriptGeometryIndex(layout.turns, [{
    additionalHeight: expandedHeight,
    rowId: workRow.id,
    turnId: 'turn-1',
  }]);
  const secondTurnTop = (layout.turns[1]?.collapsedTop ?? 0) + expandedHeight;

  assert.equal(geometry.heightAfterRow('turn-1', workRow.id), expandedHeight);
  assert.equal(geometry.turnTop(1), secondTurnTop);
  assert.equal(geometry.totalHeight, layout.totalCollapsedHeight + expandedHeight);
  assert.equal(
    geometry.rowPositions().find((row) => row.turnId === 'turn-2')?.scrollTop,
    secondTurnTop,
  );

  const range = computeTranscriptSpacerRange({
    activeTurnIds: ['turn-2'],
    geometry,
    turns: layout.turns,
  });
  assert.equal(range.topSpacerHeight, secondTurnTop);
  assert.equal(range.bottomSpacerHeight, 0);
});

test('opens running work from the authoritative active turn', () => {
  const turn = inProgressFrame('turn-1', [
    user('user-1', 'Please investigate'),
    work('work-1', 'running'),
  ]);
  const layout = measureCollapsedTranscript({ turns: [turn], width: 600 });

  const disclosure = reconcileTranscriptDisclosure(
    emptyTranscriptDisclosureState(),
    layout.turns,
    turn.id,
  );

  assert.equal(disclosure.autoOpenWorkKey, 'turn-1:work-1');
  assert.equal(disclosure.openWorkByKey['turn-1:work-1']?.source, 'auto');
});

test('does not infer an active turn from an in-progress frame', () => {
  const turn = inProgressFrame('turn-1', [
    user('user-1', 'Please investigate'),
    work('work-1', 'running'),
  ]);
  const layout = measureCollapsedTranscript({ turns: [turn], width: 600 });

  const disclosure = reconcileTranscriptDisclosure(
    emptyTranscriptDisclosureState(),
    layout.turns,
    null,
  );

  assert.equal(disclosure.autoOpenWorkKey, null);
  assert.deepEqual(disclosure.openWorkByKey, {});
});

test('a manual close veto prevents streaming deltas from reopening work', () => {
  const turn = inProgressFrame('turn-1', [
    user('user-1', 'Please investigate'),
    work('work-1', 'running'),
  ]);
  const firstLayout = measureCollapsedTranscript({ turns: [turn], width: 600 });
  const autoOpened = reconcileTranscriptDisclosure(
    emptyTranscriptDisclosureState(),
    firstLayout.turns,
    turn.id,
  );
  const closed = toggleWorkDisclosure({
    activeTurnId: turn.id,
    disclosure: autoOpened,
    input: {
      rowId: 'turn-1:work-1',
      segmentId: 'work-1',
      turnId: turn.id,
    },
    turnsById: firstLayout.turnsById,
  });

  const updatedTurn = {
    ...turn,
    renderRevision: 'turn-1:2',
    segments: [turn.segments[0]!, { ...turn.segments[1]!, revision: '2' }],
  };
  const updatedLayout = measureCollapsedTranscript({ turns: [updatedTurn], width: 600 });
  const reconciled = reconcileTranscriptDisclosure(closed, updatedLayout.turns, turn.id);

  assert.equal(reconciled.manuallyClosedAutoWorkByTurnId[turn.id], true);
  assert.equal(reconciled.autoOpenWorkKey, null);
  assert.deepEqual(reconciled.openWorkByKey, {});
});

test('auto-open transfers to replacement running work in the same turn', () => {
  const firstTurn = inProgressFrame('turn-1', [
    user('user-1', 'Please investigate'),
    work('work-1', 'running'),
  ]);
  const firstLayout = measureCollapsedTranscript({ turns: [firstTurn], width: 600 });
  const firstDisclosure = reconcileTranscriptDisclosure(
    emptyTranscriptDisclosureState(),
    firstLayout.turns,
    firstTurn.id,
  );
  const replacementTurn = inProgressFrame('turn-1', [
    user('user-1', 'Please investigate'),
    work('work-1', 'completed'),
    work('work-2', 'running'),
  ]);
  const replacementLayout = measureCollapsedTranscript({ turns: [replacementTurn], width: 600 });

  const disclosure = reconcileTranscriptDisclosure(
    firstDisclosure,
    replacementLayout.turns,
    replacementTurn.id,
  );

  assert.equal(disclosure.autoOpenWorkKey, 'turn-1:work-2');
  assert.equal(disclosure.openWorkByKey['turn-1:work-1'], undefined);
  assert.equal(disclosure.openWorkByKey['turn-1:work-2']?.source, 'auto');
});

test('assistant response closes automatic work but preserves work reopened afterward', () => {
  const workingTurn = inProgressFrame('turn-1', [
    user('user-1', 'Please investigate'),
    work('work-1', 'running'),
  ]);
  const workingLayout = measureCollapsedTranscript({ turns: [workingTurn], width: 600 });
  const autoOpened = reconcileTranscriptDisclosure(
    emptyTranscriptDisclosureState(),
    workingLayout.turns,
    workingTurn.id,
  );
  const respondingTurn = inProgressFrame('turn-1', [
    user('user-1', 'Please investigate'),
    work('work-1', 'completed'),
    assistant('assistant-1', 'Here is what I found.'),
  ]);
  const respondingLayout = measureCollapsedTranscript({ turns: [respondingTurn], width: 600 });
  const closedAtResponse = reconcileTranscriptDisclosure(
    autoOpened,
    respondingLayout.turns,
    respondingTurn.id,
  );
  assert.deepEqual(closedAtResponse.openWorkByKey, {});

  const reopened = toggleWorkDisclosure({
    activeTurnId: respondingTurn.id,
    disclosure: closedAtResponse,
    input: {
      rowId: 'turn-1:work-1',
      segmentId: 'work-1',
      turnId: respondingTurn.id,
    },
    turnsById: respondingLayout.turnsById,
  });
  const refreshed = reconcileTranscriptDisclosure(
    reopened,
    respondingLayout.turns,
    respondingTurn.id,
  );

  assert.equal(refreshed.openWorkByKey['turn-1:work-1']?.source, 'user');
  assert.equal(refreshed.openWorkByKey['turn-1:work-1']?.openedAfterAssistantStarted, true);
});

test('a completed manual-close veto does not suppress work in the next turn', () => {
  const firstTurn = inProgressFrame('turn-1', [user('user-1', 'First'), work('work-1', 'running')]);
  const firstLayout = measureCollapsedTranscript({ turns: [firstTurn], width: 600 });
  const autoOpened = reconcileTranscriptDisclosure(
    emptyTranscriptDisclosureState(),
    firstLayout.turns,
    firstTurn.id,
  );
  const closed = toggleWorkDisclosure({
    activeTurnId: firstTurn.id,
    disclosure: autoOpened,
    input: { rowId: 'turn-1:work-1', segmentId: 'work-1', turnId: firstTurn.id },
    turnsById: firstLayout.turnsById,
  });
  const completedFirstTurn = {
    ...frame('turn-1', [user('user-1', 'First'), work('work-1', 'completed')]),
    renderRevision: 'turn-1:completed',
  };
  const secondTurn = inProgressFrame('turn-2', [user('user-2', 'Second'), work('work-2', 'running')]);
  const nextLayout = measureCollapsedTranscript({
    turns: [completedFirstTurn, secondTurn],
    width: 600,
  });

  const disclosure = reconcileTranscriptDisclosure(closed, nextLayout.turns, secondTurn.id);

  assert.equal(disclosure.manuallyClosedAutoWorkByTurnId['turn-1'], undefined);
  assert.equal(disclosure.autoOpenWorkKey, 'turn-2:work-2');
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

function inProgressFrame(id: string, segments: AgentTurnSegment[]): AgentTurnRenderFrame {
  return {
    ...frame(id, segments),
    completedAt: null,
    durationMs: null,
    status: 'inProgress',
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

function work(
  id: string,
  state: 'running' | 'completed' | 'failed' | 'interrupted',
): AgentTurnSegment {
  return {
    childExecutionCount: 0,
    durationMs: state === 'running' ? null : 1_000,
    id,
    inferenceCount: 1,
    layoutRevision: '1',
    operationCount: 1,
    revision: '1',
    scopeId: `scope:${id}`,
    state,
    type: 'work',
  };
}
