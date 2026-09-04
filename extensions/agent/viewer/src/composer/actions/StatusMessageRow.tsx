import { useState } from 'react';

import type { NativeConversationSummary } from '../../../../shared/native-agent-protocol.ts';
import { useComposerStore } from '../store.ts';

export function ComposerStatusMessageRow({
  history,
  onRetryHistory,
  runtimeError,
}: {
  history: NativeConversationSummary['history'] | null;
  onRetryHistory: () => Promise<void>;
  runtimeError: string | null;
}) {
  const submission = useComposerStore((state) => state.submission);
  const submissionError = useComposerStore((state) => state.submissionError);
  const [retrying, setRetrying] = useState(false);
  const historyLoading = history?.state === 'indexed' || history?.state === 'loading' || retrying;
  const historyFailed = history?.state === 'failed';
  const message = submission
    ? submissionLabel(submission.phase)
    : submissionError
      ?? (historyLoading ? 'Syncing conversation history' : null)
      ?? (historyFailed ? history.error ?? 'Conversation history could not be synced' : null)
      ?? runtimeError;
  const actionable = !submission && !submissionError && historyFailed && !retrying;

  if (!message) return null;
  return (
    <div
      className="remux-composer-message-status-row"
      data-actionable={actionable ? 'true' : undefined}
      data-remux-no-composer-focus
      data-tone={submission || historyLoading ? 'muted' : 'error'}
      role={submission || historyLoading ? undefined : 'alert'}
    >
      <span className="remux-composer-message-status-text">{message.trim() || 'Agent turn failed'}</span>
      {actionable ? (
        <button
          className="remux-composer-message-status-action"
          data-remux-no-composer-focus
          onClick={() => {
            setRetrying(true);
            void onRetryHistory()
              .catch(() => undefined)
              .finally(() => setRetrying(false));
          }}
          type="button"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

function submissionLabel(phase: string) {
  if (phase === 'starting-conversation') return 'Starting conversation';
  if (phase === 'updating-transcript') return 'Updating transcript';
  return 'Sending';
}
