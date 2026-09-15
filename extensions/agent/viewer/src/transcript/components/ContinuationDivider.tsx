import type { AgentNoticeSegment } from '../../../../shared/transcript.ts';

export function ContinuationDivider({ notice }: { notice: AgentNoticeSegment }) {
  const seconds = notice.elapsedMs === undefined ? null : Math.floor(notice.elapsedMs / 1_000);
  const elapsed = seconds === null ? null : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return <div className="agent-work-compaction-divider agent-work-compaction-divider-transcript" role="note">
    <span aria-hidden="true" className="agent-work-compaction-rule" />
    <span className="agent-work-compaction-label agent-continuation-label">
      <span className="agent-continuation-text" title={notice.text}>{notice.text}</span>
      {elapsed ? <span className="shrink-0">· {elapsed}</span> : null}
    </span>
    <span aria-hidden="true" className="agent-work-compaction-rule" />
  </div>;
}
