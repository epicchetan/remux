import { useState } from 'react';

import type {
  AgentComposerMessagePart,
  ReasoningEffort,
} from '../../../../shared/protocol.ts';
import type { AgentRuntimeResource } from '../../../../shared/native-agent-protocol.ts';
import type { ProviderAccess } from '../../../../shared/provider-runtime.ts';
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
  interruptible,
  onInterrupt,
  onEdit,
  onFork,
  onSend,
  runtime,
  imagesEnabled,
  fileReferencesEnabled,
  branchEnabled,
}: {
  canStart: boolean;
  conversationExists: boolean;
  isWorking: boolean;
  interruptible: boolean;
  onInterrupt: () => Promise<void>;
  onEdit: ComposerBranchCallback<ComposerEditTarget>;
  onFork: ComposerBranchCallback<ComposerForkTarget>;
  onSend: (
    input: TurnSubmissionInput,
    setPhase: (phase: 'sending' | 'updating-transcript') => void,
  ) => Promise<void | 'preserve-draft'>;
  runtime: AgentRuntimeResource | null;
  imagesEnabled: boolean;
  fileReferencesEnabled: boolean;
  branchEnabled: boolean;
}) {
  const snapshot = useComposerStore((state) => state.snapshot);
  const editTarget = useComposerStore((state) => state.editTarget);
  const forkTarget = useComposerStore((state) => state.forkTarget);
  const modelId = useComposerStore((state) => state.modelId);
  const reasoning = useComposerStore((state) => state.reasoning);
  const serviceTier = useComposerStore((state) => state.serviceTier);
  const providerInstanceId = useComposerStore((state) => state.providerInstanceId);
  const access = useComposerStore((state) => state.access);
  const submission = useComposerStore((state) => state.submission);
  const beginSubmission = useComposerStore((state) => state.beginSubmission);
  const clearComposer = useComposerStore((state) => state.clearComposer);
  const clearMode = useComposerStore((state) => state.clearMode);
  const clearSubmission = useComposerStore((state) => state.clearSubmission);
  const failSubmission = useComposerStore((state) => state.failSubmission);
  const setSubmissionPhase = useComposerStore((state) => state.setSubmissionPhase);
  const [isStopping, setStopping] = useState(false);
  const unsupportedContent = snapshot.document.parts.some((part) =>
    (part.type === 'attachment' && !imagesEnabled)
    || (part.type === 'mention' && !fileReferencesEnabled));
  const unsupportedBranch = Boolean((editTarget || forkTarget) && !branchEnabled);

  const handleSend = () => {
    if (submission || !canStart || unsupportedContent || unsupportedBranch
        || (isWorking && Boolean(editTarget))) return;
    const projection = buildComposerSendProjection(snapshot);
    if (projection.type === 'error') return;
    const kind = editTarget ? 'edit' : forkTarget ? 'fork' : conversationExists ? 'send' : 'new-chat';
    const next = beginSubmission({
      kind,
      modelId,
      phase: conversationExists ? 'sending' : 'starting-conversation',
      snapshot,
      reasoning,
      serviceTier,
    });
    const input = {
      access: runtime?.composer.nextTurn.access ?? access,
      configurationRevision: runtime?.composer.revision ?? null,
      // Normal chat always enters the Agent runtime's durable lane. Native
      // steering, when exposed, is a separate explicit action.
      delivery: 'queue' as const,
      displayText: projection.displayText,
      modelId,
      parts: projection.parts,
      providerInstanceId: runtime?.providerInstanceId ?? providerInstanceId,
      reasoning,
      serviceTier: runtime?.composer.nextTurn.serviceTier ?? serviceTier,
    };
    const setPhase = (phase: 'sending' | 'updating-transcript') => setSubmissionPhase(next.id, phase);
    const request = editTarget
      ? onEdit(editTarget, input, setPhase)
      : forkTarget
        ? onFork(forkTarget, input, setPhase)
        : onSend(input, setPhase);
    void request
      .then((result) => {
        if (useComposerStore.getState().submission?.id !== next.id) return;
        if (result !== 'preserve-draft' && useComposerStore.getState().snapshot.contentKey === next.snapshot.contentKey) {
          clearComposer();
        }
        clearMode();
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
    if (!interruptible || isStopping) return;
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
    sendDisabled: Boolean(
      submission || !canStart || !snapshot.canSend || unsupportedContent || unsupportedBranch
      || (isWorking && editTarget),
    ),
  };
}

type ComposerBranchCallback<T> = (
  target: T,
  input: TurnSubmissionInput,
  setPhase: (phase: 'sending' | 'updating-transcript') => void,
) => Promise<void>;

export type TurnSubmissionInput = {
  access: ProviderAccess;
  configurationRevision: string | null;
  delivery: 'auto' | 'queue' | 'steer';
  displayText: string;
  modelId: string;
  parts: AgentComposerMessagePart[];
  providerInstanceId: string;
  reasoning: ReasoningEffort;
  serviceTier: string | null;
};
