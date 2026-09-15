import type { AgentPendingQueueValue } from '../../../../shared/protocol.ts';
import { composerDeliveryNotice, composerDeliveryReason } from '../model/deliveryChoice.ts';
import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { agentCommands } from '../../ipc/agentCommands.ts';
import { createViewerUuid } from '../../identity.ts';

import type { AgentProvidersResource, AgentRuntimeResource, NativeConversationSummary } from '../../../../shared/native-agent-protocol.ts';
import { reasoningLabel, resolveModel } from '../config/modelSelection.ts';
import { useComposerStore } from '../store.ts';
import { compactTokenCount } from '../usage/UsageTray.tsx';

export function ComposerInlineStatus({
  expanded,
  hasPendingSubmission,
  history,
  isRecoveringSubmission,
  onRetryHistory,
  onRetrySubmission,
  onToggle,
  pendingRecoveryError,
  providers,
  runtime,
  queue,
  runtimeError,
}: {
  expanded: boolean;
  hasPendingSubmission: boolean;
  history: NativeConversationSummary['history'] | null;
  isRecoveringSubmission: boolean;
  onRetryHistory: () => Promise<void>;
  onRetrySubmission: () => Promise<void>;
  onToggle: () => void;
  pendingRecoveryError: string | null;
  providers: AgentProvidersResource | null;
  runtime: AgentRuntimeResource | null;
  queue: AgentPendingQueueValue | null;
  runtimeError: string | null;
}) {
  const configuredModel = useComposerStore((state) => state.modelId);
  const models = useComposerStore((state) => state.models);
  const configuredReasoning = useComposerStore((state) => state.reasoning);
  const model = resolveModel(models, configuredModel);
  const serviceTier = useComposerStore(state => state.serviceTier);
  const access = useComposerStore(state => state.access);
  const typing = useComposerStore(state => state.snapshot.hasSendableContent);
  const deliveryNotice = useComposerStore(state => state.deliveryNotice);
  const queuedReason = deliveryNotice?.conversationId === runtime?.conversationId &&
    queue?.entries.some(entry => entry.kind === 'message' && entry.id === deliveryNotice?.turnId)
    ? composerDeliveryNotice(deliveryNotice?.reason) : null;
  const deliveryReason = queuedReason ?? (typing && runtime?.activeTurnId ? composerDeliveryReason({ runtime, queue,
    model: model?.nativeId ?? null, effort: configuredReasoning,
    serviceTier: runtime?.composer.nextTurn.serviceTier ?? serviceTier,
    access: runtime?.composer.nextTurn.access ?? access }) : null);
  const providerInstanceId = runtime?.providerInstanceId ?? model?.providerInstanceId;
  const provider = providers?.providers.find(({ providerInstanceId: id }) => id === providerInstanceId);
  const context = runtime?.usage.context ?? null;
  const canInspect = Boolean(context || (provider?.capabilities?.usage.plan !== 'none'));
  const contextTone = context && context.percent >= 90
    ? ' is-critical'
    : context && context.percent >= 75 ? ' is-warning' : '';
  const submission = useComposerStore((state) => state.submission);
  const submissionError = useComposerStore((state) => state.submissionError);
  const [retrying, setRetrying] = useState<'submission' | 'history' | null>(null);
  const retryInFlight = useRef(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const historyLoading = history?.state === 'indexed' || history?.state === 'loading';
  const historyFailed = history?.state === 'failed';
  const status = isRecoveringSubmission || retrying
    ? { kind: 'progress' as const, message: retrying === 'history' ? 'Syncing history' : 'Checking pending message' }
    : submission
      ? { kind: 'progress' as const, message: submissionLabel(submission.phase) }
      : submissionError
        ? { kind: 'error' as const, message: submissionError }
        : pendingRecoveryError
          ? { kind: 'error' as const, message: pendingRecoveryError }
          : hasPendingSubmission
            ? { kind: 'recovery' as const, message: 'Message pending. Retry to check its status.' }
            : historyLoading
              ? { kind: 'progress' as const, message: 'Syncing history' }
              : historyFailed
                ? { kind: 'history-error' as const, message: `Conversation history couldn’t sync${history.error ? `: ${history.error}` : '.'}` }
                : runtimeError
                  ? { kind: 'error' as const, message: runtimeError }
                  : null;
  const statusIdentity = status ? `${status.kind}:${status.message}` : `normal:${runtime?.conversationId ?? ''}`;

  useEffect(() => setDetailsOpen(false), [statusIdentity, runtime?.conversationId]);

  if (runtime?.uncertainDelivery) return <DeliveryRecovery key={runtime.uncertainDelivery.attemptId} runtime={runtime} />;

  if (status) {
    const error = status.kind !== 'progress';
    const retryPending = hasPendingSubmission && !submission;
    const retryHistory = status.kind === 'history-error';
    const recoverable = retryPending || retryHistory;
    const message = status.message.trim() || 'Agent turn failed';
    return (
      <>
        <div
          className="remux-composer-inline-status remux-composer-transient-status"
          data-remux-no-composer-focus
          data-tone={error ? 'error' : 'muted'}
        >
          <div className="remux-composer-status-layout" role={error ? 'alert' : 'status'}>
            <span className="remux-composer-status-group remux-composer-transient-copy">
              {!error ? <Loader2 aria-hidden="true" className="remux-composer-status-spinner animate-spin" /> : null}
              <span className="remux-composer-message-status-text">{message}</span>
            </span>
            {error ? (
              <span className="remux-composer-status-actions">
                {recoverable ? (
                  <button
                    className="remux-composer-message-status-action"
                    onClick={() => {
                      if (retryInFlight.current) return;
                      retryInFlight.current = true;
                      setRetrying(retryPending ? 'submission' : 'history');
                      void (retryPending ? onRetrySubmission() : onRetryHistory())
                        .catch(() => undefined)
                        .finally(() => {
                          retryInFlight.current = false;
                          setRetrying(null);
                        });
                    }}
                    type="button"
                  >
                    Retry
                  </button>
                ) : null}
                <button className="remux-composer-message-status-action" onClick={() => setDetailsOpen(true)} type="button">
                  Details
                </button>
              </span>
            ) : (
              <UsageSummaryButton
                canInspect={canInspect}
                context={context}
                contextTone={contextTone}
                expanded={expanded}
                onToggle={onToggle}
              />
            )}
          </div>
        </div>
        {detailsOpen ? <ErrorDetails message={message} onClose={() => setDetailsOpen(false)} /> : null}
      </>
    );
  }

  if (deliveryReason) return <div className="remux-composer-inline-status" data-remux-no-composer-focus>
    <div className="remux-composer-status-layout" role="status">
      <span className="remux-composer-message-status-text">{deliveryReason}</span>
      <UsageSummaryButton canInspect={canInspect} context={context} contextTone={contextTone} expanded={expanded} onToggle={onToggle} />
    </div>
  </div>;

  return (
    <div className="remux-composer-inline-status" data-remux-no-composer-focus>
      <button
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide usage details' : 'Show usage details'}
        className="remux-composer-inline-status-content"
        data-remux-usage-surface
        disabled={!canInspect}
        onClick={onToggle}
        type="button"
      >
        <span className="remux-composer-status-group">
          {provider ? (
            <span className={`remux-composer-provider-mark is-${provider.provider}`} title={provider.label}>
              {providerMark(provider.provider)}
            </span>
          ) : null}
          <span className="truncate">{model?.name ?? (configuredModel || 'Loading models')}</span>
          {configuredReasoning !== null ? <>
            <span className="remux-composer-status-separator" aria-hidden="true">/</span>
            <span className="truncate">{reasoningLabel(configuredReasoning)} reasoning</span>
          </> : null}
        </span>
        <UsageSummary canInspect={canInspect} context={context} contextTone={contextTone} />
      </button>
    </div>
  );
}

function UsageSummaryButton({ canInspect, context, contextTone, expanded, onToggle }: {
  canInspect: boolean;
  context: AgentRuntimeResource['usage']['context'];
  contextTone: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!canInspect) return null;
  return (
    <button
      aria-expanded={expanded}
      aria-label={expanded ? 'Hide usage details' : 'Show usage details'}
      className="remux-composer-status-usage"
      data-remux-usage-surface
      onClick={onToggle}
      type="button"
    >
      <UsageSummary canInspect={canInspect} context={context} contextTone={contextTone} />
    </button>
  );
}

function UsageSummary({ canInspect, context, contextTone }: {
  canInspect: boolean;
  context: AgentRuntimeResource['usage']['context'];
  contextTone: string;
}) {
  if (context) return (
    <span className="remux-composer-status-group remux-composer-status-group-right">
      <span
        className={`remux-composer-context-percent${contextTone}`}
        title={`${context.usedTokens.toLocaleString()} of ${context.windowTokens.toLocaleString()} context tokens`}
      >
        {Math.round(context.percent)}% context
      </span>
      <span className="remux-composer-status-separator" aria-hidden="true">/</span>
      <span>{compactTokenCount(context.usedTokens)} tokens</span>
    </span>
  );
  return canInspect ? <span className="remux-composer-status-group remux-composer-status-group-right">Usage</span> : null;
}

function ErrorDetails({ message, onClose }: { message: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog aria-label="Error details" className="remux-composer-error-modal" data-remux-no-composer-focus onClose={onClose} ref={dialogRef}>
      <section className="agent-exact-content-dialog remux-composer-error-dialog">
        <header>
          <strong>Error details</strong>
          <button aria-label="Close error details" onClick={() => dialogRef.current?.close()} type="button"><X className="size-4" /></button>
        </header>
        <pre>{message}</pre>
      </section>
    </dialog>
  );
}

function submissionLabel(phase: string) {
  if (phase === 'starting-conversation') return 'Starting conversation';
  if (phase === 'updating-transcript') return 'Updating transcript';
  if (phase === 'waiting-for-connection') return 'Waiting for connection';
  return 'Sending';
}

function providerMark(provider: AgentProvidersResource['providers'][number]['provider']) {
  if (provider === 'claude-code') return 'C';
  if (provider === 'codex') return 'O';
  return 'A';
}

function DeliveryRecovery({ runtime }: { runtime: AgentRuntimeResource }) {
  const delivery = runtime.uncertainDelivery!;
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commandId = useRef(createViewerUuid());
  const inFlight = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (expanded && dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, [expanded]);
  const text = delivery.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  return <>
    <div className="remux-composer-inline-status remux-composer-transient-status" role="status" data-remux-no-composer-focus>
      <div className="remux-composer-status-layout">
      <span className="remux-composer-message-status-text">Message delivery is unconfirmed.</span>
      <button type="button" className="remux-composer-message-status-action"
        onClick={() => setExpanded(true)} aria-expanded={expanded}>Review delivery</button>
      </div>
    </div>
    {expanded ? <dialog aria-label="Delivery recovery" className="remux-composer-error-modal"
      data-remux-no-composer-focus onClose={() => setExpanded(false)} ref={dialogRef}>
      <section className="agent-exact-content-dialog">
        <header><strong>Unconfirmed message</strong>
          <button aria-label="Close delivery recovery" onClick={() => dialogRef.current?.close()} type="button"><X className="size-4" /></button>
        </header>
        <div style={{ display: 'grid', gap: '12px', minHeight: 0, overflow: 'auto', padding: '16px', fontSize: '14px', lineHeight: 1.5 }}>
        <p>The connection ended before receipt was confirmed. The agent may have processed this message.</p>
        <blockquote style={{ whiteSpace: 'pre-wrap', maxHeight: '12rem', overflow: 'auto', margin: 0, padding: '12px', borderRadius: '8px', background: 'var(--secondary)' }}>{text || 'Message with attachments'}</blockquote>
        <p>Ending the interrupted turn keeps the message in the recovery record and does not resend it.
          Delegated work is preserved. You can send a new message afterward.</p>
        {!delivery.canAbandon ? <p>Recovery is waiting for delegated work or delivery evidence to settle.</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        </div>
        <footer><button type="button"
          disabled={busy || !delivery.canAbandon} onClick={() => {
            if (inFlight.current) return;
            inFlight.current = true;
            setBusy(true); setError(null);
            void agentCommands.resolveDelivery(runtime.conversationId, delivery.attemptId, commandId.current)
              .catch((cause) => {
                setError(cause instanceof Error ? cause.message : String(cause));
                commandId.current = createViewerUuid();
              }).finally(() => { inFlight.current = false; setBusy(false); });
          }}>{busy ? 'Ending interrupted turn…' : 'End interrupted turn without resending'}</button></footer>
      </section>
    </dialog> : null}
  </>;
}
