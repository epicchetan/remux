import { expect, test } from '@playwright/test';

import type { CodexTranscriptSegment, CodexTranscriptTurn } from '../shared/transcript';
import { transcriptUserMessageDisclosureKey } from '../viewer/transcript/disclosureKeys';
import { transcriptLayout, userBubbleContentWidth } from '../viewer/transcript/layout/constants';
import { TranscriptMeasureCache } from '../viewer/transcript/layout/measureCache';
import { measureCollapsedTranscript } from '../viewer/transcript/layout/measureCollapsed';
import {
  promoteOpenWorkDisclosure,
  reconcileTranscriptDisclosure,
} from '../viewer/transcript/layoutStore';
import {
  anchorTurnUserMessageScrollTop,
  initialTranscriptScrollTarget,
  transcriptMessageAnchorTopOffset,
} from '../viewer/transcript/virtualizerScroll';
import {
  computeTranscriptSpacerRange,
  computeTranscriptVirtualRange,
  initialTranscriptActiveTurnIds,
  transcriptInitialRenderTurns,
} from '../viewer/transcript/virtualizerRange';

if (typeof globalThis.OffscreenCanvas === 'undefined') {
  globalThis.OffscreenCanvas = class {
    constructor(_width: number, _height: number) {}

    getContext() {
      return {
        measureText: (text: string) => ({ width: text.length * 8 }),
      };
    }
  } as unknown as typeof OffscreenCanvas;
}

test.describe('transcript collapsed layout', () => {
  test('computes row tops and total height from collapsed rows', () => {
    const layout = measureCollapsedTranscript({
      turns: [
        turn('turn-1', compactionSegment('compaction-1')),
        turn('turn-2', workSegment('turn-2:work:0')),
      ],
      width: 600,
    });

    const rows = layout.turns.flatMap((turnLayout) => turnLayout.rows);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      height: transcriptLayout.compaction.dividerHeight + transcriptLayout.row.defaultGap,
    });
    expect(layout.turns[1]?.collapsedTop).toBe(layout.turns[0]!.collapsedHeight);
    expect(layout.totalCollapsedHeight).toBe(
      rows.reduce((total, row) => total + row.height, 0),
    );
  });

  test('groups collapsed rows by turn with prefix heights', () => {
    const layout = measureCollapsedTranscript({
      turns: [
        turn('turn-1', compactionSegment('compaction-1'), workSegment('turn-1:work:0')),
        turn('turn-2', compactionSegment('compaction-2')),
      ],
      width: 600,
    });

    expect(layout.turns).toHaveLength(2);
    expect(layout.turns[0]).toMatchObject({
      collapsedTop: 0,
      turnId: 'turn-1',
    });
    expect(layout.turns[0]?.rows.map((row) => row.id)).toEqual(['turn-1:compaction-1', 'turn-1:turn-1:work:0']);
    expect(layout.turns[0]?.collapsedHeight).toBe(
      layout.turns[0]!.rows.reduce((total, row) => total + row.height, 0),
    );
    expect(layout.turns[1]?.collapsedTop).toBe(
      layout.turns[0]!.collapsedTop + layout.turns[0]!.collapsedHeight,
    );
  });

  test('reserves fixed user action height only for the latest user message', () => {
    const layout = measureCollapsedTranscript({
      turns: [
        turn('turn-1', userSegment('user-1', 'hello')),
        turn('turn-2', userSegment('user-2', 'hello')),
      ],
      width: 600,
    });

    const firstRow = layout.turns[0]!.rows[0]!;
    const latestRow = layout.turns[1]!.rows[0]!;

    expect(firstRow.showUserActions).toBe(false);
    expect(latestRow.showUserActions).toBe(true);
    expect(latestRow.height - firstRow.height).toBe(
      transcriptLayout.user.actionTopGap + transcriptLayout.user.actionHeight,
    );
  });

  test('shows latest user actions even when the message has unsupported edit content', () => {
    const layout = measureCollapsedTranscript({
      turns: [
        turn('turn-1', userTextSegment('user-1', 'hello')),
        turn('turn-2', userLocalImageSegment('user-2')),
      ],
      width: 600,
    });

    const firstRow = layout.turns[0]!.rows[0]!;
    const latestRow = layout.turns[1]!.rows[0]!;

    expect(firstRow.showUserActions).toBe(false);
    expect(latestRow.showUserActions).toBe(true);
  });

  test('measures top-level user markdown at full row width', () => {
    const topLevelWidth = userBubbleContentWidth(600, 'topLevel');
    const workWidth = userBubbleContentWidth(600, 'work');

    expect(topLevelWidth).toBe(
      600 -
        transcriptLayout.user.bubblePaddingX * 2 -
        transcriptLayout.user.bubbleBorderWidth * 2,
    );
    expect(topLevelWidth).toBeGreaterThan(workWidth);
  });

  test('measures user attachment rail as part of one message bubble', () => {
    const textOnlyLayout = measureCollapsedTranscript({
      turns: [
        turn('turn-1', userTextSegment('user-1', 'hello')),
      ],
      width: 600,
    });
    const attachmentLayout = measureCollapsedTranscript({
      turns: [
        turn('turn-1', userTextSegmentWithImage('user-1', 'hello')),
      ],
      width: 600,
    });

    expect(attachmentLayout.turns[0]!.rows[0]!.height - textOnlyLayout.turns[0]!.rows[0]!.height).toBe(
      transcriptLayout.user.railCardHeight + transcriptLayout.user.bubbleGap,
    );
  });

  test('collapses long user messages to the configured rendered line cap', () => {
    const userTurn = turn('turn-1', userTextSegment('user-1', longParagraph(160)));
    const collapsedLayout = measureCollapsedTranscript({
      turns: [userTurn],
      width: 600,
    });
    const disclosureKey = transcriptUserMessageDisclosureKey('turn-1', 'user-1');
    const expandedLayout = measureCollapsedTranscript({
      expandedUserMessageByKey: { [disclosureKey]: true },
      turns: [userTurn],
      width: 600,
    });
    const collapsedRow = collapsedLayout.turns[0]!.rows[0]!;
    const expandedRow = expandedLayout.turns[0]!.rows[0]!;

    expect(collapsedRow.userMessageDisclosure).toEqual({
      collapsible: true,
      expanded: false,
      maxLines: transcriptLayout.user.collapsedBodyLines,
    });
    expect(expandedRow.userMessageDisclosure).toEqual({
      collapsible: true,
      expanded: true,
      maxLines: transcriptLayout.user.collapsedBodyLines,
    });
    expect(collapsedRow.height).toBeLessThan(expandedRow.height);
  });

  test('does not add disclosure to short user messages', () => {
    const layout = measureCollapsedTranscript({
      turns: [
        turn('turn-1', userTextSegment('user-1', shortLines(transcriptLayout.user.collapsedBodyLines))),
      ],
      width: 600,
    });

    expect(layout.turns[0]!.rows[0]!.userMessageDisclosure).toBeUndefined();
  });

  test('shows user actions on the latest user message while that turn is running', () => {
    const runningTurn = turn('turn-2', userSegment('user-2', 'hello'));
    runningTurn.status = 'inProgress';
    const layout = measureCollapsedTranscript({
      turns: [
        turn('turn-1', userSegment('user-1', 'hello')),
        runningTurn,
      ],
      width: 600,
    });

    expect(layout.turns.flatMap((turnLayout) => turnLayout.rows).map((row) => row.showUserActions)).toEqual([
      false,
      true,
    ]);
  });

  test('keeps latest user action height stable when the turn completes', () => {
    const runningTurn = turn('turn-1', userSegment('user-1', 'hello'));
    runningTurn.status = 'inProgress';
    const completedTurn = {
      ...runningTurn,
      completedAt: 1782000001000,
      durationMs: 1000,
      revision: 'turn-1-completed-revision',
      status: 'completed' as const,
    };

    const runningRow = measureCollapsedTranscript({ turns: [runningTurn], width: 600 }).turns[0]!.rows[0]!;
    const completedRow = measureCollapsedTranscript({ turns: [completedTurn], width: 600 }).turns[0]!.rows[0]!;

    expect(runningRow.showUserActions).toBe(true);
    expect(completedRow.showUserActions).toBe(true);
    expect(runningRow.height).toBe(completedRow.height);
  });

  test('does not fall back to previous user actions when the latest turn has no user message', () => {
    const runningWorkTurn = turn('turn-2', workSegment('work-1', { state: 'running' }));
    runningWorkTurn.status = 'inProgress';
    const layout = measureCollapsedTranscript({
      turns: [
        turn('turn-1', userSegment('user-1', 'hello')),
        runningWorkTurn,
      ],
      width: 600,
    });

    expect(layout.turns.flatMap((turnLayout) => turnLayout.rows).map((row) => row.showUserActions)).toEqual([
      false,
      false,
    ]);
  });

  test('reserves fixed assistant action height for every completed assistant message', () => {
    const layout = measureCollapsedTranscript({
      turns: [
        turn('turn-1', assistantSegment('assistant-1', 'first')),
        turn('turn-2', assistantSegment('assistant-2', 'latest')),
      ],
      width: 600,
    });

    const firstRow = layout.turns[0]!.rows[0]!;
    const latestRow = layout.turns[1]!.rows[0]!;

    expect(firstRow.showAssistantActions).toBe(true);
    expect(latestRow.showAssistantActions).toBe(true);
    expect(latestRow.height).toBe(firstRow.height);
  });

  test('skips empty assistant messages when reserving assistant action height', () => {
    const layout = measureCollapsedTranscript({
      turns: [
        turn('turn-1', assistantSegment('assistant-1', 'hello'), assistantSegment('assistant-2', '')),
      ],
      width: 600,
    });

    const assistantRow = layout.turns[0]!.rows[0]!;
    const emptyAssistantRow = layout.turns[0]!.rows[1]!;

    expect(assistantRow.showAssistantActions).toBe(true);
    expect(emptyAssistantRow.showAssistantActions).toBe(false);
  });

  test('keeps completed assistant actions while hiding running assistant actions', () => {
    const completedTurn = turn('turn-1', assistantSegment('assistant-1', 'hello'));
    const runningTurn = turn('turn-2', assistantSegment('assistant-2', 'hello'));
    runningTurn.status = 'inProgress';
    const layout = measureCollapsedTranscript({
      turns: [completedTurn, runningTurn],
      width: 600,
    });

    const completedRow = layout.turns[0]!.rows[0]!;
    const runningRow = layout.turns[1]!.rows[0]!;

    expect(completedRow.showAssistantActions).toBe(true);
    expect(runningRow.showAssistantActions).toBe(false);
  });

  test('reuses cached measurements for unchanged turn revisions', () => {
    const cache = new TranscriptMeasureCache();
    const firstTurn = turn('turn-1', assistantSegment('assistant-1', 'hello'));
    const secondTurn = turn('turn-2', compactionSegment('compaction-2'));

    measureCollapsedTranscript({
      cache,
      threadId: 'thread-1',
      turns: [firstTurn, secondTurn],
      width: 600,
    });

    const refreshedFirstTurn = {
      ...firstTurn,
      segments: firstTurn.segments.map((segment) => ({ ...segment })),
    };
    const refreshedSecondTurn = {
      ...secondTurn,
      segments: secondTurn.segments.map((segment) => ({ ...segment })),
    };
    const layout = measureCollapsedTranscript({
      cache,
      threadId: 'thread-1',
      turns: [refreshedFirstTurn, refreshedSecondTurn],
      width: 600,
    });

    expect(cache.stats()).toMatchObject({ entries: 2, hits: 2, misses: 2 });
    expect(layout.turns[0]!.rows[0]!.turn).toBe(refreshedFirstTurn);
    expect(layout.turns[0]!.rows[0]!.segment).toBe(refreshedFirstTurn.segments[0]);
  });

  test('invalidates measurements when width changes', () => {
    const cache = new TranscriptMeasureCache();
    const turns = [turn('turn-1', assistantSegment('assistant-1', 'hello'))];

    measureCollapsedTranscript({ cache, threadId: 'thread-1', turns, width: 600 });
    measureCollapsedTranscript({ cache, threadId: 'thread-1', turns, width: 610 });

    expect(cache.stats()).toMatchObject({ entries: 2, hits: 0, misses: 2 });
  });

  test('only invalidates affected user action turns when the latest user action row changes', () => {
    const cache = new TranscriptMeasureCache();
    const firstTurn = turn('turn-1', userSegment('user-1', 'first'));
    const secondTurn = turn('turn-2', userSegment('user-2', 'second'));
    const thirdTurn = turn('turn-3', userSegment('user-3', 'third'));

    measureCollapsedTranscript({
      cache,
      threadId: 'thread-1',
      turns: [firstTurn, secondTurn],
      width: 600,
    });
    const layout = measureCollapsedTranscript({
      cache,
      threadId: 'thread-1',
      turns: [firstTurn, secondTurn, thirdTurn],
      width: 600,
    });

    expect(cache.stats()).toMatchObject({ hits: 1, misses: 4 });
    expect(layout.turns[0]!.rows[0]!.showUserActions).toBe(false);
    expect(layout.turns[1]!.rows[0]!.showUserActions).toBe(false);
    expect(layout.turns[2]!.rows[0]!.showUserActions).toBe(true);
  });

  test('reuses assistant action measurements when new completed assistant rows are added', () => {
    const cache = new TranscriptMeasureCache();
    const firstTurn = turn('turn-1', assistantSegment('assistant-1', 'first'));
    const secondTurn = turn('turn-2', assistantSegment('assistant-2', 'second'));
    const thirdTurn = turn('turn-3', assistantSegment('assistant-3', 'third'));

    measureCollapsedTranscript({
      cache,
      threadId: 'thread-1',
      turns: [firstTurn, secondTurn],
      width: 600,
    });
    const layout = measureCollapsedTranscript({
      cache,
      threadId: 'thread-1',
      turns: [firstTurn, secondTurn, thirdTurn],
      width: 600,
    });

    expect(cache.stats()).toMatchObject({ hits: 2, misses: 3 });
    expect(layout.turns[0]!.rows[0]!.showAssistantActions).toBe(true);
    expect(layout.turns[1]!.rows[0]!.showAssistantActions).toBe(true);
    expect(layout.turns[2]!.rows[0]!.showAssistantActions).toBe(true);
  });
});

test.describe('transcript work disclosure', () => {
  test('auto-opens running work and collapses it when the turn completes', () => {
    const runningTurn = turn('turn-1', workSegment('work-1', { state: 'running' }));
    runningTurn.status = 'inProgress';
    const runningLayout = measureCollapsedTranscript({ turns: [runningTurn], width: 600 });

    const opened = reconcileTranscriptDisclosure(emptyDisclosure(), runningLayout.turns);

    expect(opened.openWorkByKey['turn-1:work-1']).toMatchObject({
      key: 'turn-1:work-1',
      rowId: 'turn-1:work-1',
      segmentId: 'work-1',
      source: 'auto',
      turnId: 'turn-1',
    });

    const completedTurn = turn('turn-1', workSegment('work-1', { state: 'completed' }), assistantSegment('assistant-1', 'done'));
    const completedLayout = measureCollapsedTranscript({ turns: [completedTurn], width: 600 });

    expect(reconcileTranscriptDisclosure(opened, completedLayout.turns).openWorkByKey).toEqual({});
  });

  test('collapses auto-open work when assistant streaming starts in managed scroll mode', () => {
    const runningTurn = turn('turn-1', workSegment('work-1', { state: 'running' }));
    runningTurn.status = 'inProgress';
    const runningLayout = measureCollapsedTranscript({ turns: [runningTurn], width: 600 });
    const opened = reconcileTranscriptDisclosure(emptyDisclosure(), runningLayout.turns, 'turn-1');

    const streamingAnswerTurn = turn(
      'turn-1',
      workSegment('work-1', { state: 'running' }),
      assistantSegment('assistant-1', 'streaming answer'),
    );
    streamingAnswerTurn.status = 'inProgress';
    const streamingAnswerLayout = measureCollapsedTranscript({ turns: [streamingAnswerTurn], width: 600 });

    expect(reconcileTranscriptDisclosure(opened, streamingAnswerLayout.turns, 'turn-1', {
      autoWorkManaged: true,
    }).openWorkByKey).toEqual({});
  });

  test('preserves auto-open work before assistant streaming starts in managed scroll mode', () => {
    const runningTurn = turn('turn-1', workSegment('work-1', { state: 'running' }));
    runningTurn.status = 'inProgress';
    const runningLayout = measureCollapsedTranscript({ turns: [runningTurn], width: 600 });
    const opened = reconcileTranscriptDisclosure(emptyDisclosure(), runningLayout.turns, 'turn-1');

    const waitingTurn = turn('turn-1', workSegment('work-1', { state: 'completed' }));
    waitingTurn.status = 'inProgress';
    const waitingLayout = measureCollapsedTranscript({ turns: [waitingTurn], width: 600 });
    const reconciled = reconcileTranscriptDisclosure(opened, waitingLayout.turns, 'turn-1', {
      autoWorkManaged: true,
    });

    expect(reconciled.openWorkByKey['turn-1:work-1']).toMatchObject({
      rowId: 'turn-1:work-1',
      source: 'auto',
      turnId: 'turn-1',
    });
  });

  test('collapses previous auto-open work when assistant streaming starts after manual scroll break', () => {
    const runningTurn = turn('turn-1', workSegment('work-1', { state: 'running' }));
    runningTurn.status = 'inProgress';
    const runningLayout = measureCollapsedTranscript({ turns: [runningTurn], width: 600 });
    const opened = reconcileTranscriptDisclosure(emptyDisclosure(), runningLayout.turns, 'turn-1');

    const streamingAnswerTurn = turn(
      'turn-1',
      workSegment('work-1', { state: 'completed' }),
      assistantSegment('assistant-1', 'streaming answer'),
    );
    streamingAnswerTurn.status = 'inProgress';
    const streamingAnswerLayout = measureCollapsedTranscript({ turns: [streamingAnswerTurn], width: 600 });
    const reconciled = reconcileTranscriptDisclosure(opened, streamingAnswerLayout.turns, 'turn-1', {
      autoWorkManaged: false,
    });

    expect(reconciled.autoOpenWorkKey).toBeNull();
    expect(reconciled.openWorkByKey).toEqual({});
  });

  test('collapses previous auto-open work when the turn completes after manual scroll break', () => {
    const runningTurn = turn('turn-1', workSegment('work-1', { state: 'running' }));
    runningTurn.status = 'inProgress';
    const runningLayout = measureCollapsedTranscript({ turns: [runningTurn], width: 600 });
    const opened = reconcileTranscriptDisclosure(emptyDisclosure(), runningLayout.turns, 'turn-1');

    const completedTurn = turn(
      'turn-1',
      workSegment('work-1', { state: 'completed' }),
      assistantSegment('assistant-1', 'done'),
    );
    const completedLayout = measureCollapsedTranscript({ turns: [completedTurn], width: 600 });
    const reconciled = reconcileTranscriptDisclosure(opened, completedLayout.turns, null, {
      autoWorkManaged: false,
    });

    expect(reconciled.autoOpenWorkKey).toBeNull();
    expect(reconciled.openWorkByKey).toEqual({});
  });

  test('does not create new auto-open work after manual scroll break', () => {
    const runningTurn = turn('turn-1', workSegment('work-1', { state: 'running' }));
    runningTurn.status = 'inProgress';
    const runningLayout = measureCollapsedTranscript({ turns: [runningTurn], width: 600 });

    const disclosure = reconcileTranscriptDisclosure(emptyDisclosure(), runningLayout.turns, 'turn-1', {
      autoWorkManaged: false,
    });

    expect(disclosure.openWorkByKey).toEqual({});
  });

  test('preserves previous auto-open work with child disclosure after manual scroll break', () => {
    const runningTurn = turn('turn-1', workSegment('work-1', { state: 'running' }));
    runningTurn.status = 'inProgress';
    const runningLayout = measureCollapsedTranscript({ turns: [runningTurn], width: 600 });
    const opened = reconcileTranscriptDisclosure(emptyDisclosure(), runningLayout.turns, 'turn-1');

    const openedWithChild = {
      ...opened,
      openWorkByKey: {
        ...opened.openWorkByKey,
        'turn-1:work-1': {
          ...opened.openWorkByKey['turn-1:work-1']!,
          openChildByKey: { 'tool:1': true },
        },
      },
    };
    const streamingAnswerTurn = turn(
      'turn-1',
      workSegment('work-1', { state: 'completed' }),
      assistantSegment('assistant-1', 'streaming answer'),
    );
    streamingAnswerTurn.status = 'inProgress';
    const streamingAnswerLayout = measureCollapsedTranscript({ turns: [streamingAnswerTurn], width: 600 });

    const reconciled = reconcileTranscriptDisclosure(openedWithChild, streamingAnswerLayout.turns, 'turn-1', {
      autoWorkManaged: false,
    });

    expect(reconciled.autoOpenWorkKey).toBeNull();
    expect(reconciled.openWorkByKey['turn-1:work-1']).toMatchObject({
      openChildByKey: { 'tool:1': true },
      rowId: 'turn-1:work-1',
      source: 'user',
      turnId: 'turn-1',
    });
  });

  test('preserves auto-open work promoted by child interaction when assistant streaming starts', () => {
    const runningTurn = turn('turn-1', workSegment('work-1', { state: 'running' }));
    runningTurn.status = 'inProgress';
    const runningLayout = measureCollapsedTranscript({ turns: [runningTurn], width: 600 });

    const opened = reconcileTranscriptDisclosure(emptyDisclosure(), runningLayout.turns, 'turn-1');
    const promoted = promoteOpenWorkDisclosure({
      ...opened,
      openWorkByKey: {
        ...opened.openWorkByKey,
        'turn-1:work-1': {
          ...opened.openWorkByKey['turn-1:work-1']!,
          openChildByKey: { 'tool:1': true },
        },
      },
    }, 'turn-1:work-1');

    expect(promoted.autoOpenWorkKey).toBeNull();
    expect(promoted.openWorkByKey['turn-1:work-1']).toMatchObject({
      openChildByKey: { 'tool:1': true },
      source: 'user',
    });

    const streamingAnswerTurn = turn(
      'turn-1',
      workSegment('work-1', { state: 'completed' }),
      assistantSegment('assistant-1', 'streaming answer'),
    );
    streamingAnswerTurn.status = 'inProgress';
    const streamingAnswerLayout = measureCollapsedTranscript({ turns: [streamingAnswerTurn], width: 600 });

    const reconciled = reconcileTranscriptDisclosure(promoted, streamingAnswerLayout.turns, 'turn-1');

    expect(reconciled.openWorkByKey['turn-1:work-1']).toMatchObject({
      openChildByKey: { 'tool:1': true },
      rowId: 'turn-1:work-1',
      source: 'user',
      turnId: 'turn-1',
    });
  });

  test('does not auto-reopen running work after the user closes that turn', () => {
    const runningTurn = turn('turn-1', workSegment('work-1', { state: 'running' }));
    runningTurn.status = 'inProgress';
    const layout = measureCollapsedTranscript({ turns: [runningTurn], width: 600 });

    const disclosure = reconcileTranscriptDisclosure({
      autoOpenWorkKey: null,
      expandedUserMessageByKey: {},
      manuallyClosedAutoWorkByTurnId: { 'turn-1': true },
      openWorkByKey: {},
    }, layout.turns);

    expect(disclosure.openWorkByKey).toEqual({});
    expect(disclosure.manuallyClosedAutoWorkByTurnId).toEqual({ 'turn-1': true });
  });

  test('preserves user-opened work across transcript refreshes', () => {
    const initialLayout = measureCollapsedTranscript({
      turns: [turn('turn-1', workSegment('work-1'))],
      width: 600,
    });
    const refreshedLayout = measureCollapsedTranscript({
      turns: [turn('turn-1', workSegment('work-1', { revision: 'refreshed' }))],
      width: 600,
    });

    const disclosure = reconcileTranscriptDisclosure({
      autoOpenWorkKey: null,
      expandedUserMessageByKey: {},
      manuallyClosedAutoWorkByTurnId: {},
      openWorkByKey: {
        'turn-1:work-1': {
          additionalHeight: 120,
          key: 'turn-1:work-1',
          openChildByKey: { child: true },
          rowId: initialLayout.turns[0]!.rows[0]!.id,
          segmentId: 'work-1',
          source: 'user',
          turnId: 'turn-1',
        },
      },
    }, refreshedLayout.turns);

    expect(disclosure.openWorkByKey['turn-1:work-1']).toMatchObject({
      additionalHeight: 120,
      key: 'turn-1:work-1',
      openChildByKey: { child: true },
      rowId: 'turn-1:work-1',
      segmentId: 'work-1',
      source: 'user',
      turnId: 'turn-1',
    });
  });

  test('auto-opens running work alongside another user-opened section', () => {
    const runningTurn = turn('turn-2', workSegment('work-2', { state: 'running' }));
    runningTurn.status = 'inProgress';
    const layout = measureCollapsedTranscript({
      turns: [
        turn('turn-1', workSegment('work-1')),
        runningTurn,
      ],
      width: 600,
    });

    const disclosure = reconcileTranscriptDisclosure({
      autoOpenWorkKey: null,
      expandedUserMessageByKey: {},
      manuallyClosedAutoWorkByTurnId: {},
      openWorkByKey: {
        'turn-1:work-1': {
          additionalHeight: 80,
          key: 'turn-1:work-1',
          openChildByKey: {},
          rowId: 'turn-1:work-1',
          segmentId: 'work-1',
          source: 'user',
          turnId: 'turn-1',
        },
      },
    }, layout.turns);

    expect(disclosure.openWorkByKey['turn-1:work-1']).toMatchObject({
      rowId: 'turn-1:work-1',
      source: 'user',
      turnId: 'turn-1',
    });
    expect(disclosure.openWorkByKey['turn-2:work-2']).toMatchObject({
      rowId: 'turn-2:work-2',
      source: 'auto',
      turnId: 'turn-2',
    });
  });

  test('runtime active turn can suppress transcript-only in-progress auto-open', () => {
    const runningTurn = turn('turn-1', workSegment('work-1', { state: 'running' }));
    runningTurn.status = 'inProgress';
    const layout = measureCollapsedTranscript({
      turns: [runningTurn],
      width: 600,
    });

    const disclosure = reconcileTranscriptDisclosure(emptyDisclosure(), layout.turns, null);

    expect(disclosure.openWorkByKey).toEqual({});
  });

  test('does not auto-open completed work in an in-progress turn', () => {
    const streamingAnswerTurn = turn(
      'turn-1',
      workSegment('work-1', { state: 'completed' }),
      assistantSegment('assistant-1', 'streaming answer'),
    );
    streamingAnswerTurn.status = 'inProgress';
    const layout = measureCollapsedTranscript({
      turns: [streamingAnswerTurn],
      width: 600,
    });

    const disclosure = reconcileTranscriptDisclosure(emptyDisclosure(), layout.turns, 'turn-1');

    expect(disclosure.openWorkByKey).toEqual({});
  });

  test('runtime active turn selects which in-progress work auto-opens', () => {
    const firstRunningTurn = turn('turn-1', workSegment('work-1', { state: 'running' }));
    firstRunningTurn.status = 'inProgress';
    const secondRunningTurn = turn('turn-2', workSegment('work-2', { state: 'running' }));
    secondRunningTurn.status = 'inProgress';
    const layout = measureCollapsedTranscript({
      turns: [firstRunningTurn, secondRunningTurn],
      width: 600,
    });

    const disclosure = reconcileTranscriptDisclosure(emptyDisclosure(), layout.turns, 'turn-2');

    expect(disclosure.openWorkByKey['turn-1:work-1']).toBeUndefined();
    expect(disclosure.openWorkByKey['turn-2:work-2']).toMatchObject({
      rowId: 'turn-2:work-2',
      source: 'auto',
      turnId: 'turn-2',
    });
  });

  test('preserves multiple user-opened work sections across transcript refreshes', () => {
    const initialLayout = measureCollapsedTranscript({
      turns: [
        turn('turn-1', workSegment('work-1')),
        turn('turn-2', workSegment('work-2')),
      ],
      width: 600,
    });
    const refreshedLayout = measureCollapsedTranscript({
      turns: [
        turn('turn-1', workSegment('work-1', { revision: 'refreshed' })),
        turn('turn-2', workSegment('work-2', { revision: 'refreshed' })),
      ],
      width: 600,
    });

    const disclosure = reconcileTranscriptDisclosure({
      autoOpenWorkKey: null,
      expandedUserMessageByKey: {},
      manuallyClosedAutoWorkByTurnId: {},
      openWorkByKey: {
        'turn-1:work-1': {
          additionalHeight: 120,
          key: 'turn-1:work-1',
          openChildByKey: { child: true },
          rowId: initialLayout.turns[0]!.rows[0]!.id,
          segmentId: 'work-1',
          source: 'user',
          turnId: 'turn-1',
        },
        'turn-2:work-2': {
          additionalHeight: 64,
          key: 'turn-2:work-2',
          openChildByKey: {},
          rowId: initialLayout.turns[1]!.rows[0]!.id,
          segmentId: 'work-2',
          source: 'user',
          turnId: 'turn-2',
        },
      },
    }, refreshedLayout.turns);

    expect(disclosure.openWorkByKey['turn-1:work-1']).toMatchObject({
      additionalHeight: 120,
      rowId: 'turn-1:work-1',
    });
    expect(disclosure.openWorkByKey['turn-2:work-2']).toMatchObject({
      additionalHeight: 64,
      rowId: 'turn-2:work-2',
    });
  });
});

test.describe('transcript virtualizer range', () => {
  test('selects overscanned turns around the current scroll window', () => {
    const layout = measureCollapsedTranscript({
      turns: Array.from({ length: 10 }, (_, index) => turn(`turn-${index}`, compactionSegment(`compaction-${index}`))),
      width: 600,
    });

    const range = computeTranscriptVirtualRange({
      overscanTurns: 1,
      scrollTop: transcriptLayout.viewport.padY + 160,
      topPadding: transcriptLayout.viewport.padY,
      turns: layout.turns,
      viewportHeight: 10,
    });

    expect(range.activeTurnIds).toEqual(['turn-2', 'turn-3', 'turn-4', 'turn-5']);
    expect(range.topSpacerHeight).toBe(80);
    expect(range.bottomSpacerHeight).toBe(160);
  });

  test('omits the top spacer when rendering starts with the first turn', () => {
    const layout = measureCollapsedTranscript({
      turns: Array.from({ length: 5 }, (_, index) => turn(`turn-${index}`, compactionSegment(`compaction-${index}`))),
      width: 600,
    });

    const range = computeTranscriptVirtualRange({
      overscanTurns: 1,
      scrollTop: transcriptLayout.viewport.padY,
      topPadding: transcriptLayout.viewport.padY,
      turns: layout.turns,
      viewportHeight: 10,
    });

    expect(range.activeTurnIds).toEqual(['turn-0', 'turn-1']);
    expect(range.topSpacerHeight).toBe(0);
    expect(range.bottomSpacerHeight).toBeGreaterThan(0);
  });

  test('uses a bounded bottom-biased initial render window', () => {
    const layout = measureCollapsedTranscript({
      turns: Array.from({ length: 50 }, (_, index) => turn(`turn-${index}`, compactionSegment(`compaction-${index}`))),
      width: 600,
    });

    expect(initialTranscriptActiveTurnIds(layout.turns)).toHaveLength(transcriptInitialRenderTurns);
    expect(initialTranscriptActiveTurnIds(layout.turns)[0]).toBe(`turn-${50 - transcriptInitialRenderTurns}`);
  });

  test('accounts for an expanded work row outside the rendered range', () => {
    const layout = measureCollapsedTranscript({
      turns: Array.from({ length: 5 }, (_, index) => turn(`turn-${index}`, compactionSegment(`compaction-${index}`))),
      width: 600,
    });

    const range = computeTranscriptSpacerRange({
      activeTurnIds: ['turn-3', 'turn-4'],
      expandedRows: [
        {
          additionalHeight: 75,
          rowId: 'turn-1:compaction-1',
          turnId: 'turn-1',
        },
      ],
      turns: layout.turns,
    });

    expect(range.topSpacerHeight).toBe(layout.turns[3]!.collapsedTop + 75);
    expect(range.bottomSpacerHeight).toBe(0);
  });

  test('accounts for multiple expanded rows before the rendered range', () => {
    const layout = measureCollapsedTranscript({
      turns: Array.from({ length: 6 }, (_, index) => turn(`turn-${index}`, compactionSegment(`compaction-${index}`))),
      width: 600,
    });

    const range = computeTranscriptSpacerRange({
      activeTurnIds: ['turn-4', 'turn-5'],
      expandedRows: [
        {
          additionalHeight: 75,
          rowId: 'turn-1:compaction-1',
          turnId: 'turn-1',
        },
        {
          additionalHeight: 25,
          rowId: 'turn-3:compaction-3',
          turnId: 'turn-3',
        },
      ],
      turns: layout.turns,
    });

    expect(range.topSpacerHeight).toBe(layout.turns[4]!.collapsedTop + 100);
    expect(range.bottomSpacerHeight).toBe(0);
  });
});

test.describe('transcript virtualizer scroll targets', () => {
  test('uses safe-area-aware offset for sent message targets', () => {
    const layout = measureCollapsedTranscript({
      turns: [
        turn('turn-1', userTextSegment('user-1', 'first')),
        turn('turn-2', userTextSegment('user-2', 'second')),
      ],
      width: 600,
    });
    const rowTop = layout.turns[1]!.collapsedTop;

    expect(transcriptMessageAnchorTopOffset(20)).toBe(24);
    expect(transcriptMessageAnchorTopOffset(44)).toBe(44);
    expect(anchorTurnUserMessageScrollTop({
      expandedRows: [],
      topPadding: 20,
      turnId: 'turn-2',
      turns: layout.turns,
    })).toBe(rowTop - 4);
    expect(anchorTurnUserMessageScrollTop({
      expandedRows: [],
      topPadding: 44,
      turnId: 'turn-2',
      turns: layout.turns,
    })).toBe(rowTop);
  });

  test('initial scroll target prefers active streaming turn then last user message', () => {
    expect(initialTranscriptScrollTarget({
      anchors: [
        { scrollTop: 10, turnId: 'turn-1' },
        { scrollTop: 40, turnId: 'turn-2' },
      ],
      streamingTurnId: 'turn-1',
    })).toEqual({
      mode: { type: 'sent-message-anchor', turnId: 'turn-1' },
      scrollTop: 10,
    });

    expect(initialTranscriptScrollTarget({
      anchors: [
        { scrollTop: 10, turnId: 'turn-1' },
        { scrollTop: 40, turnId: 'turn-2' },
      ],
      streamingTurnId: null,
    })).toEqual({
      mode: { type: 'off' },
      scrollTop: 40,
    });

    expect(initialTranscriptScrollTarget({
      anchors: [
        { scrollTop: 10, turnId: 'turn-1' },
        { scrollTop: 40, turnId: 'turn-2' },
      ],
      streamingTurnId: 'turn-3',
    })).toEqual({
      mode: { type: 'off' },
      scrollTop: 40,
    });
  });
});

function turn(id: string, ...segments: CodexTranscriptSegment[]): CodexTranscriptTurn {
  return {
    completedAt: null,
    durationMs: null,
    error: null,
    id,
    revision: `turn:${id}:${segments.map((segment) => segment.revision).join('|')}`,
    segments,
    startedAt: 1,
    status: 'completed',
  };
}

function emptyDisclosure() {
  return {
    autoOpenWorkKey: null,
    expandedUserMessageByKey: {},
    manuallyClosedAutoWorkByTurnId: {},
    openWorkByKey: {},
  };
}

function workSegment(
  id: string,
  options: { revision?: string; state?: Extract<CodexTranscriptSegment, { type: 'work' }>['state'] } = {},
): CodexTranscriptSegment {
  return {
    durationMs: null,
    hasDetails: true,
    id,
    revision: `work:${id}:${options.revision ?? options.state ?? 'default'}`,
    state: options.state ?? 'completed',
    type: 'work',
  };
}

function compactionSegment(id: string): CodexTranscriptSegment {
  return {
    id,
    revision: `compaction:${id}`,
    status: 'compacted',
    type: 'compaction',
  };
}

function userSegment(id: string, text: string): CodexTranscriptSegment {
  return {
    content: [{
      name: text,
      path: `${text}.ts`,
      type: 'mention',
    }],
    id,
    revision: `user:${id}:${text}`,
    type: 'userMessage',
  };
}

function userTextSegment(id: string, text: string): CodexTranscriptSegment {
  return {
    content: [{
      text,
      text_elements: [],
      type: 'text',
    }],
    id,
    revision: `user:${id}:${text}`,
    type: 'userMessage',
  };
}

function userTextSegmentWithImage(id: string, text: string): CodexTranscriptSegment {
  return {
    content: [
      {
        text,
        text_elements: [],
        type: 'text',
      },
      {
        url: 'data:image/png;base64,abc',
        type: 'image',
      },
    ],
    id,
    revision: `user:${id}:${text}:image`,
    type: 'userMessage',
  };
}

function longParagraph(wordCount: number) {
  return Array.from({ length: wordCount }, (_, index) => `word${index}`).join(' ');
}

function shortLines(lineCount: number) {
  return Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`).join('\n\n');
}

function userLocalImageSegment(id: string): CodexTranscriptSegment {
  return {
    content: [
      {
        path: '/tmp/photo.png',
        type: 'localImage',
      },
    ],
    id,
    revision: `user:${id}:local-image`,
    type: 'userMessage',
  };
}

function assistantSegment(id: string, text: string): CodexTranscriptSegment {
  return {
    id,
    phase: null,
    revision: `assistant:${id}:${text}`,
    text,
    type: 'assistantMessage',
  };
}
