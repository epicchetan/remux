import { useComposerStore } from '../store.ts';

export function ComposerStatusMessageRow({ runtimeError }: { runtimeError: string | null }) {
  const submission = useComposerStore((state) => state.submission);
  const submissionError = useComposerStore((state) => state.submissionError);
  const message = submission
    ? submissionLabel(submission.phase)
    : submissionError ?? runtimeError;

  if (!message) return null;
  return (
    <div
      className="remux-composer-message-status-row"
      data-remux-no-composer-focus
      data-tone={submission ? 'muted' : 'error'}
      role={submission ? undefined : 'alert'}
    >
      <span className="remux-composer-message-status-text">{message.trim() || 'Agent turn failed'}</span>
    </div>
  );
}

function submissionLabel(phase: string) {
  if (phase === 'starting-conversation') return 'Starting conversation';
  if (phase === 'updating-transcript') return 'Updating transcript';
  return 'Sending';
}
