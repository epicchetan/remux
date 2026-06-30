import { CircleSlash, FileArchive, Loader2 } from 'lucide-react';

import type { CodexCompactionSegment } from '../../../shared/transcript';
import { cn } from '@remux/viewer-kit/shadcn';

export function Compaction({
  density = 'default',
  segment,
}: {
  density?: 'default' | 'work';
  segment: CodexCompactionSegment;
}) {
  const icon =
    segment.status === 'compacting'
      ? <Loader2 className="size-4 animate-spin" />
      : segment.status === 'cancelled'
        ? <CircleSlash className="size-4" />
        : <FileArchive className="size-4" />;
  const label =
    segment.status === 'compacting'
      ? 'Compacting'
      : segment.status === 'cancelled'
        ? 'Compaction cancelled'
        : 'Compacted';

  return (
    <div
      className={cn(
        'flex items-center gap-3 text-sm text-muted-foreground',
        density === 'work' && 'codex-work-compaction-divider',
      )}
    >
      <div className="h-px flex-1 bg-border" />
      <div className="flex items-center gap-2">
        {icon}
        {label}
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
