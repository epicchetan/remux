import { AlertCircle, FileArchive, Loader2 } from 'lucide-react';

export function CompactionDivider({
  density = 'work',
  label,
  status,
  title,
}: {
  density?: 'transcript' | 'work';
  label?: string;
  status: 'compacting' | 'compacted' | 'failed';
  title?: string;
}) {
  const resolvedLabel = label ?? (status === 'compacting'
    ? 'Compacting'
    : status === 'failed' ? 'Compaction failed' : 'Compacted');
  return (
    <div
      className={`agent-work-compaction-divider agent-work-compaction-divider-${density}`}
      data-state={status}
      role="status"
      title={title}
    >
      <span aria-hidden="true" className="agent-work-compaction-rule" />
      <span className="agent-work-compaction-label">
        {status === 'compacting'
          ? <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          : status === 'failed'
            ? <AlertCircle aria-hidden="true" className="size-4" />
            : <FileArchive aria-hidden="true" className="size-4" />}
        {resolvedLabel}
      </span>
      <span aria-hidden="true" className="agent-work-compaction-rule" />
    </div>
  );
}
