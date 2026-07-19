import { AlertTriangle, AudioLines, Loader2, RotateCcw, X } from 'lucide-react';

import { useNarrationStore } from './client';

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

  const percent = progress?.chunksTotal
    ? ` ${Math.round((progress.chunksCompleted / progress.chunksTotal) * 100)}%`
    : '';
  const label = (() => {
    switch (progress?.stage) {
      case 'languagePlanning': {
        const completed = progress.auditWindowsCompleted + progress.transcriptWindowsCompleted;
        const total = progress.auditWindowsTotal + progress.transcriptWindowsTotal;
        return total ? `Preparing speech ${completed} of ${total}` : 'Preparing speech';
      }
      case 'planning': return 'Planning natural speech chunks';
      case 'loadingModel': return 'Loading the voice model';
      case 'synthesizing': return `Synthesizing audio${percent}`;
      case 'finalizing': return 'Finishing audio';
      case 'baseline':
      default: return 'Building pronunciation baseline';
    }
  })();

  return (
    <div className="remux-composer-context-row remux-narration-bar" data-remux-no-composer-focus>
      <span className="remux-narration-label">
        {status === 'preparing' ? <AudioLines className="size-3.5" /> : <Loader2 className="size-3.5 animate-spin" />}
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
