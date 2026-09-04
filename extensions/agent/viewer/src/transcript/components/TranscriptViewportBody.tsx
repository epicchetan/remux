import { Loader2, RotateCcw } from 'lucide-react';
import { memo } from 'react';

import type { AgentTurnSegment } from '../../../../shared/transcript';
import type { TranscriptMeasuredRow, TranscriptMeasuredTurn } from '../layout/types';
import { transcriptWorkDisclosureKey, useTranscriptLayoutStore } from '../layoutStore';
import { useTranscriptResourceStore, type TranscriptStatus } from '../resourceStore';
import { AssistantMessage } from './assistantMessage';
import { CompactionDivider } from './CompactionDivider';
import { UserMessage } from './userMessage';
import { WorkSection } from './work/WorkSection';

export function TranscriptViewportBody({
  bottomSpacerHeight,
  conversationId,
  status,
  topSpacerHeight,
  totalTurnCount,
  turns,
  width,
}: {
  bottomSpacerHeight: number;
  conversationId: string | null;
  status: TranscriptStatus;
  topSpacerHeight: number;
  totalTurnCount: number;
  turns: TranscriptMeasuredTurn[];
  width: number;
}) {
  if (status === 'idle' || status === 'loading') {
    return (
      <TranscriptFrameMessage
        icon={<Loader2 aria-hidden="true" className="size-4 animate-spin" />}
        label="Loading transcript"
      />
    );
  }
  if (status === 'failed') return <TranscriptFrameMessage label="Transcript unavailable" />;
  if (totalTurnCount === 0) return <TranscriptFrameMessage label="No transcript yet" />;
  if (!conversationId) return <TranscriptFrameMessage label="No conversation selected" />;

  return (
    <>
      {topSpacerHeight > 0 ? <div aria-hidden="true" style={{ height: `${topSpacerHeight}px` }} /> : null}
      {turns.map((turn) => (
        <TranscriptTurn conversationId={conversationId} key={turn.turnId} turn={turn} width={width} />
      ))}
      {bottomSpacerHeight > 0 ? <div aria-hidden="true" style={{ height: `${bottomSpacerHeight}px` }} /> : null}
    </>
  );
}

const TranscriptTurn = memo(function TranscriptTurn({
  conversationId,
  turn,
  width,
}: {
  conversationId: string;
  turn: TranscriptMeasuredTurn;
  width: number;
}) {
  const projectionError = useTranscriptResourceStore(
    (state) => state.turnResourcesById[turn.turnId]?.projectionError ?? null,
  );
  const refreshTranscript = useTranscriptResourceStore((state) => state.refreshActiveTranscriptResources);

  return (
    <article
      className="codex-transcript-turn"
      data-collapsed-height={turn.collapsedHeight}
      data-turn-id={turn.turnId}
    >
      {turn.rows.map((row) => (
        <TranscriptRow conversationId={conversationId} key={row.id} row={row} width={width} />
      ))}
      {turn.turn.error ? (
        <div className="codex-turn-error" role="alert">{turn.turn.error.message}</div>
      ) : null}
      {projectionError ? (
        <button
          className="agent-transcript-retry"
          onClick={() => void refreshTranscript({ preserveReady: true, windowPolicy: 'preserve' })}
          type="button"
        >
          <RotateCcw className="size-3" /> Retry turn projection
        </button>
      ) : null}
    </article>
  );
}, areTranscriptTurnPropsEqual);

const TranscriptRow = memo(function TranscriptRow({
  conversationId,
  row,
  width,
}: {
  conversationId: string;
  row: TranscriptMeasuredRow;
  width: number;
}) {
  const workKey = transcriptWorkDisclosureKey(row.turnId, row.segmentId);
  const openWork = useTranscriptLayoutStore((state) => state.disclosure.openWorkByKey[workKey]);
  const toggleWork = useTranscriptLayoutStore((state) => state.toggleWorkDisclosure);
  const setAdditionalHeight = useTranscriptLayoutStore((state) => state.setOpenWorkAdditionalHeight);
  return (
    <div
      className={`codex-transcript-row codex-transcript-row-${row.segment.type}`}
      data-client-message-id={row.segment.type === 'userMessage' ? row.segment.clientMessageId ?? undefined : undefined}
      data-collapsed-height={row.height}
      data-row-kind={row.segment.type === 'work' ? 'workSection' : row.segment.type}
      data-segment-id={row.segmentId}
      data-transcript-row-id={row.id}
      data-turn-id={row.turnId}
    >
      <TranscriptSegmentBody
        conversationId={conversationId}
        isWorkOpen={Boolean(openWork)}
        onWorkAdditionalHeight={setAdditionalHeight}
        onWorkToggle={toggleWork}
        row={row}
        segment={row.segment}
        width={width}
      />
    </div>
  );
}, areTranscriptRowPropsEqual);

function areTranscriptTurnPropsEqual(
  previous: { conversationId: string; turn: TranscriptMeasuredTurn; width: number },
  next: { conversationId: string; turn: TranscriptMeasuredTurn; width: number },
) {
  return previous.conversationId === next.conversationId &&
    previous.width === next.width &&
    previous.turn.rows === next.turn.rows &&
    previous.turn.turn.error === next.turn.turn.error;
}

function areTranscriptRowPropsEqual(
  previous: { conversationId: string; row: TranscriptMeasuredRow; width: number },
  next: { conversationId: string; row: TranscriptMeasuredRow; width: number },
) {
  return previous.conversationId === next.conversationId &&
    previous.width === next.width &&
    previous.row === next.row;
}

function TranscriptSegmentBody({
  conversationId,
  isWorkOpen,
  onWorkAdditionalHeight,
  onWorkToggle,
  row,
  segment,
  width,
}: {
  conversationId: string;
  isWorkOpen: boolean;
  onWorkAdditionalHeight: (workKey: string, rowId: string, height: number) => void;
  onWorkToggle: (input: { rowId: string; segmentId: string; turnId: string }) => void;
  row: TranscriptMeasuredRow;
  segment: AgentTurnSegment;
  width: number;
}) {
  if (segment.type === 'userMessage') {
    return (
      <UserMessage
        conversationId={conversationId}
        disclosure={row.userMessageDisclosure}
        laneWidth={width}
        segment={segment}
        showActions={row.showUserActions}
        turnId={row.turnId}
        pathEntryId={row.turn.pathEntryId}
        strandId={row.turn.strandId}
      />
    );
  }
  if (segment.type === 'assistantMessage') {
    return (
      <AssistantMessage
        conversationId={conversationId}
        segment={segment}
        showActions={row.showAssistantActions}
        turnStatus={row.turn.status}
        turnId={row.turnId}
        pathEntryId={row.turn.pathEntryId}
        strandId={row.turn.strandId}
        width={width}
      />
    );
  }
  if (segment.type === 'compaction') {
    return <CompactionDivider density="transcript" status={segment.status} title={segment.error} />;
  }
  return (
    <WorkSection
      conversationId={conversationId}
      isOpen={isWorkOpen}
      laneWidth={width}
      onAdditionalHeight={onWorkAdditionalHeight}
      onToggle={onWorkToggle}
      responseStarted={row.turn.segments.some((candidate) =>
        candidate.type === 'assistantMessage' && Boolean(candidate.text.trim()))}
      rowId={row.id}
      segment={segment}
      turnId={row.turnId}
      workKey={transcriptWorkDisclosureKey(row.turnId, segment.id)}
    />
  );
}

function TranscriptFrameMessage({ icon, label }: { icon?: React.ReactNode; label: string }) {
  return (
    <div className="agent-transcript-state">
      {icon}
      <span>{label}</span>
    </div>
  );
}
