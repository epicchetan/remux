import { AlertTriangle, AudioLines, Loader2, RotateCcw, X } from 'lucide-react';

import { useNarrationStore } from './store';

export function NarrationBar() {
  const cancel = useNarrationStore((state) => state.cancel);
  const close = useNarrationStore((state) => state.close);
  const error = useNarrationStore((state) => state.error);
  const phase = useNarrationStore((state) => state.phase);
  const progress = useNarrationStore((state) => state.progress);
  const retry = useNarrationStore((state) => state.retry);
  const status = useNarrationStore((state) => state.status);

  if (phase !== 'preparing' && phase !== 'failed') return null;

  if (phase === 'failed') {
    return (
      <div className="remux-composer-context-row remux-narration-bar" data-remux-no-composer-focus>
        <span className="remux-narration-label" title={error ?? undefined}>
          <AlertTriangle className="size-3.5" />
          <span className="remux-narration-copy">{error ?? 'Narration could not be prepared'}</span>
        </span>
        <span className="remux-narration-bar-actions">
          <button className="remux-narration-text-button" onClick={() => void retry()} type="button">
            <RotateCcw className="size-3.5" /> Retry
          </button>
          <button aria-label="Close narration error" className="remux-composer-edit-cancel" onClick={close} type="button">
            <X className="size-4" /> Close
          </button>
        </span>
      </div>
    );
  }

  const percent = progress?.totalBlocks
    ? ` ${Math.round((progress.committedBlocks / progress.totalBlocks) * 100)}%`
    : '';
  const label = status === 'finalizing'
    ? 'Finishing audio'
    : status === 'streaming'
      ? `Streaming audio${percent}`
      : 'Writing the first spoken group';

  return (
    <div className="remux-composer-context-row remux-narration-bar" data-remux-no-composer-focus>
      <span className="remux-narration-label">
        {status === 'planning' ? <AudioLines className="size-3.5" /> : <Loader2 className="size-3.5 animate-spin" />}
        <span>Preparing narration · {label}</span>
      </span>
      <button
        aria-label="Cancel narration preparation"
        className="remux-composer-edit-cancel"
        onClick={() => void cancel()}
        type="button"
      >
        <X className="size-4" /> Cancel
      </button>
    </div>
  );
}
