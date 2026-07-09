import { useCallback, useEffect } from 'react';

import {
  editThreadMessage,
  forkThreadMessage,
  interruptThreadTurn,
  sendThreadMessage,
  startThreadMessage,
} from '../../ipc/threadCommands';
import { applyCodexResourceInvalidations } from '../../ipc/resourceInvalidations';
import { useThreadRuntimeStore } from '../../threads/runtimeStore';
import { useThreadsStore } from '../../threads/store';
import { useTranscriptViewportStore } from '../../transcript/viewportStore';
import { createComposerNodeId } from '../model/composerModel';
import { buildComposerSendParts } from '../model/sendProjection';
import { useComposerStore } from '../store';

const acceptedRefreshDelaysMs = [0, 350, 1200, 3000];

export function useComposerTurnAction() {
  const activeThreadId = useThreadsStore((state) => state.activeThreadId);
  const activeDraft = useThreadsStore((state) =>
    state.activeDraftId && state.draft?.id === state.activeDraftId ? state.draft : null);
  const completeDraftAsThread = useThreadsStore((state) => state.completeDraftAsThread);
  const selectThread = useThreadsStore((state) => state.selectThread);
  const clearComposer = useComposerStore((state) => state.clearComposer);
  const clearMode = useComposerStore((state) => state.clearMode);
  const clearSubmission = useComposerStore((state) => state.clearSubmission);
  const editTarget = useComposerStore((state) => state.editTarget);
  const forkTarget = useComposerStore((state) => state.forkTarget);
  const intelligence = useComposerStore((state) => state.intelligence);
  const beginSubmission = useComposerStore((state) => state.beginSubmission);
  const failSubmission = useComposerStore((state) => state.failSubmission);
  const isSubmitting = useComposerStore((state) => state.isSubmitting);
  const model = useComposerStore((state) => state.model);
  const reviewMode = useComposerStore((state) => state.reviewMode);
  const setSubmissionTurn = useComposerStore((state) => state.setSubmissionTurn);
  const speed = useComposerStore((state) => state.speed);
  const submission = useComposerStore((state) => state.submission);
  const snapshot = useComposerStore((state) => state.snapshot);
  const runtimeActiveTurnId = useThreadRuntimeStore((state) => state.activeTurnId);
  const runtimeStatus = useThreadRuntimeStore((state) => state.status);
  const isStopping = runtimeStatus === 'stopping';
  const isWorking = runtimeStatus === 'running' || isStopping;
  const setAutoScrollMode = useTranscriptViewportStore((state) => state.setAutoScrollMode);
  const canInterrupt = Boolean(activeThreadId && runtimeStatus === 'running');
  const canEditThread = Boolean(editTarget?.threadId);
  const canForkThread = Boolean(forkTarget?.threadId);
  const canSendExistingThread = Boolean(activeThreadId);
  const canStartDraftThread = Boolean(activeDraft?.cwd);
  const sendDisabled = Boolean(
    isSubmitting ||
      (isWorking
        ? !canInterrupt
          : (
            !snapshot.canSend ||
            (!canEditThread && !canForkThread && !canSendExistingThread && !canStartDraftThread)
          )),
  );

  useEffect(() => {
    if (
      (runtimeStatus === 'running' || runtimeStatus === 'failed') &&
      submission?.phase === 'awaiting-transcript'
    ) {
      clearSubmission(submission.id);
    }
  }, [clearSubmission, runtimeStatus, submission]);

  const handleTurnAction = useCallback(() => {
    if (runtimeStatus === 'running' && activeThreadId) {
      void interruptThreadTurn({
        threadId: activeThreadId,
        turnId: runtimeActiveTurnId,
      })
        .then((response) => applyCodexResourceInvalidations(response.invalidations))
        .catch(() => undefined);
      return;
    }

    if (sendDisabled) {
      return;
    }

    const projection = buildComposerSendParts(snapshot);
    if (projection.type === 'error') {
      return;
    }

    if (editTarget) {
      const submission = beginSubmission({
        kind: 'edit',
        phase: 'starting-turn',
        snapshot,
        threadId: editTarget.threadId,
        turnId: editTarget.turnId,
      });

      void editThreadMessage({
        clientMessageId: createComposerNodeId(),
        parts: projection.parts,
        threadId: editTarget.threadId,
        turnId: editTarget.turnId,
        userMessageId: editTarget.userMessageId,
      })
        .then(async (response) => {
          setSubmissionTurn(submission.id, {
            phase: 'awaiting-transcript',
            threadId: response.threadId,
            turnId: response.turnId,
          });
          setAutoScrollMode({ type: 'sent-message-anchor', turnId: response.turnId });
          clearComposer();
          clearMode();
          await refreshAcceptedSend(response.invalidations, () =>
            useComposerStore.getState().submission?.id === submission.id);
          clearSubmission(submission.id);
        })
        .catch((error) => {
          failSubmission(submission.id, commandErrorMessage(error, 'Could not edit message'));
        });
      return;
    }

    if (forkTarget) {
      const submission = beginSubmission({
        kind: 'fork',
        phase: 'starting-thread',
        snapshot,
        threadId: forkTarget.threadId,
        turnId: forkTarget.turnId,
      });

      void forkThreadMessage({
        assistantMessageId: forkTarget.assistantMessageId,
        clientMessageId: createComposerNodeId(),
        parts: projection.parts,
        threadId: forkTarget.threadId,
        turnId: forkTarget.turnId,
      })
        .then(async (response) => {
          selectThread(response.threadId);
          setSubmissionTurn(submission.id, {
            phase: 'awaiting-transcript',
            threadId: response.threadId,
            turnId: response.turnId,
          });
          setAutoScrollMode({ type: 'sent-message-anchor', turnId: response.turnId });
          clearComposer();
          clearMode();
          await refreshAcceptedSend(response.invalidations, () =>
            useComposerStore.getState().submission?.id === submission.id);
          clearSubmission(submission.id);
        })
        .catch((error) => {
          failSubmission(submission.id, commandErrorMessage(error, 'Could not fork message'));
        });
      return;
    }

    if (!activeThreadId && activeDraft?.cwd) {
      const submission = beginSubmission({
        kind: 'new-chat',
        phase: 'starting-thread',
        snapshot,
      });

      void startThreadMessage({
        clientMessageId: createComposerNodeId(),
        composerConfig: {
          intelligence,
          model,
          reviewMode,
          speed,
        },
        cwd: activeDraft.cwd,
        parts: projection.parts,
      })
        .then(async (response) => {
          completeDraftAsThread(response.threadId);
          setSubmissionTurn(submission.id, {
            phase: 'awaiting-transcript',
            threadId: response.threadId,
            turnId: response.turnId,
          });
          setAutoScrollMode({ type: 'sent-message-anchor', turnId: response.turnId });
          clearComposer();
          clearMode();
          await refreshAcceptedSend(response.invalidations, () =>
            useComposerStore.getState().submission?.id === submission.id);
          clearSubmission(submission.id);
        })
        .catch((error) => {
          failSubmission(submission.id, commandErrorMessage(error, 'Could not start thread'));
        });
      return;
    }

    if (!activeThreadId) {
      return;
    }

    const submission = beginSubmission({
      kind: 'send',
      phase: 'starting-turn',
      snapshot,
      threadId: activeThreadId,
    });

    void sendThreadMessage({
      clientMessageId: createComposerNodeId(),
      parts: projection.parts,
      threadId: activeThreadId,
    })
      .then(async (response) => {
        setSubmissionTurn(submission.id, {
          phase: 'awaiting-transcript',
          threadId: response.threadId,
          turnId: response.turnId,
        });
        setAutoScrollMode({ type: 'sent-message-anchor', turnId: response.turnId });
        clearComposer();
        clearMode();
        await refreshAcceptedSend(response.invalidations, () =>
          useComposerStore.getState().submission?.id === submission.id);
        clearSubmission(submission.id);
      })
      .catch((error) => {
        failSubmission(submission.id, commandErrorMessage(error, 'Could not send message'));
      });
  }, [
    activeDraft,
    activeThreadId,
    beginSubmission,
    clearComposer,
    clearMode,
    clearSubmission,
    completeDraftAsThread,
    editTarget,
    failSubmission,
    forkTarget,
    intelligence,
    isSubmitting,
    isWorking,
    model,
    reviewMode,
    runtimeActiveTurnId,
    runtimeStatus,
    selectThread,
    sendDisabled,
    setSubmissionTurn,
    speed,
    setAutoScrollMode,
    snapshot,
  ]);

  return {
    editTarget,
    forkTarget,
    handleTurnAction,
    isSubmitting,
    isStopping,
    isWorking,
    sendDisabled,
  };
}

function commandErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

async function refreshAcceptedSend(
  invalidations: Parameters<typeof applyCodexResourceInvalidations>[0],
  shouldContinue: () => boolean,
) {
  for (const delayMs of acceptedRefreshDelaysMs) {
    if (!shouldContinue()) {
      return;
    }

    if (delayMs > 0) {
      await delay(delayMs);
    }

    if (!shouldContinue()) {
      return;
    }

    await applyCodexResourceInvalidations(invalidations);
  }
}

function delay(delayMs: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}
