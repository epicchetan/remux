import { useThreadRuntimeStore } from '../../threads/runtimeStore';
import { useComposerStore } from '../store';

export function ComposerStatusMessageRow() {
  const submission = useComposerStore((state) => state.submission);
  const submissionError = useComposerStore((state) => state.submissionError);
  const runtimeError = useThreadRuntimeStore((state) =>
    state.status === 'failed' ? state.lastError : null);
  const message = submission
    ? submissionStatusLabel(submission.phase)
    : submissionError
      ? runtimeErrorLabel(submissionError)
      : runtimeError
        ? runtimeErrorLabel(runtimeError.message)
        : null;
  const tone = submission ? 'muted' : 'error';

  if (!message) {
    return null;
  }

  return (
    <div
      className="remux-composer-message-status-row"
      data-remux-no-composer-focus
      data-tone={tone}
    >
      <span className="remux-composer-message-status-text">{message}</span>
    </div>
  );
}

function runtimeErrorLabel(message: string) {
  return message.trim() || 'Codex turn failed';
}

function submissionStatusLabel(phase: string) {
  switch (phase) {
    case 'waiting-for-connection':
      return 'Waiting for connection';
    case 'awaiting-transcript':
      return 'Updating transcript';
    case 'starting-thread':
      return 'Starting thread';
    case 'starting-turn':
    default:
      return 'Sending';
  }
}
