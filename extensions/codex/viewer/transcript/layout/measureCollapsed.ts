import type { CodexTranscriptSegment, CodexTranscriptTurn } from '../../../shared/transcript';
import {
  measureMarkdownDocumentCappedHeight,
  measureMarkdownDocumentHeight,
} from '../components/markdown/markdownModel';
import { transcriptUserMessageDisclosureKey } from '../disclosureKeys';
import { buildUserMessageLayout } from '../model/userMessageContent';
import { transcriptLayout, userBubbleContentWidth } from './constants';
import type {
  TranscriptMeasureCache,
  TranscriptMeasureCacheValue,
} from './measureCache';
import type {
  TranscriptMeasuredLayout,
  TranscriptMeasuredRow,
  TranscriptMeasuredTurn,
  TranscriptUserMessageDisclosure,
} from './types';

export function measureCollapsedTranscript({
  cache,
  expandedUserMessageByKey = {},
  threadId,
  turns,
  width,
}: {
  cache?: TranscriptMeasureCache;
  expandedUserMessageByKey?: Record<string, true>;
  threadId?: string;
  turns: CodexTranscriptTurn[];
  width: number;
}): TranscriptMeasuredLayout {
  const contentWidth = Math.max(1, width);
  const measuredTurns: TranscriptMeasuredTurn[] = [];
  const userActionRowId = latestUserMessageActionRowId(turns);
  let top = 0;

  for (const turn of turns) {
    const turnTop = top;
    const turnUserActionRowId = actionRowIdForTurn(userActionRowId, turn.id);
    const turnUserMessageDisclosureRevision = userMessageDisclosureRevisionForTurn(turn, expandedUserMessageByKey);
    const measuredTurn = measureCollapsedTurnWithCache({
      cache,
      contentWidth,
      expandedUserMessageByKey,
      threadId,
      turn,
      userActionRowId: turnUserActionRowId,
      userMessageDisclosureRevision: turnUserMessageDisclosureRevision,
    });
    top += measuredTurn.collapsedHeight;

    measuredTurns.push({
      collapsedHeight: measuredTurn.collapsedHeight,
      collapsedTop: turnTop,
      revision: turn.revision,
      rows: measuredTurn.rows,
      turn,
      turnId: turn.id,
      userMessageDisclosureRevision: turnUserMessageDisclosureRevision,
    });
  }

  return {
    contentWidth,
    totalCollapsedHeight: top,
    turns: measuredTurns,
    turnsById: Object.fromEntries(measuredTurns.map((turn) => [turn.turnId, turn])),
    width,
  };
}

export function measureCollapsedTurnWithCache({
  cache,
  contentWidth,
  expandedUserMessageByKey = {},
  threadId,
  turn,
  userActionRowId,
  userMessageDisclosureRevision = userMessageDisclosureRevisionForTurn(turn, expandedUserMessageByKey),
}: {
  cache: TranscriptMeasureCache | undefined;
  contentWidth: number;
  expandedUserMessageByKey?: Record<string, true>;
  threadId: string | undefined;
  turn: CodexTranscriptTurn;
  userActionRowId: string | null;
  userMessageDisclosureRevision?: string;
}): Pick<TranscriptMeasuredTurn, 'collapsedHeight' | 'rows'> {
  const lookup = threadId
    ? {
        contentWidth,
        threadId,
        turnId: turn.id,
        turnRevision: turn.revision,
        userActionRowId,
        userMessageDisclosureRevision,
      }
    : null;
  const cached = lookup && cache ? rowsFromCache(turn, cache.read(lookup)) : null;
  if (cached) {
    return cached;
  }

  const measured = measureCollapsedTurn({
    contentWidth,
    expandedUserMessageByKey,
    turn,
    userActionRowId,
  });
  if (lookup && cache) {
    cache.write(lookup, cacheValueFromMeasuredTurn(measured));
  }
  return measured;
}

export function measureCollapsedTurn({
  contentWidth,
  expandedUserMessageByKey = {},
  turn,
  userActionRowId,
}: {
  contentWidth: number;
  expandedUserMessageByKey?: Record<string, true>;
  turn: CodexTranscriptTurn;
  userActionRowId: string | null;
}): Pick<TranscriptMeasuredTurn, 'collapsedHeight' | 'rows'> {
  const rows: TranscriptMeasuredRow[] = [];

  for (const segment of turn.segments) {
    const rowId = `${turn.id}:${segment.id}`;
    const assistantIsStreaming = segment.type === 'assistantMessage' && turn.status === 'inProgress';
    const showAssistantActions = assistantMessageCanShowActions(turn, segment);
    const showUserActions = rowId === userActionRowId;
    const userMessageDisclosure = segment.type === 'userMessage'
      ? userMessageDisclosureForSegment({
          contentWidth,
          expanded: Boolean(expandedUserMessageByKey[transcriptUserMessageDisclosureKey(turn.id, segment.id)]),
          segment,
        })
      : undefined;
    const row: TranscriptMeasuredRow = {
      height: measureCollapsedSegment({
        assistantIsStreaming,
        contentWidth,
        segment,
        showAssistantActions,
        showUserActions,
        userMessageDisclosure,
      }),
      id: rowId,
      segment,
      segmentId: segment.id,
      showAssistantActions,
      showUserActions,
      turn,
      turnId: turn.id,
      userMessageDisclosure,
    };
    rows.push(row);
  }

  return {
    collapsedHeight: rows.reduce((total, row) => total + row.height, 0),
    rows,
  };
}

function rowsFromCache(
  turn: CodexTranscriptTurn,
  cached: TranscriptMeasureCacheValue | null,
): Pick<TranscriptMeasuredTurn, 'collapsedHeight' | 'rows'> | null {
  if (!cached) {
    return null;
  }

  const segmentById = new Map(turn.segments.map((segment) => [segment.id, segment]));
  const rows: TranscriptMeasuredRow[] = [];

  for (const cachedRow of cached.rows) {
    const segment = segmentById.get(cachedRow.segmentId);
    if (!segment) {
      return null;
    }

    rows.push({
      height: cachedRow.height,
      id: `${turn.id}:${cachedRow.segmentId}`,
      segment,
      segmentId: cachedRow.segmentId,
      showAssistantActions: cachedRow.showAssistantActions,
      showUserActions: cachedRow.showUserActions,
      turn,
      turnId: turn.id,
      userMessageDisclosure: cachedRow.userMessageDisclosure,
    });
  }

  if (rows.length !== turn.segments.length) {
    return null;
  }

  return {
    collapsedHeight: cached.collapsedHeight,
    rows,
  };
}

function cacheValueFromMeasuredTurn(
  measured: Pick<TranscriptMeasuredTurn, 'collapsedHeight' | 'rows'>,
): TranscriptMeasureCacheValue {
  return {
    collapsedHeight: measured.collapsedHeight,
    rows: measured.rows.map((row) => ({
      height: row.height,
      segmentId: row.segmentId,
      showAssistantActions: row.showAssistantActions,
      showUserActions: row.showUserActions,
      userMessageDisclosure: row.userMessageDisclosure,
    })),
  };
}

function measureCollapsedSegment({
  assistantIsStreaming,
  contentWidth,
  segment,
  showAssistantActions,
  showUserActions,
  userMessageDisclosure,
}: {
  assistantIsStreaming: boolean;
  contentWidth: number;
  segment: CodexTranscriptSegment;
  showAssistantActions: boolean;
  showUserActions: boolean;
  userMessageDisclosure?: TranscriptUserMessageDisclosure;
}) {
  switch (segment.type) {
    case 'userMessage':
      return (
        measureUserMessage({ contentWidth, segment, userMessageDisclosure }) +
        (showUserActions ? transcriptLayout.user.actionTopGap + transcriptLayout.user.actionHeight : 0) +
        transcriptLayout.row.defaultGap
      );
    case 'assistantMessage':
      return (
        measureAssistantMessage({ contentWidth, segment, streaming: assistantIsStreaming }) +
        (showAssistantActions ? transcriptLayout.assistant.actionTopGap + transcriptLayout.assistant.actionHeight : 0) +
        transcriptLayout.row.defaultGap
      );
    case 'compaction':
      return transcriptLayout.compaction.dividerHeight + transcriptLayout.row.defaultGap;
    case 'work':
      return (
        transcriptLayout.work.headerHeight +
        transcriptLayout.work.separatorMarginTop +
        transcriptLayout.work.separatorHeight +
        transcriptLayout.row.workBoundaryGap
      );
  }
}

export function latestUserMessageActionRowId(turns: CodexTranscriptTurn[]) {
  const turn = turns.at(-1);
  if (!turn) {
    return null;
  }

  for (let segmentIndex = turn.segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
    const segment = turn.segments[segmentIndex];
    if (segment?.type !== 'userMessage') {
      continue;
    }

    return `${turn.id}:${segment.id}`;
  }

  return null;
}

function assistantMessageCanShowActions(
  turn: CodexTranscriptTurn,
  segment: CodexTranscriptSegment,
) {
  return (
    turn.status !== 'inProgress' &&
    segment.type === 'assistantMessage' &&
    segment.text.trim().length > 0
  );
}

function actionRowIdForTurn(rowId: string | null, turnId: string) {
  return rowId?.startsWith(`${turnId}:`) ? rowId : null;
}

export function userMessageDisclosureRevisionForTurn(
  turn: CodexTranscriptTurn,
  expandedUserMessageByKey: Record<string, true>,
) {
  return turn.segments
    .filter((segment) =>
      segment.type === 'userMessage' &&
      expandedUserMessageByKey[transcriptUserMessageDisclosureKey(turn.id, segment.id)])
    .map((segment) => segment.id)
    .join('\u001e');
}

function measureUserMessage({
  contentWidth,
  segment,
  userMessageDisclosure,
}: {
  contentWidth: number;
  segment: Extract<CodexTranscriptSegment, { type: 'userMessage' }>;
  userMessageDisclosure?: TranscriptUserMessageDisclosure;
}) {
  const layout = buildUserMessageLayout(
    {
      content: segment.content,
      id: segment.id,
      type: 'userMessage',
    },
    'topLevel',
  );
  const steeringHeight = segment.isSteering
    ? transcriptLayout.user.steeringLabelHeight + transcriptLayout.user.steeringLabelBottomGap
    : 0;
  const bubbleHeight = measureUserMessageBubble(layout, contentWidth, 'topLevel', userMessageDisclosure);

  return steeringHeight + bubbleHeight;
}

function measureUserMessageBubble(
  layout: ReturnType<typeof buildUserMessageLayout>,
  contentWidth: number,
  placement: 'topLevel' | 'work',
  userMessageDisclosure?: TranscriptUserMessageDisclosure,
) {
  const hasRail = layout.railItems.length > 0;
  const hasBody = Boolean(layout.bodyMarkdown);
  const hasDisclosure = Boolean(userMessageDisclosure?.collapsible);
  if (!hasRail && !hasBody) {
    return 0;
  }

  const childHeights: number[] = [];
  if (hasRail) {
    childHeights.push(transcriptLayout.user.railCardHeight);
  }
  const bodyHeight = layout.bodyMarkdown
    ? measureUserMessageBodyHeight({
        contentWidth,
        markdown: layout.bodyMarkdown,
        placement,
        userMessageDisclosure,
      })
    : 0;
  if (hasBody) {
    childHeights.push(bodyHeight);
  }
  if (hasDisclosure) {
    childHeights.push(transcriptLayout.user.disclosureHeight);
  }

  return (
    childHeights.reduce((total, height) => total + height, 0) +
    Math.max(0, childHeights.length - 1) * transcriptLayout.user.bubbleGap +
    transcriptLayout.user.bubblePaddingY * 2 +
    transcriptLayout.user.bubbleBorderWidth * 2
  );
}

function userMessageDisclosureForSegment({
  contentWidth,
  expanded,
  segment,
}: {
  contentWidth: number;
  expanded: boolean;
  segment: Extract<CodexTranscriptSegment, { type: 'userMessage' }>;
}): TranscriptUserMessageDisclosure | undefined {
  const layout = buildUserMessageLayout(
    {
      content: segment.content,
      id: segment.id,
      type: 'userMessage',
    },
    'topLevel',
  );
  if (!layout.bodyMarkdown) {
    return undefined;
  }

  const width = userBubbleContentWidth(contentWidth, 'topLevel');
  const fullHeight = measureMarkdownDocumentHeight(layout.bodyMarkdown, 'user', width);
  const cappedHeight = measureMarkdownDocumentCappedHeight(
    layout.bodyMarkdown,
    'user',
    width,
    transcriptLayout.user.collapsedBodyLines,
  );
  if (fullHeight <= cappedHeight + 0.5) {
    return undefined;
  }

  return {
    collapsible: true,
    expanded,
    maxLines: transcriptLayout.user.collapsedBodyLines,
  };
}

function measureUserMessageBodyHeight({
  contentWidth,
  markdown,
  placement,
  userMessageDisclosure,
}: {
  contentWidth: number;
  markdown: string;
  placement: 'topLevel' | 'work';
  userMessageDisclosure?: TranscriptUserMessageDisclosure;
}) {
  const width = userBubbleContentWidth(contentWidth, placement);
  if (userMessageDisclosure?.collapsible && !userMessageDisclosure.expanded) {
    return measureMarkdownDocumentCappedHeight(markdown, 'user', width, userMessageDisclosure.maxLines);
  }

  return measureMarkdownDocumentHeight(markdown, 'user', width);
}

function measureAssistantMessage({
  contentWidth,
  segment,
  streaming,
}: {
  contentWidth: number;
  segment: Extract<CodexTranscriptSegment, { type: 'assistantMessage' }>;
  streaming: boolean;
}) {
  if (!segment.text.trim()) {
    return 0;
  }

  return measureMarkdownDocumentHeight(segment.text, 'default', contentWidth, { richFileLinks: !streaming });
}
