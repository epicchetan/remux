import { useState } from 'react';

import type { AgentComposerMessagePart, TurnContextPlan } from '../../../../shared/protocol.ts';
import { createDefaultTurnContextPlan } from '../context/contextPlan.ts';
import { buildComposerSendProjection } from '../model/sendProjection.ts';
import {
  type ComposerEditTarget,
  type ComposerForkTarget,
  useComposerStore,
} from '../store.ts';

export function useComposerTurnAction({
  canStart,
  conversationExists,
  isWorking,
  onInterrupt,
  onEdit,
  onFork,
  onSend,
}: {
  canStart: boolean;
  conversationExists: boolean;
  isWorking: boolean;
  onInterrupt: () => Promise<void>;
  onEdit: ComposerBranchCallback<ComposerEditTarget>;
  onFork: ComposerBranchCallback<ComposerForkTarget>;
  onSend: (
    input: { contextPlan: TurnContextPlan; displayText: string; parts: AgentComposerMessagePart[] },
    setPhase: (phase: 'sending' | 'updating-transcript') => void,
  ) => Promise<void>;
}) {
  const snapshot = useComposerStore((state) => state.snapshot);
  const editTarget = useComposerStore((state) => state.editTarget);
  const forkTarget = useComposerStore((state) => state.forkTarget);
  const contextPlan = useComposerStore((state) => state.contextPlan);
  const submission = useComposerStore((state) => state.submission);
  const beginSubmission = useComposerStore((state) => state.beginSubmission);
  const clearComposer = useComposerStore((state) => state.clearComposer);
  const clearMode = useComposerStore((state) => state.clearMode);
  const clearSubmission = useComposerStore((state) => state.clearSubmission);
  const failSubmission = useComposerStore((state) => state.failSubmission);
  const setSubmissionPhase = useComposerStore((state) => state.setSubmissionPhase);
  const setContextPlan = useComposerStore((state) => state.setContextPlan);
  const [isStopping, setStopping] = useState(false);

  const handleSend = () => {
    if (submission || !canStart || (isWorking && Boolean(editTarget))) return;
    const projection = buildComposerSendProjection(snapshot);
    if (projection.type === 'error') return;
    const kind = editTarget ? 'edit' : forkTarget ? 'fork' : conversationExists ? 'send' : 'new-chat';
    const next = beginSubmission({
      kind,
      phase: conversationExists ? 'sending' : 'starting-conversation',
      snapshot,
      contextPlan,
    });
    const input = { contextPlan, displayText: projection.displayText, parts: projection.parts };
    const setPhase = (phase: 'sending' | 'updating-transcript') => setSubmissionPhase(next.id, phase);
    const request = editTarget
      ? onEdit(editTarget, input, setPhase)
      : forkTarget
        ? onFork(forkTarget, input, setPhase)
        : onSend(input, setPhase);
    void request
      .then(() => {
        if (useComposerStore.getState().snapshot.contentKey === next.snapshot.contentKey) {
          clearComposer();
        }
        clearMode();
        const current = useComposerStore.getState();
        if (current.contextPlan === next.contextPlan && !current.preserveContextPlan) {
          setContextPlan(createDefaultTurnContextPlan());
        }
        clearSubmission(next.id);
      })
      .catch((error) => {
        if (useComposerStore.getState().snapshot.contentKey === next.snapshot.contentKey) {
          failSubmission(next.id, error instanceof Error ? error.message : String(error));
        } else {
          clearSubmission(next.id);
        }
      });
  };

  const handleInterrupt = () => {
    if (!isWorking || isStopping) return;
    setStopping(true);
    void onInterrupt().finally(() => setStopping(false));
  };

  return {
    handleInterrupt,
    handleSend,
    editTarget,
    forkTarget,
    isStopping,
    isSubmitting: Boolean(submission),
    hasSendableContent: snapshot.hasSendableContent,
    sendDisabled: Boolean(submission || !canStart || !snapshot.canSend || (isWorking && editTarget)),
  };
}

type ComposerBranchCallback<T> = (
  target: T,
  input: { contextPlan: TurnContextPlan; displayText: string; parts: AgentComposerMessagePart[] },
  setPhase: (phase: 'sending' | 'updating-transcript') => void,
) => Promise<void>;
