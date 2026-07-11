export type RpcCompletion =
  | 'local-immediate'
  | 'bounded-local-work'
  | 'downstream-ack'
  | 'job-ack'
  | 'long-operation';

export type RpcTimeoutHealth =
  | 'connection-failed'
  | 'probe-connection'
  | 'route-only'
  | 'operation-only';

export type RpcRetry =
  | 'read-safe'
  | 'latest-state'
  | 'effect-idempotent-reconcile'
  | 'deduplicated'
  | 'never';

export type RpcRequestPolicy = Readonly<{
  budget: Readonly<{
    connectWaitMs: number;
    executionMs: number;
    queueMs: number;
    totalMs: number;
    transferMs: number;
  }>;
  completion: RpcCompletion;
  downstreamRetry: 'read-safe' | 'only-definitely-not-written' | 'never';
  effect: 'read' | 'convergent-mutation' | 'mutation';
  executionDeadlineOutcome:
    | 'canceled'
    | 'may-complete-outcome-unknown'
    | 'detached-queryable-job'
    | 'expected-disconnect';
  expectsDisconnect?: boolean;
  idempotency?: 'operation-id' | 'input-sequence' | 'state-revision';
  lane: string;
  method: string;
  name: string;
  retry: RpcRetry;
  timeoutHealth: RpcTimeoutHealth;
}>;

function definePolicy(policy: RpcRequestPolicy): RpcRequestPolicy {
  return Object.freeze({
    ...policy,
    budget: Object.freeze({ ...policy.budget }),
  });
}

const policyList = [
  definePolicy({ name: 'system-ping', method: 'remux/system/ping', effect: 'read', completion: 'local-immediate', lane: 'control:liveness', budget: { connectWaitMs: 0, queueMs: 250, executionMs: 1_000, transferMs: 250, totalMs: 3_000 }, timeoutHealth: 'connection-failed', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'system-info', method: 'remux/system/info', effect: 'read', completion: 'local-immediate', lane: 'control:liveness', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'connection-failed', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'system-restart', method: 'remux/system/restart', effect: 'mutation', completion: 'local-immediate', lane: 'control:global', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'connection-failed', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'expected-disconnect', expectsDisconnect: true }),
  definePolicy({ name: 'system-resources-read', method: 'remux/system/resources', effect: 'read', completion: 'local-immediate', lane: 'snapshot:system', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 3_000, transferMs: 500, totalMs: 5_000 }, timeoutHealth: 'connection-failed', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'client-register', method: 'remux/clients/register', effect: 'convergent-mutation', completion: 'local-immediate', lane: 'control:connection', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_500, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'connection-failed', retry: 'latest-state', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'system-resources-subscribe', method: 'remux/system/resources/subscribe', effect: 'convergent-mutation', completion: 'local-immediate', lane: 'control:connection', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'connection-failed', retry: 'latest-state', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'system-resources-unsubscribe', method: 'remux/system/resources/unsubscribe', effect: 'convergent-mutation', completion: 'local-immediate', lane: 'control:connection', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'connection-failed', retry: 'latest-state', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'extensions-status-read', method: 'remux/extensions/status', effect: 'read', completion: 'local-immediate', lane: 'snapshot:extensions', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 3_000, transferMs: 500, totalMs: 5_000 }, timeoutHealth: 'connection-failed', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'extension-logs-read', method: 'remux/extensions/logs', effect: 'read', completion: 'bounded-local-work', lane: 'snapshot:logs', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 3_000, transferMs: 1_000, totalMs: 5_000 }, timeoutHealth: 'probe-connection', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'extension-logs-subscribe', method: 'remux/extensions/logs/subscribe', effect: 'convergent-mutation', completion: 'local-immediate', lane: 'control:connection', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'connection-failed', retry: 'latest-state', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'extension-logs-unsubscribe', method: 'remux/extensions/logs/unsubscribe', effect: 'convergent-mutation', completion: 'local-immediate', lane: 'control:connection', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'connection-failed', retry: 'latest-state', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'extension-start', method: 'remux/extensions/start', effect: 'mutation', completion: 'long-operation', lane: 'extension:lifecycle', budget: { connectWaitMs: 6_000, queueMs: 5_000, executionMs: 580_000, transferMs: 5_000, totalMs: 600_000 }, timeoutHealth: 'operation-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'extension-stop', method: 'remux/extensions/stop', effect: 'mutation', completion: 'long-operation', lane: 'extension:lifecycle', budget: { connectWaitMs: 6_000, queueMs: 2_000, executionMs: 30_000, transferMs: 2_000, totalMs: 40_000 }, timeoutHealth: 'operation-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'extension-restart', method: 'remux/extensions/restart', effect: 'mutation', completion: 'long-operation', lane: 'extension:lifecycle', budget: { connectWaitMs: 6_000, queueMs: 5_000, executionMs: 580_000, transferMs: 5_000, totalMs: 600_000 }, timeoutHealth: 'operation-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'extension-watch-start', method: 'remux/extensions/watch/start', effect: 'mutation', completion: 'long-operation', lane: 'extension:lifecycle', budget: { connectWaitMs: 6_000, queueMs: 5_000, executionMs: 580_000, transferMs: 5_000, totalMs: 600_000 }, timeoutHealth: 'operation-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'extension-watch-stop', method: 'remux/extensions/watch/stop', effect: 'convergent-mutation', completion: 'long-operation', lane: 'extension:lifecycle', budget: { connectWaitMs: 6_000, queueMs: 2_000, executionMs: 30_000, transferMs: 2_000, totalMs: 40_000 }, timeoutHealth: 'operation-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'extension-server-build', method: 'remux/extensions/server/build', effect: 'mutation', completion: 'long-operation', lane: 'extension:lifecycle', budget: { connectWaitMs: 6_000, queueMs: 5_000, executionMs: 580_000, transferMs: 5_000, totalMs: 600_000 }, timeoutHealth: 'operation-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'extension-views-build', method: 'remux/extensions/views/build', effect: 'mutation', completion: 'long-operation', lane: 'extension:lifecycle', budget: { connectWaitMs: 6_000, queueMs: 5_000, executionMs: 580_000, transferMs: 5_000, totalMs: 600_000 }, timeoutHealth: 'operation-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'fs-directory-read', method: 'remux/fs/readDirectory', effect: 'read', completion: 'bounded-local-work', lane: 'filesystem', budget: { connectWaitMs: 3_000, queueMs: 2_000, executionMs: 20_000, transferMs: 5_000, totalMs: 30_000 }, timeoutHealth: 'probe-connection', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'fs-directories-read', method: 'remux/fs/readDirectories', effect: 'read', completion: 'bounded-local-work', lane: 'filesystem', budget: { connectWaitMs: 3_000, queueMs: 2_000, executionMs: 45_000, transferMs: 10_000, totalMs: 60_000 }, timeoutHealth: 'probe-connection', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'fs-file-read', method: 'remux/fs/readFile', effect: 'read', completion: 'bounded-local-work', lane: 'filesystem', budget: { connectWaitMs: 3_000, queueMs: 2_000, executionMs: 30_000, transferMs: 25_000, totalMs: 60_000 }, timeoutHealth: 'probe-connection', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),

  definePolicy({ name: 'host-viewport-get', method: 'host/viewport/get', effect: 'read', completion: 'local-immediate', lane: 'host:local', budget: { connectWaitMs: 0, queueMs: 0, executionMs: 750, transferMs: 250, totalMs: 1_000 }, timeoutHealth: 'operation-only', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'host-theme-get', method: 'host/theme/get', effect: 'read', completion: 'local-immediate', lane: 'host:local', budget: { connectWaitMs: 0, queueMs: 0, executionMs: 750, transferMs: 250, totalMs: 1_000 }, timeoutHealth: 'operation-only', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'host-keyboard-dismiss', method: 'host/keyboard/dismiss', effect: 'convergent-mutation', completion: 'local-immediate', lane: 'host:local', budget: { connectWaitMs: 0, queueMs: 0, executionMs: 750, transferMs: 250, totalMs: 1_000 }, timeoutHealth: 'operation-only', retry: 'latest-state', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'host-clipboard-read', method: 'host/clipboard/read', effect: 'read', completion: 'bounded-local-work', lane: 'host:local', budget: { connectWaitMs: 0, queueMs: 0, executionMs: 2_500, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'operation-only', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'host-tab-update', method: 'host/tab/update', effect: 'convergent-mutation', completion: 'local-immediate', lane: 'host:local', budget: { connectWaitMs: 0, queueMs: 0, executionMs: 750, transferMs: 250, totalMs: 1_000 }, timeoutHealth: 'operation-only', retry: 'latest-state', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'host-tab-close', method: 'host/tab/close', effect: 'mutation', completion: 'local-immediate', lane: 'host:local', budget: { connectWaitMs: 0, queueMs: 0, executionMs: 750, transferMs: 250, totalMs: 1_000 }, timeoutHealth: 'operation-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'host-view-reload', method: 'host/view/reload', effect: 'mutation', completion: 'local-immediate', lane: 'host:local', budget: { connectWaitMs: 0, queueMs: 0, executionMs: 750, transferMs: 250, totalMs: 1_000 }, timeoutHealth: 'operation-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'host-overview-open', method: 'host/overview/open', effect: 'mutation', completion: 'local-immediate', lane: 'host:local', budget: { connectWaitMs: 0, queueMs: 0, executionMs: 2_500, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'operation-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'host-file-open', method: 'host/file/open', effect: 'mutation', completion: 'local-immediate', lane: 'host:local', budget: { connectWaitMs: 0, queueMs: 0, executionMs: 2_500, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'operation-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'host-link-open', method: 'host/link/open', effect: 'mutation', completion: 'bounded-local-work', lane: 'host:local', budget: { connectWaitMs: 0, queueMs: 0, executionMs: 2_500, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'operation-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'host-attachments-pick', method: 'host/attachments/pick', effect: 'mutation', completion: 'long-operation', lane: 'host:user', budget: { connectWaitMs: 0, queueMs: 0, executionMs: 119_000, transferMs: 1_000, totalMs: 120_000 }, timeoutHealth: 'operation-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),

  definePolicy({ name: 'codex-config-read', method: 'remux/codex/composer/config/read', effect: 'read', completion: 'local-immediate', lane: 'codex:config-read', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'probe-connection', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'codex-config-write', method: 'remux/codex/composer/config/write', effect: 'convergent-mutation', completion: 'bounded-local-work', lane: 'codex:config-write', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 3_000, transferMs: 500, totalMs: 5_000 }, timeoutHealth: 'probe-connection', retry: 'effect-idempotent-reconcile', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'codex-models-read', method: 'remux/codex/models/read', effect: 'read', completion: 'downstream-ack', lane: 'codex:app-read', budget: { connectWaitMs: 3_000, queueMs: 1_000, executionMs: 10_000, transferMs: 1_000, totalMs: 15_000 }, timeoutHealth: 'route-only', retry: 'read-safe', downstreamRetry: 'read-safe', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'codex-files-read', method: 'remux/codex/files', effect: 'read', completion: 'bounded-local-work', lane: 'codex:filesystem', budget: { connectWaitMs: 3_000, queueMs: 2_000, executionMs: 30_000, transferMs: 25_000, totalMs: 60_000 }, timeoutHealth: 'operation-only', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'codex-transcript-read', method: 'remux/codex/transcript/resources/read', effect: 'read', completion: 'bounded-local-work', lane: 'codex:transcript-read', budget: { connectWaitMs: 3_000, queueMs: 2_000, executionMs: 20_000, transferMs: 5_000, totalMs: 30_000 }, timeoutHealth: 'route-only', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'codex-thread-resources-read', method: 'remux/codex/thread/resources/read', effect: 'read', completion: 'downstream-ack', lane: 'codex:app-read', budget: { connectWaitMs: 3_000, queueMs: 2_000, executionMs: 15_000, transferMs: 2_000, totalMs: 20_000 }, timeoutHealth: 'route-only', retry: 'read-safe', downstreamRetry: 'read-safe', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'codex-narration-read', method: 'remux/codex/narration/resources/read', effect: 'read', completion: 'local-immediate', lane: 'codex:narration-read', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'probe-connection', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'codex-narration-audio-read', method: 'remux/codex/narration/audio/read', effect: 'read', completion: 'bounded-local-work', lane: 'codex:filesystem', budget: { connectWaitMs: 3_000, queueMs: 2_000, executionMs: 30_000, transferMs: 25_000, totalMs: 60_000 }, timeoutHealth: 'operation-only', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'codex-narration-start', method: 'remux/codex/narration/start', effect: 'mutation', completion: 'job-ack', lane: 'codex:narration-admission', budget: { connectWaitMs: 3_000, queueMs: 1_000, executionMs: 10_000, transferMs: 1_000, totalMs: 15_000 }, timeoutHealth: 'probe-connection', retry: 'deduplicated', idempotency: 'operation-id', downstreamRetry: 'never', executionDeadlineOutcome: 'detached-queryable-job' }),
  definePolicy({ name: 'codex-narration-cancel', method: 'remux/codex/narration/cancel', effect: 'convergent-mutation', completion: 'local-immediate', lane: 'codex:narration-admission', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'probe-connection', retry: 'effect-idempotent-reconcile', downstreamRetry: 'only-definitely-not-written', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'codex-queue-remove', method: 'remux/codex/thread/queue/remove', effect: 'convergent-mutation', completion: 'local-immediate', lane: 'codex:thread', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'probe-connection', retry: 'effect-idempotent-reconcile', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'codex-queue-run-now', method: 'remux/codex/thread/queue/run-now', effect: 'mutation', completion: 'downstream-ack', lane: 'codex:thread', budget: { connectWaitMs: 3_000, queueMs: 1_000, executionMs: 25_000, transferMs: 1_000, totalMs: 30_000 }, timeoutHealth: 'route-only', retry: 'effect-idempotent-reconcile', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'codex-message-send', method: 'remux/codex/thread/message/send', effect: 'mutation', completion: 'downstream-ack', lane: 'codex:thread', budget: { connectWaitMs: 3_000, queueMs: 1_000, executionMs: 25_000, transferMs: 1_000, totalMs: 30_000 }, timeoutHealth: 'route-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'codex-compact', method: 'remux/codex/thread/compact', effect: 'mutation', completion: 'downstream-ack', lane: 'codex:thread', budget: { connectWaitMs: 3_000, queueMs: 1_000, executionMs: 25_000, transferMs: 1_000, totalMs: 30_000 }, timeoutHealth: 'route-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'codex-message-start', method: 'remux/codex/thread/message/start', effect: 'mutation', completion: 'downstream-ack', lane: 'codex:new-thread', budget: { connectWaitMs: 3_000, queueMs: 2_000, executionMs: 35_000, transferMs: 2_000, totalMs: 45_000 }, timeoutHealth: 'route-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'codex-message-edit', method: 'remux/codex/thread/message/edit', effect: 'mutation', completion: 'downstream-ack', lane: 'codex:thread', budget: { connectWaitMs: 3_000, queueMs: 2_000, executionMs: 35_000, transferMs: 2_000, totalMs: 45_000 }, timeoutHealth: 'route-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'codex-message-fork', method: 'remux/codex/thread/message/fork', effect: 'mutation', completion: 'downstream-ack', lane: 'codex:thread', budget: { connectWaitMs: 3_000, queueMs: 2_000, executionMs: 80_000, transferMs: 2_000, totalMs: 90_000 }, timeoutHealth: 'route-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'codex-turn-interrupt', method: 'remux/codex/thread/turn/interrupt', effect: 'convergent-mutation', completion: 'downstream-ack', lane: 'codex:thread', budget: { connectWaitMs: 3_000, queueMs: 1_000, executionMs: 10_000, transferMs: 1_000, totalMs: 15_000 }, timeoutHealth: 'route-only', retry: 'effect-idempotent-reconcile', downstreamRetry: 'only-definitely-not-written', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),

  definePolicy({ name: 'terminal-session-list', method: 'remux/terminal/session/list', effect: 'read', completion: 'local-immediate', lane: 'terminal:read', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'probe-connection', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'terminal-session-start', method: 'remux/terminal/session/start', effect: 'mutation', completion: 'bounded-local-work', lane: 'terminal:session', budget: { connectWaitMs: 3_000, queueMs: 1_000, executionMs: 7_000, transferMs: 1_000, totalMs: 10_000 }, timeoutHealth: 'probe-connection', retry: 'deduplicated', idempotency: 'operation-id', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'terminal-session-attach', method: 'remux/terminal/session/attach', effect: 'convergent-mutation', completion: 'bounded-local-work', lane: 'terminal:session', budget: { connectWaitMs: 3_000, queueMs: 1_000, executionMs: 5_000, transferMs: 21_000, totalMs: 30_000 }, timeoutHealth: 'probe-connection', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'terminal-session-replay-read', method: 'remux/terminal/session/replay/read', effect: 'read', completion: 'bounded-local-work', lane: 'terminal:replay', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 3_000, transferMs: 500, totalMs: 5_000 }, timeoutHealth: 'route-only', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'terminal-session-detach', method: 'remux/terminal/session/detach', effect: 'convergent-mutation', completion: 'local-immediate', lane: 'terminal:session', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'probe-connection', retry: 'latest-state', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'terminal-session-write', method: 'remux/terminal/session/write', effect: 'mutation', completion: 'local-immediate', lane: 'terminal:session', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'connection-failed', retry: 'deduplicated', idempotency: 'input-sequence', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'terminal-session-resize', method: 'remux/terminal/session/resize', effect: 'convergent-mutation', completion: 'local-immediate', lane: 'terminal:session', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'probe-connection', retry: 'latest-state', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'terminal-session-kill', method: 'remux/terminal/session/kill', effect: 'mutation', completion: 'bounded-local-work', lane: 'terminal:session', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 2_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'probe-connection', retry: 'deduplicated', idempotency: 'state-revision', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
  definePolicy({ name: 'terminal-tmux-context-read', method: 'remux/terminal/tmux/context/get', effect: 'read', completion: 'local-immediate', lane: 'terminal:tmux-read', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 1_000, transferMs: 500, totalMs: 3_000 }, timeoutHealth: 'probe-connection', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'terminal-tmux-refresh', method: 'remux/terminal/tmux/action', effect: 'read', completion: 'bounded-local-work', lane: 'terminal:tmux-read', budget: { connectWaitMs: 3_000, queueMs: 1_000, executionMs: 10_000, transferMs: 1_000, totalMs: 15_000 }, timeoutHealth: 'route-only', retry: 'read-safe', downstreamRetry: 'never', executionDeadlineOutcome: 'canceled' }),
  definePolicy({ name: 'terminal-tmux-mutation', method: 'remux/terminal/tmux/action', effect: 'mutation', completion: 'bounded-local-work', lane: 'terminal:tmux-action', budget: { connectWaitMs: 1_000, queueMs: 500, executionMs: 8_000, transferMs: 500, totalMs: 10_000 }, timeoutHealth: 'route-only', retry: 'never', downstreamRetry: 'never', executionDeadlineOutcome: 'may-complete-outcome-unknown' }),
] as const;

export type BuiltinRpcPolicyName = (typeof policyList)[number]['name'];

const policiesByName = new Map<string, RpcRequestPolicy>();
const requestMethods = new Set<string>();
for (const policy of policyList) {
  if (policiesByName.has(policy.name)) {
    throw new Error(`Duplicate RPC policy name: ${policy.name}`);
  }
  policiesByName.set(policy.name, policy);
  requestMethods.add(policy.method);
}

export const rpcPolicies = Object.freeze(Object.fromEntries(
  policyList.map((policy) => [policy.name, policy]),
) as Record<BuiltinRpcPolicyName, RpcRequestPolicy>);

export function resolveRpcPolicy(name: string, method?: string): RpcRequestPolicy | null {
  const policy = policiesByName.get(name) ?? null;
  if (policy && method !== undefined && policy.method !== method) {
    return null;
  }
  return policy;
}

export function isRegisteredRpcRequestMethod(method: string): boolean {
  return requestMethods.has(method);
}

export function validateRpcPolicy(policy: RpcRequestPolicy): void {
  if (policy.budget.totalMs <= 0 || policy.budget.executionMs <= 0) {
    throw new Error(`RPC policy ${policy.name} has an invalid deadline`);
  }
  if (policy.effect === 'mutation' && policy.retry === 'read-safe') {
    throw new Error(`RPC mutation policy ${policy.name} cannot use read-safe retry`);
  }
  if (policy.retry === 'deduplicated' && !policy.idempotency) {
    throw new Error(`Deduplicated RPC policy ${policy.name} requires idempotency`);
  }
  if (policy.completion === 'long-operation' && policy.timeoutHealth === 'connection-failed') {
    throw new Error(`Long RPC policy ${policy.name} cannot directly fail the connection`);
  }
}

for (const policy of policyList) {
  validateRpcPolicy(policy);
}
