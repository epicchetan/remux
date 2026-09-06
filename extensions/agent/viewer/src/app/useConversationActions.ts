import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import {
  type ConversationValue,
} from '../../../shared/protocol.ts';
import type { AgentRuntimeResource, NativeAgentResourceKey } from '../../../shared/native-agent-protocol.ts';
import type { TurnSubmissionInput } from '../composer/actions/turnAction.ts';
import type { ComposerEditTarget, ComposerForkTarget } from '../composer/store.ts';
import {
  clearConversationDraftContent,
  persistConversationDraft,
  loadConversationDraft,
  removeNewChatDraft,
  type AgentNewChatDraft,
} from '../conversation/drafts.ts';
import { useConversationHistoryStore } from '../conversation/historyStore.ts';
import {
  confirmDraftOperationId,
  createViewerUuid,
  loadOrCreateDraftOperationId,
} from '../identity.ts';
import { agentCommands } from '../ipc/agentCommands.ts';
import { useComposerStore } from '../composer/store.ts';
import { resolveModel } from '../composer/config/modelSelection.ts';
import {
  clearPendingNewChatSubmission,
  findPendingNewChatSubmission,
  persistPendingNewChatSubmission,
  type PendingNewChatSubmission,
} from './newChatSubmission.ts';
import {
  getTranscriptResourceState,
  recoverActiveTranscriptResources,
} from '../transcript/resourceStore.ts';
import {
  discardTranscriptUserMessage,
  trackTranscriptUserMessage,
} from '../transcript/viewportStore.ts';

type ComposerPhase = 'sending' | 'updating-transcript';

export function useConversationActions(options: {
  activeConversationIdRef: MutableRefObject<string | null>;
  activeDraftIdRef: MutableRefObject<string | null>;
  activeConversationId: string | null;
  activeDraftId: string | null;
  conversation: ConversationValue | null;
  nativeRuntime: AgentRuntimeResource | null;
  cwd: string;
  draftRef: MutableRefObject<AgentNewChatDraft | null>;
  refresh: (keys?: NativeAgentResourceKey[]) => Promise<void>;
  selectConversation: (conversationId: string, focusTurnId?: string | null) => void;
  setActiveConversationId: Dispatch<SetStateAction<string | null>>;
  setActiveDraftId: Dispatch<SetStateAction<string | null>>;
  setDraft: Dispatch<SetStateAction<AgentNewChatDraft | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  connected: boolean;
}) {
  const {
    activeConversationIdRef,
    activeDraftIdRef,
    activeConversationId,
    activeDraftId,
    conversation,
    nativeRuntime,
    cwd,
    draftRef,
    refresh,
    selectConversation,
    setActiveConversationId,
    setActiveDraftId,
    setDraft,
    setError,
    connected,
  } = options;
  const [recoveryError, setRecoveryError] = useState<{ operationId: string; message: string } | null>(null);
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const [runningOperations, setRunningOperations] = useState<Set<string>>(new Set());
  const recoveryPromisesRef = useRef(new Map<string, Promise<void>>());
  const automaticAttemptsRef = useRef(new Map<string, number>());
  const legacyAttemptsRef = useRef(new Map<string, number>());
  const mountedRef = useRef(true);
  const ensureConversation = useConversationHistoryStore((state) => state.ensureConversation);
  const ownsRecord = useCallback((record: { draftId: string | null; conversationId: string | null }) =>
    (record.conversationId !== null && activeConversationIdRef.current === record.conversationId)
    || (activeConversationIdRef.current === null && activeDraftIdRef.current === record.draftId),
  [activeConversationIdRef, activeDraftIdRef]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (connected) {
      automaticAttemptsRef.current.clear();
      legacyAttemptsRef.current.clear();
      setRecoveryVersion((value) => value + 1);
    }
  }, [connected]);
  const attachCreatedConversation = useCallback(async (
    record: { create: { operationId: string }; draftId: string | null; snapshotKey: string },
    conversationId: string,
  ) => {
    if (!await ensureConversation(conversationId, true)) {
      throw new Error('Conversation created. Retry to finish loading it.');
    }
    const stillOwnsTarget = activeConversationIdRef.current === conversationId
      || (activeConversationIdRef.current === null && activeDraftIdRef.current === record.draftId);
    if (stillOwnsTarget) {
      const snapshot = useComposerStore.getState().snapshot;
      persistConversationDraft(conversationId, snapshot);
      if (loadConversationDraft(conversationId).snapshot.contentKey !== snapshot.contentKey) {
        throw new Error('Could not preserve the draft. Retry after freeing browser storage.');
      }
      if (draftRef.current?.id === record.draftId) {
        draftRef.current = null;
        setDraft(null);
      }
      activeDraftIdRef.current = null;
      activeConversationIdRef.current = conversationId;
      setActiveDraftId(null);
      setActiveConversationId(conversationId);
      await getTranscriptResourceState().setActiveConversationId(conversationId);
      confirmDraftOperationId(record.create.operationId);
      if (record.draftId) removeNewChatDraft(record.draftId);
    }
  }, [activeConversationIdRef, activeDraftIdRef, draftRef, ensureConversation,
    setActiveConversationId, setActiveDraftId, setDraft]);

  const finishRecoveredSubmission = useCallback(async (
    record: PendingNewChatSubmission,
    sent: { turnId: string; delivery: 'sent' | 'queued' | 'steered' },
  ) => {
    if (!record.conversationId || !record.message) return;
    if (sent.delivery === 'sent') {
      trackTranscriptUserMessage(record.conversationId, record.clientMessageId, sent.turnId);
    } else {
      discardTranscriptUserMessage(record.clientMessageId);
    }
    await Promise.all([
      refresh([`agent/runtime:${record.conversationId}`, `agent/queue:${record.conversationId}`]),
      ensureConversation(record.conversationId, true),
      ...(activeConversationIdRef.current === record.conversationId && sent?.delivery !== 'queued' && sent?.turnId
        ? [recoverActiveTranscriptResources({ attempts: 4, forceFullMeasure: false,
            preserveReady: true, requiredTurnId: sent.turnId, windowPolicy: 'tail' }).then((recovered) => {
              if (!recovered && activeConversationIdRef.current === record.conversationId) {
                throw new Error('The message was accepted. Retry to finish syncing its conversation.');
              }
            })]
        : []),
    ]);
    const isSelected = activeConversationIdRef.current === record.conversationId;
    const currentSnapshot = isSelected ? useComposerStore.getState().snapshot
      : loadConversationDraft(record.conversationId).snapshot;
    if (currentSnapshot.contentKey === record.snapshotKey) {
      clearConversationDraftContent(record.conversationId);
      if (isSelected) useComposerStore.getState().clearComposer();
    }
    if (ownsRecord(record)) useComposerStore.setState({ submissionError: null });
    clearPendingNewChatSubmission(record.create.operationId);
  }, [activeConversationIdRef, ensureConversation, ownsRecord, refresh]);

  const recoverRecord = useCallback(async (initial: PendingNewChatSubmission) => {
    let record = initial;
    if (!mountedRef.current || !ownsRecord(record)) return;
    let conversationId = record.conversationId;
    if (!conversationId) {
      const receipt = await agentCommands.readCommand(record.create.operationId, 'conversation.create');
      if (receipt.state === 'accepted' && receipt.kind === 'conversation.create') {
        conversationId = receipt.result.conversationId;
      } else if (receipt.state === 'missing' || receipt.state === 'received') {
        if (!mountedRef.current || !ownsRecord(record)) return;
        conversationId = (await agentCommands.createConversation(record.create)).conversationId;
      } else {
        throw new Error(commandRecoveryMessage(receipt, 'Conversation creation'));
      }
      record = { ...record, conversationId };
      persistPendingNewChatSubmission(record);
    }
    if (!mountedRef.current || !ownsRecord(record)) return;
    if (activeConversationIdRef.current !== conversationId) {
      await attachCreatedConversation(record, conversationId);
    }
    if (!mountedRef.current || !ownsRecord(record)) return;
    if (!record.message) {
      const runtime = await agentCommands.readRuntime(conversationId);
      if (!mountedRef.current || !ownsRecord(record)) return;
      record = { ...record, message: {
        operationId: record.messageOperationId,
        clientMessageId: record.clientMessageId,
        conversationId,
        parts: record.original.parts,
        nativeModelId: record.create.nativeModelId,
        reasoning: record.original.reasoning,
        serviceTier: runtime.composer.nextTurn.serviceTier,
        providerInstanceId: runtime.providerInstanceId,
        access: runtime.composer.nextTurn.access,
        configurationRevision: runtime.composer.revision,
        delivery: record.original.delivery,
      } };
      persistPendingNewChatSubmission(record);
    }
    const message = record.message!;
    const receipt = await agentCommands.readCommand(message.operationId, 'turn.send');
    if (!mountedRef.current || !ownsRecord(record)) return;
    if (receipt.state === 'accepted' && receipt.kind === 'turn.send') {
      await finishRecoveredSubmission(record, receipt.result);
      return;
    }
    if (receipt.state !== 'missing' && receipt.state !== 'received') {
      throw new Error(commandRecoveryMessage(receipt, 'The first message'));
    }
    const sent = await agentCommands.sendMessage(message);
    await finishRecoveredSubmission(record, sent);
  }, [activeConversationIdRef, attachCreatedConversation, finishRecoveredSubmission, ownsRecord]);

  const runRecovery = useCallback((record: PendingNewChatSubmission) => {
    const operationId = record.create.operationId;
    const existing = recoveryPromisesRef.current.get(operationId);
    if (existing) return existing;
    setRunningOperations((values) => new Set(values).add(operationId));
    setRecoveryError(null);
    const promise = recoverRecord(record)
      .then(() => {
        if (mountedRef.current && ownsRecord(record)) setRecoveryError(null);
      })
      .catch((reason) => {
        if (mountedRef.current && findPendingNewChatSubmission({
          conversationId: activeConversationIdRef.current, draftId: activeDraftIdRef.current,
        })?.create.operationId === operationId) {
          setRecoveryError({ operationId, message: messageOf(reason) });
        }
        throw reason;
      })
      .finally(() => {
        recoveryPromisesRef.current.delete(operationId);
        if (mountedRef.current) {
          setRunningOperations((values) => {
            const next = new Set(values);
            next.delete(operationId);
            return next;
          });
          setRecoveryVersion((value) => value + 1);
        }
      });
    recoveryPromisesRef.current.set(operationId, promise);
    return promise;
  }, [activeConversationIdRef, activeDraftIdRef, ownsRecord, recoverRecord]);

  const pendingRecord = findPendingNewChatSubmission({ conversationId: activeConversationId, draftId: activeDraftId });
  const pendingOperationId = pendingRecord?.create.operationId ?? null;
  const pendingRecoveryError = recoveryError?.operationId === pendingOperationId ? recoveryError?.message ?? null : null;
  const isRecoveringSubmission = pendingOperationId !== null && runningOperations.has(pendingOperationId);

  const retryPendingSubmission = useCallback(async () => {
    const record = findPendingNewChatSubmission({
      conversationId: activeConversationIdRef.current,
      draftId: activeDraftIdRef.current,
    });
    if (record) await runRecovery(record);
  }, [activeConversationIdRef, activeDraftIdRef, runRecovery]);

  useEffect(() => {
    if (!connected || !pendingOperationId || recoveryPromisesRef.current.has(pendingOperationId)) return;
    const attempts = automaticAttemptsRef.current.get(pendingOperationId) ?? 0;
    if (attempts >= 3) return;
    const timer = setTimeout(() => {
      const record = findPendingNewChatSubmission({
        conversationId: activeConversationIdRef.current, draftId: activeDraftIdRef.current,
      });
      if (!record || record.create.operationId !== pendingOperationId) return;
      automaticAttemptsRef.current.set(pendingOperationId, attempts + 1);
      void runRecovery(record).catch(() => undefined);
    }, attempts === 0 ? 0 : 600);
    return () => clearTimeout(timer);
  }, [activeConversationId, activeConversationIdRef, activeDraftId, activeDraftIdRef,
    connected, pendingOperationId, recoveryVersion, runRecovery]);

  // Pre-upgrade drafts contain no frozen send intent. Only attach a positively
  // accepted conversation; the current draft still requires an explicit Send.
  useEffect(() => {
    if (!connected || activeConversationId || !activeDraftId || pendingOperationId) return;
    const draftId = activeDraftId;
    const attempts = legacyAttemptsRef.current.get(draftId) ?? 0;
    if (attempts >= 3) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      legacyAttemptsRef.current.set(draftId, attempts + 1);
      void agentCommands.readCommand(draftId, 'conversation.create').then(async (receipt) => {
        if (cancelled || activeDraftIdRef.current !== draftId) return;
        if (receipt.state !== 'accepted' || receipt.kind !== 'conversation.create') {
          if (receipt.state === 'missing') legacyAttemptsRef.current.set(draftId, 3);
          return;
        }
        if (findPendingNewChatSubmission({ conversationId: null, draftId })) return;
        const snapshot = useComposerStore.getState().snapshot;
        await attachCreatedConversation({ draftId, snapshotKey: snapshot.contentKey,
          create: { operationId: draftId } }, receipt.result.conversationId);
      }).catch(() => undefined).finally(() => {
        if (!cancelled) setRecoveryVersion((value) => value + 1);
      });
    }, attempts === 0 ? 0 : 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activeConversationId, activeDraftId, activeDraftIdRef, attachCreatedConversation,
    connected, pendingOperationId, recoveryVersion]);

  const send = useCallback(async (
    input: TurnSubmissionInput,
    setPhase: (phase: ComposerPhase) => void,
  ) => {
    setError(null);
    const currentId = activeConversationIdRef.current;
    const existing = findPendingNewChatSubmission({
      conversationId: currentId,
      draftId: activeDraftIdRef.current,
    });
    if (existing) {
      await runRecovery(existing);
      return 'preserve-draft' as const;
    }
    if (!currentId) {
      const selected = resolveModel(useComposerStore.getState().models, input.modelId);
      if (!selected?.nativeId || selected.providerInstanceId !== input.providerInstanceId || !cwd) {
        throw new Error('Choose a workspace, provider, and model first.');
      }
      const operationId = activeDraftIdRef.current ?? loadOrCreateDraftOperationId();
      const pending: PendingNewChatSubmission = {
        version: 1,
        draftId: activeDraftIdRef.current,
        snapshotKey: useComposerStore.getState().snapshot.contentKey,
        create: { operationId, providerInstanceId: input.providerInstanceId, cwd,
          nativeModelId: selected.nativeId, reasoning: input.reasoning,
          serviceTier: input.serviceTier, access: input.access },
        original: structuredClone(input), conversationId: null,
        messageOperationId: createViewerUuid(), clientMessageId: createViewerUuid(), message: null,
      };
      persistPendingNewChatSubmission(pending);
      await runRecovery(pending);
      return 'preserve-draft' as const;
    }
    const activeId = currentId;
    const submissionRuntime = nativeRuntime?.conversationId === activeId ? nativeRuntime : null;
    if (!submissionRuntime) throw new Error('Conversation configuration is still loading.');
    const submittedProviderInstanceId = input.providerInstanceId;
    const submittedAccess = input.access;
    const submittedConfigurationRevision = input.configurationRevision;
    if (!submittedConfigurationRevision) {
      throw new Error('Conversation configuration is still loading.');
    }
    setPhase('sending');
    const clientMessageId = createViewerUuid();
    const selected = resolveModel(useComposerStore.getState().models, input.modelId);
    if (!selected?.nativeId || selected.providerInstanceId !== submittedProviderInstanceId) {
      throw new Error('The selected native provider model is unavailable.');
    }
    let sent;
    try {
      const message = {
        operationId: createViewerUuid(),
        conversationId: activeId,
        clientMessageId,
        parts: input.parts,
        nativeModelId: selected.nativeId,
        reasoning: input.reasoning,
        serviceTier: input.serviceTier,
        providerInstanceId: submittedProviderInstanceId,
        access: submittedAccess,
        configurationRevision: submittedConfigurationRevision,
        delivery: input.delivery,
      };
      sent = await agentCommands.sendMessage(message);
    } catch (reason) {
      throw reason;
    }
    const transcriptFence = 'transcriptFence' in sent ? sent.transcriptFence : undefined;
    if (sent.delivery === 'sent' && sent.turnId) {
      trackTranscriptUserMessage(activeId, clientMessageId, sent.turnId);
    } else {
      discardTranscriptUserMessage(clientMessageId);
    }
    setPhase('updating-transcript');
    clearConversationDraftContent(activeId);
    await Promise.all([
      refresh([`agent/runtime:${activeId}`, `agent/queue:${activeId}`]),
      ensureConversation(activeId, true),
      ...(activeConversationIdRef.current === activeId && sent.delivery !== 'queued'
        ? [recoverActiveTranscriptResources({
            attempts: 4,
            forceFullMeasure: false,
            preserveReady: true,
            requiredBasisSequence: transcriptFence?.basisSequence ?? null,
            requiredServerGeneration: transcriptFence?.serverGeneration ?? null,
            requiredTurnId: sent.turnId,
            windowPolicy: 'tail',
          })]
        : []),
    ]);
  }, [activeConversationIdRef, activeDraftIdRef, cwd, ensureConversation, nativeRuntime, refresh, runRecovery, setError]);

  const branchMessage = useCallback(async (
    mode: 'edit' | 'fork',
    target: ComposerEditTarget | ComposerForkTarget,
    input: TurnSubmissionInput,
    setPhase: (phase: ComposerPhase) => void,
  ) => {
    setError(null);
    setPhase('sending');
    if (!nativeRuntime || nativeRuntime.conversationId !== target.conversationId) {
      throw new Error('Conversation configuration is still loading.');
    }
    if (!input.configurationRevision) {
      throw new Error('Conversation configuration is still loading.');
    }
    const selected = resolveModel(useComposerStore.getState().models, input.modelId);
    if (!selected?.nativeId || selected.providerInstanceId !== input.providerInstanceId) {
      throw new Error('The selected native provider model is unavailable.');
    }
    const clientMessageId = createViewerUuid();
    const result = await agentCommands.branchMessage({
      mode,
      operationId: createViewerUuid(),
      clientMessageId,
      parts: input.parts,
      sourceConversationId: target.conversationId,
      sourceStrandId: target.strandId,
      sourcePathEntryId: target.pathEntryId,
      expectedHeadRevision: target.headRevision,
      providerInstanceId: input.providerInstanceId,
      nativeModelId: selected.nativeId,
      reasoning: input.reasoning,
      serviceTier: input.serviceTier,
      access: input.access,
      configurationRevision: input.configurationRevision,
    });
    clearConversationDraftContent(target.conversationId);
    trackTranscriptUserMessage(result.conversationId, clientMessageId, result.turnId);
    setPhase('updating-transcript');
    await ensureConversation(result.conversationId, true);
    selectConversation(result.conversationId, result.turnId);
    await getTranscriptResourceState().setActiveConversationId(result.conversationId);
    await Promise.all([
      refresh([
        `agent/runtime:${result.conversationId}`,
        `agent/queue:${result.conversationId}`,
      ]),
      recoverActiveTranscriptResources({
        attempts: 4,
        // Editing replaces the active strand inside the same conversation. Keep
        // the previous revision mounted until the replacement topology arrives,
        // then let the layout reconciler reuse every inherited turn measurement.
        // A fork selects a new conversation with no destination cache, so its
        // first transcript read remains a cold/full layout initialization.
        forceFullMeasure: mode === 'fork',
        preserveReady: mode === 'edit',
        requiredTurnId: result.turnId,
        windowPolicy: 'tail',
      }),
    ]);
  }, [ensureConversation, nativeRuntime, refresh, selectConversation, setError]);

  const interrupt = useCallback(async () => {
    if (!conversation?.id) return;
    setError(null);
    try {
      await agentCommands.interruptConversation(conversation.id);
      await refresh([`agent/runtime:${conversation.id}`]);
    } catch (reason) {
      setError(messageOf(reason));
      throw reason;
    }
  }, [conversation?.id, refresh, setError]);

  const compact = useCallback(async () => {
    if (!conversation?.id || nativeRuntime?.conversationId !== conversation.id) return;
    setError(null);
    try {
      await agentCommands.compact(conversation.id);
      await refresh([
        `agent/runtime:${conversation.id}`,
        `agent/queue:${conversation.id}`,
      ]);
    } catch (reason) {
      setError(messageOf(reason));
      throw reason;
    }
  }, [conversation?.id, nativeRuntime?.conversationId, refresh, setError]);

  return { branchMessage, compact, interrupt, pendingRecoveryError,
    hasPendingSubmission: pendingOperationId !== null, isRecoveringSubmission, retryPendingSubmission, send };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function commandRecoveryMessage(receipt: { state: string; errorMessage?: string }, subject: string) {
  if (receipt.state === 'rejected') {
    return `${subject} was rejected.${receipt.errorMessage ? ` ${receipt.errorMessage}` : ''}`;
  }
  return `${subject} is still unresolved. Retry to check again.${receipt.errorMessage ? ` ${receipt.errorMessage}` : ''}`;
}
