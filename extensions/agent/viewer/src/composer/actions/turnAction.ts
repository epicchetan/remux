import { useState } from 'react';

import { buildComposerSendProjection } from '../model/sendProjection.ts';
import { useComposerStore } from '../store.ts';

export function useComposerTurnAction({
  canStart,
  conversationExists,
  isWorking,
  onInterrupt,
  onSend,
}: {
  canStart: boolean;
  conversationExists: boolean;
  isWorking: boolean;
  onInterrupt: () => Promise<void>;
  onSend: (text: string, setPhase: (phase: 'sending' | 'updating-transcript') => void) => Promise<void>;
}) {
  const snapshot = useComposerStore((state) => state.snapshot);
  const submission = useComposerStore((state) => state.submission);
  const beginSubmission = useComposerStore((state) => state.beginSubmission);
  const clearComposer = useComposerStore((state) => state.clearComposer);
  const clearSubmission = useComposerStore((state) => state.clearSubmission);
  const failSubmission = useComposerStore((state) => state.failSubmission);
  const setSubmissionPhase = useComposerStore((state) => state.setSubmissionPhase);
  const [isStopping, setStopping] = useState(false);

  const handleSend = () => {
    if (submission || isWorking || !canStart) return;
    const projection = buildComposerSendProjection(snapshot);
    if (projection.type === 'error') return;
    const next = beginSubmission(conversationExists ? 'sending' : 'starting-conversation');
    void onSend(projection.text, (phase) => setSubmissionPhase(next.id, phase))
      .then(() => {
        clearComposer();
        clearSubmission(next.id);
      })
      .catch((error) => failSubmission(next.id, error instanceof Error ? error.message : String(error)));
  };

  const handleInterrupt = () => {
    if (!isWorking || isStopping) return;
    setStopping(true);
    void onInterrupt().finally(() => setStopping(false));
  };

  return {
    handleInterrupt,
    handleSend,
    isStopping,
    isSubmitting: Boolean(submission),
    sendDisabled: Boolean(submission || isWorking || !canStart || !snapshot.canSend),
  };
}
