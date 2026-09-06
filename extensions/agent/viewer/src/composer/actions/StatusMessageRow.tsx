import { useState } from 'react';

import type { NativeConversationSummary } from '../../../../shared/native-agent-protocol.ts';
import { useComposerStore } from '../store.ts';

export function ComposerStatusMessageRow({
  history,
  onRetryHistory,
  onRetrySubmission,
  pendingRecoveryError,
  hasPendingSubmission,
  isRecoveringSubmission,
  runtimeError,
}: {
  history: NativeConversationSummary['history'] | null;
  onRetryHistory: () => Promise<void>;
  onRetrySubmission: () => Promise<void>;
  pendingRecoveryError: string | null;
  hasPendingSubmission: boolean;
  isRecoveringSubmission: boolean;
  runtimeError: string | null;
}) {
  const submission = useComposerStore((state) => state.submission);
  const submissionError = useComposerStore((state) => state.submissionError);
  const [retrying, setRetrying] = useState(false);
  const historyLoading = history?.state === 'indexed' || history?.state === 'loading' || retrying;
  const historyFailed = history?.state === 'failed';
  const message = isRecoveringSubmission ? 'Checking pending message' : submission
    ? submissionLabel(submission.phase)
    : submissionError
      ?? pendingRecoveryError
      ?? (hasPendingSubmission ? 'Message pending. Retry to check its status.' : null)
      ?? (historyLoading ? 'Syncing conversation history' : null)
      ?? (historyFailed ? `Conversation history couldn’t sync${history.error ? `: ${history.error}` : '.'}` : null)
      ?? runtimeError;
  const actionableRecovery = hasPendingSubmission && !isRecoveringSubmission && !submission && !retrying;
  const actionable = actionableRecovery || (!submission && !submissionError && historyFailed && !retrying);

  if (!message) return null;
  return (
    <div
      className="remux-composer-message-status-row"
      data-actionable={actionable ? 'true' : undefined}
      data-remux-no-composer-focus
      data-tone={submission || isRecoveringSubmission || historyLoading ? 'muted' : 'error'}
      role={submission || isRecoveringSubmission || historyLoading ? undefined : 'alert'}
    >
      <span className="remux-composer-message-status-text">{message.trim() || 'Agent turn failed'}</span>
      {actionable ? (
        <button
          className="remux-composer-message-status-action"
          data-remux-no-composer-focus
          onClick={() => {
            setRetrying(true);
            void (actionableRecovery ? onRetrySubmission() : onRetryHistory())
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
