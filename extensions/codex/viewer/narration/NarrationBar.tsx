import { AlertTriangle, AudioLines, Loader2, RotateCcw, X } from 'lucide-react';

import { useNarrationStore } from './store';

export function NarrationBar() {
  const cancel = useNarrationStore((state) => state.cancel);
  const close = useNarrationStore((state) => state.close);
  const completed = useNarrationStore((state) => state.completedUnits);
  const error = useNarrationStore((state) => state.error);
  const phase = useNarrationStore((state) => state.phase);
  const retry = useNarrationStore((state) => state.retry);
  const stage = useNarrationStore((state) => state.stage);
  const total = useNarrationStore((state) => state.totalUnits);

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

  const progress = stage === 'synthesizing' && completed !== null && total
    ? ` ${Math.round((completed / total) * 100)}%`
    : '';
  const label = stage === 'synthesizing'
    ? `Generating audio${progress}`
    : 'Writing script';

  return (
    <div className="remux-composer-context-row remux-narration-bar" data-remux-no-composer-focus>
      <span className="remux-narration-label">
        {stage === 'planning' ? <AudioLines className="size-3.5" /> : <Loader2 className="size-3.5 animate-spin" />}
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
