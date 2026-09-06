import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';

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
  runtimeError: string | null;
}) {
  const configuredModel = useComposerStore((state) => state.modelId);
  const models = useComposerStore((state) => state.models);
  const configuredReasoning = useComposerStore((state) => state.reasoning);
  const model = resolveModel(models, configuredModel);
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
