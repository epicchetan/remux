import { createHash } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type {
  NativeAssistantPass,
  NativeConversationSummary,
  NativeConversationVersionSummary,
  NativeOrderedTurnBlock,
  NativeQueueEntry,
  NativeQueuedCompact,
  NativeQueuedMessage,
  RuntimeCompactionView,
} from '../../../shared/native-agent-protocol.ts';
import {
  parseProviderEventEnvelope,
  normalizeLegacyReasoningSummaryPayload,
  type ChildExecutionDisplay,
  type NativeSessionRef,
  type ProviderCapabilities,
  type ProviderEventEnvelope,
  type ProviderKind,
  type ProviderAccountUsage,
  type ProviderProbe,
  type ProviderSnapshotCoverage,
  type ProviderTurnOutcome,
  type UsageDisplay,
  type UserContentPart,
} from '../../../shared/provider-runtime.ts';
import { prepareAgentDataPaths, secureDatabaseSidecars } from '../storage/data-root.ts';
import {
  NATIVE_AGENT_APPLICATION_ID,
  NATIVE_AGENT_SCHEMA_VERSION,
  NativeAgentSchemaError,
  createNativeAgentSchema,
  listNativeAgentTables,
  migrateNativeAgentSchema,
  validateNativeAgentSchema,
} from './schema.ts';

export type NativeAgentJournalOptions = {
  dataRoot?: string;
  env?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
};

export type JournalProviderInstance = {
  providerInstanceId: string;
  provider: ProviderKind;
  label: string;
  probe: ProviderProbe;
  capabilityRevision: string;
  updatedAt: number;
};

export type JournalConversation = NativeConversationSummary & {
  latestTurnId: string | null;
  healthMessage?: string;
};

export type JournalTurn = {
  pathEntryId?: string;
  strandId?: string;
  ordinal?: number;
  turnId: string;
  conversationId: string;
  executionId: string;
  clientMessageId: string;
  commandId: string;
  userContent: readonly UserContentPart[];
  model: string;
  effort?: string;
  serviceTier?: string;
  nativeTurnId?: string;
  assistantArtifactId?: string;
  ordering: 'native-exact' | 'live-provisional' | 'legacy-grouped';
  state: 'queued' | 'running' | 'recovering' | 'completed' | 'failed' | 'interrupted';
  outcome?: ProviderTurnOutcome;
  error?: { code: string; message: string; retryable?: boolean };
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  updatedAt: number;
};

export type JournalComposerPreference = {
  scope: 'provider' | 'conversation' | 'default-provider';
  scopeId: string;
  providerInstanceId: string;
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
  revision: number;
  updatedAt: number;
};

export type JournalCompactionOperation = {
  operationId: string;
  commandId?: string;
  conversationId: string;
  trigger: 'manual' | 'automatic';
  state: 'queued' | 'running' | 'completed' | 'failed' | 'delivery_unknown' | 'cancelled';
  disposition?: 'dispatched' | 'satisfied-by-native-auto';
  generation: number;
  beforeTokens: number | null;
  afterTokens: number | null;
  nativeOperationId?: string;
  providerSubjectKey?: string;
  error?: { code: string; message: string; retryable?: boolean };
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  updatedAt: number;
};

export type JournalCompactionBoundary =
  | {
      kind: 'within-turn';
      turnId: string;
      nativeTurnId: string;
      nativeItemId?: string;
    }
  | {
      kind: 'between-turns';
      nativeTurnId?: string;
      previousNativeTurnId?: string;
      nextNativeTurnId?: string;
    }
  | {
      kind: 'native-unresolved' | 'native-unknown';
      nativeTurnId: string;
    };

export type JournalCompactionControlEvent = {
  controlEventId: string;
  conversationId: string;
  executionId: string;
  boundary: JournalCompactionBoundary;
  state: 'started' | 'completed' | 'failed';
  operationId: string;
  providerSubjectKey: string | null;
  strandId: string | null;
  previousTurnId: string | null;
  nextTurnId: string | null;
  nativeIdentity: string | null;
  trigger: 'manual' | 'automatic';
  beforeTokens: number | null;
  afterTokens: number | null;
  error?: { code: string; message: string; retryable?: boolean };
  createdAt: number;
  completedAt?: number;
};

export type LegacyJournalEvent = {
  sequence: number;
  eventId: string;
  conversationId: string;
  executionId: string;
  turnId?: string;
  nativeKind: string;
  observedAt: number;
  event: Record<string, unknown>;
};

export type JournalExecution = {
  executionId: string;
  conversationId: string;
  strandId?: string;
  parentExecutionId: string | null;
  rootTurnId: string | null;
  ownership: 'root' | 'native' | 'federated';
  provider: ProviderKind;
  providerInstanceId: string;
  model?: string;
  effort?: string;
  serviceTier?: string;
  checkoutKey?: string;
  access?: 'read-only' | 'workspace-write' | 'full-access';
  federationScheduling?: 'background' | 'foreground';
  federationDepth: number;
  title?: string;
  state: 'running' | 'recovering' | 'idle' | 'failed' | 'interrupted';
  outcome?: ProviderTurnOutcome;
  summary?: string;
  lifecycleError?: string;
  transcriptAvailable: boolean;
  createdAt: number;
  completedAt?: number;
  updatedAt: number;
};

export type ArtifactGrantScope = { conversationId: string; executionId: string };
export type ArtifactGrantProvenance =
  | 'viewer-message' | 'viewer-queue' | 'provider-history'
  | 'execution-output' | 'federation-delegation';

export type JournalConversationHead = {
  conversationId: string;
  strandId: string;
  revision: number;
  switchedAt: number;
};

export type JournalConversationStrand = {
  strandId: string;
  conversationId: string;
  sourceStrandId: string | null;
  sourcePathEntryId: string | null;
  cutoffKind: 'root' | 'before' | 'through' | 'restore';
  reason: 'initial' | 'edit' | 'fork' | 'restore' | 'legacy';
  rootExecutionId: string;
  state: 'preparing' | 'ready' | 'failed' | 'orphaned';
  createdAt: number;
  readyAt: number | null;
};

export type JournalStrandPathEntry = {
  pathEntryId: string;
  strandId: string;
  ordinal: number;
  turnId: string;
  sourcePathEntryId: string | null;
  relation: 'local' | 'inherited';
  branchBindingId: string | null;
};

export type JournalNativeTurnBinding = {
  nativeBindingId: string;
  providerInstanceId: string;
  nativeSessionExecutionId: string;
  turnId: string;
  nativeTurnId: string | null;
  branchCursor: unknown | null;
  cursorVersion: number | null;
  bindingState: 'live' | 'authoritative' | 'legacy-unbranchable';
  validatedAt: number;
};

export type CommandReceipt = {
  commandId: string;
  kind: string;
  requestHash: string;
  state: 'received' | 'dispatching' | 'accepted' | 'rejected' | 'recovery_failed';
  result?: unknown;
  errorMessage?: string;
};

export type JournalArtifact = {
  artifactId: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  visibility: 'viewer' | 'diagnostic' | 'private';
  storagePath: string;
  createdAt: number;
};

export class NativeAgentJournal {
  readonly database: DatabaseSync;
  readonly databasePath?: string;
  private closed = false;
  private readonly inFlightCommands = new Map<string, {
    kind: string;
    requestHash: string;
    promise: Promise<unknown>;
  }>();
  private savepointSequence = 0;

  constructor(database: DatabaseSync, databasePath?: string) {
    this.database = database;
    this.databasePath = databasePath;
  }

  transaction<T>(work: () => T): T {
    this.assertOpen();
    const nested = this.database.isTransaction;
    const savepoint = `remux_native_journal_${++this.savepointSequence}`;
    this.database.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      if (nested) {
        this.database.exec(`ROLLBACK TO ${savepoint}`);
        this.database.exec(`RELEASE ${savepoint}`);
      } else {
        this.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  runAsyncCommand<T>(
    commandId: string,
    kind: string,
    request: unknown,
    body: () => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    const requestHash = hashJson(request);
    const existing = this.inFlightCommands.get(commandId);
    if (existing) {
      if (existing.kind !== kind || existing.requestHash !== requestHash) {
        return Promise.reject(new CommandReceiptConflictError(commandId));
      }
      return existing.promise as Promise<T>;
    }

    let resolveOwner!: (value: T | PromiseLike<T>) => void;
    let rejectOwner!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolveOwner = resolve;
      rejectOwner = reject;
    });
    this.inFlightCommands.set(commandId, { kind, requestHash, promise });
    const cleanup = () => {
      if (this.inFlightCommands.get(commandId)?.promise === promise) {
        this.inFlightCommands.delete(commandId);
      }
    };
    promise.then(cleanup, cleanup);
    try {
      body().then(resolveOwner, rejectOwner);
    } catch (error) {
      rejectOwner(error);
    }
    return promise;
  }

  hasUnresolvedRootDelivery(conversationId: string) {
    const row = this.database.prepare(`SELECT 1 AS matched FROM delivery_attempts a
      WHERE a.conversation_id=? AND (a.state IN ('preparing','dispatching','unknown') OR
        (a.state='accepted' AND EXISTS(
          SELECT 1 FROM delivery_attempt_staging s WHERE s.attempt_id=a.attempt_id)))
      LIMIT 1`).get(conversationId) as { matched: number } | undefined;
    return row?.matched === 1;
  }

  upsertProviderInstance(input: {
    providerInstanceId: string;
    provider: ProviderKind;
    label: string;
    probe: ProviderProbe;
    now: number;
  }) {
    const capabilityRevision = hashJson(input.probe.capabilities ?? {
      state: input.probe.state,
      diagnosticCode: input.probe.diagnosticCode ?? null,
    });
    this.database.prepare(`
      INSERT INTO provider_instances(
        provider_instance_id, provider, label, probe_state, probe_json,
        capability_revision, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_instance_id) DO UPDATE SET
        provider = excluded.provider,
        label = excluded.label,
        probe_state = excluded.probe_state,
        probe_json = excluded.probe_json,
        capability_revision = excluded.capability_revision,
        updated_at = excluded.updated_at
    `).run(
      input.providerInstanceId,
      input.provider,
      input.label,
      input.probe.state,
      JSON.stringify(input.probe),
      capabilityRevision,
      input.now,
    );
    return capabilityRevision;
  }

  listProviderInstances(): JournalProviderInstance[] {
    return (this.database.prepare(`
      SELECT * FROM provider_instances ORDER BY provider_instance_id
    `).all() as Record<string, unknown>[]).map(providerRow);
  }

  providerInstance(providerInstanceId: string) {
    const row = this.database.prepare(`
      SELECT * FROM provider_instances WHERE provider_instance_id = ?
    `).get(providerInstanceId) as Record<string, unknown> | undefined;
    return row ? providerRow(row) : undefined;
  }

  registerArtifact(input: JournalArtifact) {
    const existing = this.artifact(input.artifactId);
    if (existing) {
      if (
        existing.sha256 !== input.sha256 ||
        existing.byteLength !== input.byteLength ||
        existing.mediaType !== input.mediaType ||
        existing.storagePath !== input.storagePath
      ) throw new Error(`Artifact ${input.artifactId} metadata conflicts with durable storage.`);
      return existing;
    }
    this.database.prepare(`
      INSERT INTO artifacts(
        artifact_id, sha256, byte_length, media_type, visibility, storage_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.artifactId,
      input.sha256,
      input.byteLength,
      input.mediaType,
      input.visibility,
      input.storagePath,
      input.createdAt,
    );
    return input;
  }

  artifact(artifactId: string): JournalArtifact | undefined {
    const row = this.database.prepare(`
      SELECT * FROM artifacts WHERE artifact_id = ?
    `).get(artifactId) as Record<string, unknown> | undefined;
    return row ? artifactRow(row) : undefined;
  }

  grantArtifact(input: {
    artifactId: string;
    conversationId: string;
    executionId?: string;
    provenance: ArtifactGrantProvenance;
    sourceTurnId?: string;
    sourceExecutionId?: string;
    createdAt: number;
  }) {
    const conversation = this.conversation(input.conversationId);
    if (!conversation) throw new Error('Artifact grant conversation does not exist.');
    if (input.executionId) this.requireGrantExecution(input.conversationId, input.executionId);
    if (input.sourceExecutionId) {
      this.requireGrantExecution(input.conversationId, input.sourceExecutionId);
    }
    if (input.sourceTurnId) {
      const turn = this.turn(input.sourceTurnId);
      if (!turn || turn.conversationId !== input.conversationId ||
          (input.sourceExecutionId && turn.executionId !== input.sourceExecutionId)) {
        throw new Error('Artifact grant source turn does not match its source execution.');
      }
    }
    const artifact = this.artifact(input.artifactId);
    if (!artifact || artifact.visibility !== 'viewer') {
      throw new Error(`Viewer artifact ${input.artifactId} does not exist.`);
    }
    this.database.prepare(`
      INSERT OR IGNORE INTO artifact_grants(
        artifact_id, conversation_id, execution_id, provenance,
        source_turn_id, source_execution_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.artifactId, input.conversationId, input.executionId ?? null,
      input.provenance, input.sourceTurnId ?? null, input.sourceExecutionId ?? null,
      input.createdAt);
  }

  grantImageContent(input: {
    scope: ArtifactGrantScope;
    content: readonly UserContentPart[];
    provenance: ArtifactGrantProvenance;
    sourceTurnId?: string;
    sourceExecutionId?: string;
    createdAt: number;
  }) {
    this.requireGrantExecution(input.scope.conversationId, input.scope.executionId);
    this.assertImageContentMetadata(input.content);
    const viewerShared = input.provenance === 'viewer-message' || input.provenance === 'viewer-queue';
    for (const part of input.content) if (part.type === 'image-artifact') this.grantArtifact({
      artifactId: part.artifactId,
      conversationId: input.scope.conversationId,
      ...(viewerShared ? {} : { executionId: input.scope.executionId }),
      provenance: input.provenance,
      ...(input.sourceTurnId ? { sourceTurnId: input.sourceTurnId } : {}),
      ...(!viewerShared && input.sourceExecutionId
        ? { sourceExecutionId: input.sourceExecutionId } : {}),
      createdAt: input.createdAt,
    });
  }

  assertImageContentMetadata(content: readonly UserContentPart[]) {
    for (const part of content) {
      if (part.type !== 'image-artifact') continue;
      const artifact = this.artifact(part.artifactId);
      if (!artifact || artifact.visibility !== 'viewer' ||
          artifact.mediaType !== part.mimeType || !artifact.mediaType.startsWith('image/')) {
        throw new Error(`Image artifact ${part.artifactId} does not match its attachment metadata.`);
      }
    }
  }

  artifactGrantedTo(scope: ArtifactGrantScope, artifactId: string) {
    this.requireGrantExecution(scope.conversationId, scope.executionId);
    const seen = new Set<string>();
    const lineage: string[] = [];
    let executionId: string | null = scope.executionId;
    for (let depth = 0; executionId && depth < 256; depth += 1) {
      if (seen.has(executionId)) throw new Error('Artifact grant execution lineage is cyclic.');
      seen.add(executionId);
      lineage.push(executionId);
      const row = this.database.prepare(`
        SELECT parent_execution_id FROM executions
        WHERE conversation_id = ? AND execution_id = ?
      `).get(scope.conversationId, executionId) as { parent_execution_id: string | null } | undefined;
      if (!row) throw new Error('Artifact grant execution lineage is invalid.');
      executionId = row.parent_execution_id;
    }
    if (executionId) throw new Error('Artifact grant execution lineage exceeds the safety bound.');
    if (this.database.prepare(`
      SELECT 1 AS granted FROM artifact_grants
      WHERE artifact_id = ? AND conversation_id = ? AND execution_id IS NULL
    `).get(artifactId, scope.conversationId)) return true;
    return lineage.some((candidate) => Boolean(this.database.prepare(`
      SELECT 1 AS granted FROM artifact_grants
      WHERE artifact_id = ? AND conversation_id = ? AND execution_id = ?
    `).get(artifactId, scope.conversationId, candidate)));
  }

  assertImageContentAuthorized(scope: ArtifactGrantScope, content: readonly UserContentPart[]) {
    this.requireGrantExecution(scope.conversationId, scope.executionId);
    for (const part of content) {
      if (part.type !== 'image-artifact') continue;
      const artifact = this.artifact(part.artifactId);
      if (!artifact || artifact.visibility !== 'viewer' || artifact.mediaType !== part.mimeType ||
          !artifact.mediaType.startsWith('image/') || !this.artifactGrantedTo(scope, part.artifactId)) {
        throw new Error(`Image artifact ${part.artifactId} is outside the provider execution scope.`);
      }
    }
  }

  private requireGrantExecution(conversationId: string, executionId: string) {
    const execution = this.execution(executionId);
    if (!execution || execution.conversationId !== conversationId) {
      throw new Error('Artifact grant execution does not belong to its conversation.');
    }
    return execution;
  }

  setTurnAssistantArtifact(turnId: string, artifactId: string | null, now: number) {
    this.database.prepare(`
      UPDATE turns SET assistant_artifact_id = ?, updated_at = ? WHERE turn_id = ?
    `).run(artifactId, now, turnId);
  }

  claimCommand(commandId: string, kind: string, request: unknown, now: number) {
    const requestHash = hashJson(request);
    const inFlight = this.inFlightCommands.get(commandId);
    if (inFlight && (inFlight.kind !== kind || inFlight.requestHash !== requestHash)) {
      throw new CommandReceiptConflictError(commandId);
    }
    const existing = this.commandReceipt(commandId);
    if (existing) {
      if (existing.kind !== kind || existing.requestHash !== requestHash) {
        throw new CommandReceiptConflictError(commandId);
      }
      return { created: false, receipt: existing } as const;
    }
    this.database.prepare(`
      INSERT INTO command_receipts(
        command_id, kind, request_hash, state, created_at, updated_at
      ) VALUES (?, ?, ?, 'received', ?, ?)
    `).run(commandId, kind, requestHash, now, now);
    return { created: true, receipt: this.commandReceipt(commandId)! } as const;
  }

  inspectCommand(commandId: string, kind: string, request: unknown) {
    const requestHash = hashJson(request);
    const receipt = this.commandReceipt(commandId);
    if (receipt && (receipt.kind !== kind || receipt.requestHash !== requestHash)) {
      throw new CommandReceiptConflictError(commandId);
    }
    return receipt;
  }

  commandReceipt(commandId: string): CommandReceipt | undefined {
    const row = this.database.prepare(`
      SELECT * FROM command_receipts WHERE command_id = ?
    `).get(commandId) as Record<string, unknown> | undefined;
    return row ? receiptRow(row) : undefined;
  }

  markCommandDispatching(commandId: string, now: number) {
    this.database.prepare(`
      UPDATE command_receipts SET state = 'dispatching', updated_at = ?
      WHERE command_id = ? AND state = 'received'
    `).run(now, commandId);
  }

  acceptCommand(commandId: string, result: unknown, now: number) {
    this.database.prepare(`
      UPDATE command_receipts
      SET state = 'accepted', result_json = ?, error_message = NULL, updated_at = ?
      WHERE command_id = ? AND state IN ('received', 'dispatching')
    `).run(JSON.stringify(result), now, commandId);
  }

  rejectCommand(commandId: string, message: string, now: number) {
    this.database.prepare(`
      UPDATE command_receipts
      SET state = 'rejected', error_message = ?, updated_at = ?
      WHERE command_id = ? AND state IN ('received', 'dispatching')
    `).run(message, now, commandId);
  }

  failCommandRecovery(commandId: string, message: string, now: number) {
    this.database.prepare(`
      UPDATE command_receipts
      SET state = 'recovery_failed', error_message = ?, updated_at = ?
      WHERE command_id = ? AND state IN ('received', 'dispatching')
    `).run(message, now, commandId);
  }

  markAmbiguousCommandsForRecovery(now: number) {
    // Delivery-capable commands are reconciled by their per-kind durable owner.
    // Other provider-effecting commands have no sound negative proof after a
    // restart, so retain their unresolved receipt instead of reporting failure.
    void now;
    return 0;
  }

  createConversation(input: {
    conversationId: string;
    rootExecutionId: string;
    strandId?: string;
    provider: ProviderKind;
    providerInstanceId: string;
    title: string;
    cwd: string;
    model: string;
    effort?: string;
    serviceTier?: string;
    access: 'read-only' | 'workspace-write' | 'full-access';
    parentConversationId?: string;
    rootConversationId?: string;
    forkedFromPathEntryId?: string;
    titleSource?: 'generated' | 'manual' | 'legacy';
    strandState?: 'preparing' | 'ready';
    now: number;
  }) {
    const strandId = input.strandId ?? `strand:${input.conversationId}`;
    const rootConversationId = input.rootConversationId ?? input.conversationId;
    const strandState = input.strandState ?? 'ready';
    this.transaction(() => {
      this.database.prepare(`
      INSERT INTO conversations(
        conversation_id, provider_instance_id, root_execution_id,
        parent_conversation_id, root_conversation_id, forked_from_path_entry_id,
        title, title_source, preview, cwd, model, effort, service_tier, access, state,
        history_state, history_synced_at, resumable, metadata_revision, subtree_updated_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 'recovering',
        'ready', ?, 0, 1, ?, ?, ?)
      `).run(
        input.conversationId,
        input.providerInstanceId,
        input.rootExecutionId,
        input.parentConversationId ?? null,
        rootConversationId,
        input.forkedFromPathEntryId ?? null,
        input.title,
        input.titleSource ?? 'generated',
        input.cwd,
        input.model,
        input.effort ?? null,
        input.serviceTier ?? null,
        input.access,
        input.now,
        input.now,
        input.now,
        input.now,
      );
      this.database.prepare(`
      INSERT INTO executions(
        execution_id, conversation_id, strand_id, parent_execution_id, root_turn_id,
        ownership, provider, provider_instance_id, model, effort, service_tier, access,
        federation_scheduling, federation_depth, title, state,
        transcript_available, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, NULL, 'root', ?, ?, ?, ?, ?, ?, NULL, 0, ?, 'recovering', 1, ?, ?)
      `).run(
        input.rootExecutionId,
        input.conversationId,
        strandId,
        input.provider,
        input.providerInstanceId,
        input.model,
        input.effort ?? null,
        input.serviceTier ?? null,
        input.access,
        input.title,
        input.now,
        input.now,
      );
      this.database.prepare(`
        INSERT INTO conversation_strands(
          strand_id, conversation_id, source_strand_id, source_path_entry_id,
          cutoff_kind, reason, root_execution_id, state, created_at, ready_at
        ) VALUES (?, ?, NULL, NULL, 'root', ?, ?, ?, ?, ?)
      `).run(
        strandId,
        input.conversationId,
        input.parentConversationId ? 'fork' : 'initial',
        input.rootExecutionId,
        strandState,
        input.now,
        strandState === 'ready' ? input.now : null,
      );
      this.database.prepare(`
        INSERT INTO conversation_heads(conversation_id, strand_id, revision, switched_at)
        VALUES (?, ?, 1, ?)
      `).run(input.conversationId, strandId, input.now);
      if (input.parentConversationId && strandState === 'ready') {
        this.touchConversationFamily(rootConversationId, input.now);
      }
    });
  }

  createConversationStrand(input: {
    strandId: string;
    conversationId: string;
    sourceStrandId: string;
    sourcePathEntryId: string;
    cutoffKind: 'before' | 'through' | 'restore';
    reason: 'edit' | 'restore';
    rootExecutionId: string;
    provider: ProviderKind;
    providerInstanceId: string;
    model: string;
    effort?: string;
    serviceTier?: string;
    access: 'read-only' | 'workspace-write' | 'full-access';
    title: string;
    now: number;
  }) {
    this.transaction(() => {
      const conversation = this.conversation(input.conversationId);
      if (!conversation) throw new Error(`Conversation ${input.conversationId} does not exist.`);
      const source = this.strand(input.sourceStrandId);
      if (!source || source.conversationId !== input.conversationId) {
        throw new Error('The source strand does not belong to the conversation.');
      }
      this.database.prepare(`
        INSERT INTO executions(
          execution_id, conversation_id, strand_id, parent_execution_id, root_turn_id,
          ownership, provider, provider_instance_id, model, effort, service_tier, access,
          federation_scheduling, federation_depth, title, state,
          transcript_available, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, NULL, 'root', ?, ?, ?, ?, ?, ?, NULL, 0, ?,
          'recovering', 1, ?, ?)
      `).run(
        input.rootExecutionId,
        input.conversationId,
        input.strandId,
        input.provider,
        input.providerInstanceId,
        input.model,
        input.effort ?? null,
        input.serviceTier ?? null,
        input.access,
        input.title,
        input.now,
        input.now,
      );
      this.database.prepare(`
        INSERT INTO conversation_strands(
          strand_id, conversation_id, source_strand_id, source_path_entry_id,
          cutoff_kind, reason, root_execution_id, state, created_at, ready_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', ?, NULL)
      `).run(
        input.strandId,
        input.conversationId,
        input.sourceStrandId,
        input.sourcePathEntryId,
        input.cutoffKind,
        input.reason,
        input.rootExecutionId,
        input.now,
      );
    });
  }

  copyStrandPrefix(input: {
    sourceStrandId: string;
    destinationStrandId: string;
    boundaryPathEntryId: string;
    includeBoundary: boolean;
  }) {
    const boundary = this.pathEntry(input.boundaryPathEntryId);
    if (!boundary || boundary.strandId !== input.sourceStrandId) {
      throw new Error('The branch boundary is not on the source strand.');
    }
    const comparison = input.includeBoundary ? '<=' : '<';
    this.database.prepare(`
      INSERT INTO strand_turn_path(
        path_entry_id, strand_id, ordinal, turn_id, source_path_entry_id,
        relation, branch_binding_id
      )
      SELECT 'path:' || ? || ':' || p.ordinal, ?, p.ordinal, p.turn_id,
        p.path_entry_id, 'inherited', p.branch_binding_id
      FROM strand_turn_path p
      WHERE p.strand_id = ? AND p.ordinal ${comparison} ?
      ORDER BY p.ordinal
    `).run(
      input.destinationStrandId,
      input.destinationStrandId,
      input.sourceStrandId,
      boundary.ordinal,
    );
  }

  markStrandReady(strandId: string, now: number) {
    const result = this.database.prepare(`
      UPDATE conversation_strands
      SET state = 'ready', ready_at = ?, failed_at = NULL
      WHERE strand_id = ? AND state = 'preparing'
    `).run(now, strandId);
    if (result.changes !== 1) throw new Error(`Strand ${strandId} is not preparing.`);
    const strand = this.strand(strandId);
    const conversation = strand ? this.conversation(strand.conversationId) : undefined;
    if (conversation) this.touchConversationFamily(conversation.rootConversationId, now);
  }

  failStrand(strandId: string, now: number) {
    this.database.prepare(`
      UPDATE conversation_strands SET state = 'failed', failed_at = ?
      WHERE strand_id = ? AND state IN ('preparing', 'ready')
    `).run(now, strandId);
  }

  activateConversationStrand(input: {
    conversationId: string;
    strandId: string;
    expectedRevision: number;
    now: number;
  }) {
    return this.transaction(() => {
      const strand = this.strand(input.strandId);
      if (!strand || strand.conversationId !== input.conversationId || strand.state !== 'ready') {
        throw new Error('Only a ready strand belonging to the conversation can be activated.');
      }
      const swapped = this.database.prepare(`
        UPDATE conversation_heads
        SET strand_id = ?, revision = revision + 1, switched_at = ?
        WHERE conversation_id = ? AND revision = ?
      `).run(input.strandId, input.now, input.conversationId, input.expectedRevision);
      if (swapped.changes !== 1) throw new ConversationHeadConflictError(input.conversationId);
      const latest = this.database.prepare(`
        SELECT t.turn_id, t.state
        FROM strand_turn_path p JOIN turns t USING(turn_id)
        WHERE p.strand_id = ? ORDER BY p.ordinal DESC LIMIT 1
      `).get(input.strandId) as { turn_id: string; state: JournalTurn['state'] } | undefined;
      const execution = this.execution(strand.rootExecutionId);
      if (!execution) throw new Error('The strand root execution is missing.');
      const activeTurnId = latest && ['running', 'recovering'].includes(latest.state)
        ? latest.turn_id
        : null;
      this.database.prepare(`
        UPDATE conversations
        SET root_execution_id = ?, latest_turn_id = ?, active_turn_id = ?,
          model = COALESCE(?, model), effort = ?, access = COALESCE(?, access),
          state = ?, health_message = NULL, resumable = 1,
          subtree_updated_at = ?, updated_at = ?
        WHERE conversation_id = ?
      `).run(
        strand.rootExecutionId,
        latest?.turn_id ?? null,
        activeTurnId,
        execution.model ?? null,
        execution.effort ?? null,
        execution.access ?? null,
        execution.state,
        input.now,
        input.now,
        input.conversationId,
      );
      const conversation = this.conversation(input.conversationId)!;
      this.touchConversationFamily(conversation.rootConversationId, input.now);
      return this.conversationHead(input.conversationId)!;
    });
  }

  conversationHead(conversationId: string): JournalConversationHead | undefined {
    const row = this.database.prepare(`
      SELECT * FROM conversation_heads WHERE conversation_id = ?
    `).get(conversationId) as Record<string, unknown> | undefined;
    return row ? conversationHeadRow(row) : undefined;
  }

  strand(strandId: string): JournalConversationStrand | undefined {
    const row = this.database.prepare(`
      SELECT * FROM conversation_strands WHERE strand_id = ?
    `).get(strandId) as Record<string, unknown> | undefined;
    return row ? conversationStrandRow(row) : undefined;
  }

  conversationStrands(conversationId: string): JournalConversationStrand[] {
    return (this.database.prepare(`
      SELECT * FROM conversation_strands
      WHERE conversation_id = ? AND state IN ('ready', 'orphaned')
      ORDER BY created_at DESC, strand_id DESC
    `).all(conversationId) as Record<string, unknown>[]).map(conversationStrandRow);
  }

  conversationVersions(conversationId: string): NativeConversationVersionSummary[] {
    const head = this.conversationHead(conversationId);
    return (this.database.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM strand_turn_path p WHERE p.strand_id = s.strand_id) AS turn_count,
        COALESCE((
          SELECT t.user_content_json FROM strand_turn_path p
          JOIN turns t USING(turn_id)
          WHERE p.strand_id = s.strand_id ORDER BY p.ordinal DESC LIMIT 1
        ), '[]') AS last_content_json
      FROM conversation_strands s
      WHERE s.conversation_id = ? AND s.state IN ('ready', 'orphaned')
      ORDER BY s.created_at DESC, s.strand_id DESC
    `).all(conversationId) as Record<string, unknown>[]).map((row) => ({
      strandId: String(row.strand_id),
      active: String(row.strand_id) === head?.strandId,
      reason: row.reason as NativeConversationVersionSummary['reason'],
      sourceStrandId: row.source_strand_id === null ? null : String(row.source_strand_id),
      sourcePathEntryId: row.source_path_entry_id === null
        ? null
        : String(row.source_path_entry_id),
      turnCount: Number(row.turn_count),
      preview: previewText(JSON.parse(String(row.last_content_json)) as UserContentPart[]),
      createdAt: Number(row.created_at),
    }));
  }

  pathEntry(pathEntryId: string): JournalStrandPathEntry | undefined {
    const row = this.database.prepare(`
      SELECT * FROM strand_turn_path WHERE path_entry_id = ?
    `).get(pathEntryId) as Record<string, unknown> | undefined;
    return row ? strandPathRow(row) : undefined;
  }

  strandPath(strandId: string): JournalStrandPathEntry[] {
    return (this.database.prepare(`
      SELECT * FROM strand_turn_path WHERE strand_id = ? ORDER BY ordinal
    `).all(strandId) as Record<string, unknown>[]).map(strandPathRow);
  }

  /**
   * Removes path entries created when a fork's inherited provider transcript
   * was imported as local history even though the same native turn already
   * had a canonical Remux turn. Event/turn audit rows are retained. Branch
   * boundaries are never rewritten.
   */
  repairDuplicatedNativeImportsInStrands() {
    return this.transaction(() => {
      const candidates = this.database.prepare(`
        SELECT p.path_entry_id, p.strand_id
        FROM strand_turn_path p
        JOIN conversation_strands s ON s.strand_id = p.strand_id
        JOIN turns imported ON imported.turn_id = p.turn_id
        WHERE imported.command_id LIKE 'native-import-command:%'
          AND imported.native_turn_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM turns canonical
            WHERE canonical.conversation_id = imported.conversation_id
              AND canonical.native_turn_id = imported.native_turn_id
              AND canonical.turn_id <> imported.turn_id
              AND canonical.command_id NOT LIKE 'native-import-command:%'
          )
          AND NOT EXISTS (
            SELECT 1 FROM branch_operations operation
            WHERE operation.source_path_entry_id = p.path_entry_id
          )
        ORDER BY p.strand_id, p.ordinal
      `).all() as Array<{ path_entry_id: string; strand_id: string }>;
      if (candidates.length === 0) return 0;

      const affectedStrands = new Set(candidates.map(({ strand_id }) => strand_id));
      const detachChildren = this.database.prepare(`
        UPDATE strand_turn_path SET source_path_entry_id = NULL WHERE source_path_entry_id = ?
      `);
      const removePathEntry = this.database.prepare(`
        DELETE FROM strand_turn_path WHERE path_entry_id = ?
      `);
      for (const candidate of candidates) {
        detachChildren.run(candidate.path_entry_id);
        removePathEntry.run(candidate.path_entry_id);
      }

      const moveOrdinals = this.database.prepare(`
        UPDATE strand_turn_path SET ordinal = ordinal + ? WHERE strand_id = ?
      `);
      const listEntries = this.database.prepare(`
        SELECT path_entry_id FROM strand_turn_path WHERE strand_id = ? ORDER BY ordinal
      `);
      const setOrdinal = this.database.prepare(`
        UPDATE strand_turn_path SET ordinal = ? WHERE path_entry_id = ?
      `);
      for (const strandId of affectedStrands) {
        const maximum = this.database.prepare(`
          SELECT COALESCE(MAX(ordinal), -1) AS maximum
          FROM strand_turn_path WHERE strand_id = ?
        `).get(strandId) as { maximum: number };
        moveOrdinals.run(maximum.maximum + candidates.length + 1, strandId);
        const entries = listEntries.all(strandId) as Array<{ path_entry_id: string }>;
        entries.forEach(({ path_entry_id }, ordinal) => setOrdinal.run(ordinal, path_entry_id));
      }
      return candidates.length;
    });
  }

  activePathEntryForTurn(conversationId: string, turnId: string) {
    const row = this.database.prepare(`
      SELECT p.* FROM strand_turn_path p
      JOIN conversation_heads h USING(strand_id)
      WHERE h.conversation_id = ? AND p.turn_id = ?
    `).get(conversationId, turnId) as Record<string, unknown> | undefined;
    return row ? strandPathRow(row) : undefined;
  }

  nativeTurnBinding(executionId: string, turnId: string): JournalNativeTurnBinding | undefined {
    const row = this.database.prepare(`
      SELECT * FROM native_turn_bindings
      WHERE native_session_execution_id = ? AND turn_id = ?
    `).get(executionId, turnId) as Record<string, unknown> | undefined;
    return row ? nativeTurnBindingRow(row) : undefined;
  }

  upsertNativeTurnBinding(input: {
    providerInstanceId: string;
    executionId: string;
    turnId: string;
    nativeTurnId?: string;
    branchCursor?: unknown;
    cursorVersion?: number;
    state?: 'live' | 'authoritative' | 'legacy-unbranchable';
    now: number;
  }) {
    const nativeBindingId = `binding:${input.executionId}:${input.turnId}`;
    this.database.prepare(`
      INSERT INTO native_turn_bindings(
        native_binding_id, provider_instance_id, native_session_execution_id,
        turn_id, native_turn_id, branch_cursor_json, cursor_version,
        binding_state, validated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(native_session_execution_id, turn_id) DO UPDATE SET
        native_turn_id = COALESCE(excluded.native_turn_id, native_turn_id),
        branch_cursor_json = COALESCE(excluded.branch_cursor_json, branch_cursor_json),
        cursor_version = COALESCE(excluded.cursor_version, cursor_version),
        binding_state = excluded.binding_state,
        validated_at = MAX(validated_at, excluded.validated_at)
    `).run(
      nativeBindingId,
      input.providerInstanceId,
      input.executionId,
      input.turnId,
      input.nativeTurnId ?? null,
      input.branchCursor === undefined ? null : JSON.stringify(input.branchCursor),
      input.cursorVersion ?? null,
      input.state ?? 'authoritative',
      input.now,
    );
    if (input.nativeTurnId) {
      this.database.prepare(`
        UPDATE turns SET native_turn_id = COALESCE(native_turn_id, ?),
          updated_at = MAX(updated_at, ?)
        WHERE turn_id = ?
      `).run(input.nativeTurnId, input.now, input.turnId);
    }
    this.database.prepare(`
      UPDATE strand_turn_path SET branch_binding_id = ?
      WHERE turn_id = ? AND branch_binding_id IS NULL
    `).run(nativeBindingId, input.turnId);
    if (input.nativeTurnId) {
      this.resolveCompactionBoundariesForNativeTurn(
        input.executionId,
        input.turnId,
        input.nativeTurnId,
      );
    }
    return this.nativeTurnBinding(input.executionId, input.turnId)!;
  }

  createBranchOperation(input: {
    operationId: string;
    commandId: string;
    mode: 'edit' | 'fork' | 'restore';
    sourceConversationId: string;
    sourceStrandId: string;
    sourcePathEntryId: string;
    expectedHeadRevision: number;
    destinationConversationId: string;
    destinationStrandId: string;
    destinationExecutionId: string;
    now: number;
  }) {
    this.database.prepare(`
      INSERT INTO branch_operations(
        operation_id, command_id, mode, source_conversation_id, source_strand_id,
        source_path_entry_id, expected_head_revision, destination_conversation_id,
        destination_strand_id, destination_execution_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?)
    `).run(
      input.operationId,
      input.commandId,
      input.mode,
      input.sourceConversationId,
      input.sourceStrandId,
      input.sourcePathEntryId,
      input.expectedHeadRevision,
      input.destinationConversationId,
      input.destinationStrandId,
      input.destinationExecutionId,
      input.now,
      input.now,
    );
  }

  updateBranchOperation(
    operationId: string,
    state: 'native-forking' | 'native-prepared' | 'prefix-validated' |
      'turn-dispatching' | 'accepted' | 'activated' | 'failed' | 'delivery-unknown',
    now: number,
    detail?: unknown,
  ) {
    this.database.prepare(`
      UPDATE branch_operations
      SET state = ?,
        native_result_json = CASE WHEN ? = 'native-prepared' THEN ? ELSE native_result_json END,
        error_json = CASE WHEN ? IN ('failed', 'delivery-unknown') THEN ? ELSE error_json END,
        updated_at = ?
      WHERE operation_id = ?
    `).run(
      state,
      state,
      state === 'native-prepared' && detail !== undefined ? JSON.stringify(detail) : null,
      state,
      (state === 'failed' || state === 'delivery-unknown') && detail !== undefined
        ? JSON.stringify(detail)
        : null,
      now,
      operationId,
    );
  }

  failInterruptedBranchOperations(now: number) {
    return this.transaction(() => {
      this.database.prepare(`
        UPDATE conversation_strands
        SET state = 'failed', failed_at = ?
        WHERE state = 'preparing'
          AND strand_id IN (
            SELECT destination_strand_id FROM branch_operations
            WHERE state NOT IN ('activated', 'failed', 'delivery-unknown')
          )
      `).run(now);
      return this.database.prepare(`
        UPDATE branch_operations
        SET state = CASE
          WHEN state IN ('turn-dispatching', 'accepted') THEN 'delivery-unknown'
          ELSE 'failed'
        END,
        error_json = json_object(
          'code', 'branch_recovery_required',
          'message', 'Remux restarted before this branch reached an atomic activation boundary.'
        ),
        updated_at = ?
        WHERE state NOT IN ('activated', 'failed', 'delivery-unknown')
      `).run(now).changes;
    });
  }

  importDiscoveredConversation(input: {
    conversationId: string;
    rootExecutionId: string;
    nativeSession: NativeSessionRef;
    adapterVersion: string;
    title: string;
    preview: string;
    cwd: string;
    model: string;
    effort?: string;
    serviceTier?: string;
    access: 'read-only' | 'workspace-write' | 'full-access';
    historyRevision?: string;
    createdAt: number;
    observedAt: number;
    updatedAt?: number;
  }) {
    const existing = this.executionForNativeSession(
      input.nativeSession.providerInstanceId,
      input.nativeSession.sessionId,
    );
    if (existing) {
      const conversation = this.conversation(existing.conversationId);
      const revisionChanged = Boolean(
        input.historyRevision &&
        conversation?.history.nativeRevision !== input.historyRevision,
      );
      this.transaction(() => {
        // Discovery refreshes the durable provider pointer without changing
        // recovery/running state owned by the Remux execution lifecycle.
        this.database.prepare(`
          UPDATE native_sessions
          SET native_session_id = ?, private_ref_json = ?, adapter_version = ?,
            state = 'ready', last_observed_at = MAX(last_observed_at, ?)
          WHERE execution_id = ?
        `).run(
          input.nativeSession.sessionId,
          JSON.stringify(input.nativeSession),
          input.adapterVersion,
          input.observedAt,
          existing.executionId,
        );
        this.database.prepare(`
          UPDATE conversations
          SET title = CASE WHEN title_source = 'manual' THEN title ELSE ? END,
            preview = ?, cwd = ?,
            native_history_revision = COALESCE(?, native_history_revision),
            native_history_updated_at = CASE
              WHEN ? IS NULL THEN native_history_updated_at
              ELSE ?
            END,
            history_state = CASE WHEN ? THEN 'indexed' ELSE history_state END,
            history_error = CASE WHEN ? THEN NULL ELSE history_error END,
            subtree_updated_at = CASE
              WHEN ? IS NULL THEN subtree_updated_at
              ELSE MAX(subtree_updated_at, ?)
            END
          WHERE conversation_id = ?
        `).run(
          input.title,
          input.preview,
          input.cwd,
          input.historyRevision ?? null,
          input.updatedAt ?? null,
          input.updatedAt ?? null,
          revisionChanged ? 1 : 0,
          revisionChanged ? 1 : 0,
          input.updatedAt ?? null,
          input.updatedAt ?? null,
          existing.conversationId,
        );
      });
      return existing.conversationId;
    }
    this.transaction(() => {
      this.createConversation({
        conversationId: input.conversationId,
        rootExecutionId: input.rootExecutionId,
        provider: input.nativeSession.provider,
        providerInstanceId: input.nativeSession.providerInstanceId,
        title: input.title,
        cwd: input.cwd,
        model: input.model,
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
        access: input.access,
        now: input.createdAt,
      });
      this.bindNativeSession({
        executionId: input.rootExecutionId,
        nativeSession: input.nativeSession,
        adapterVersion: input.adapterVersion,
        now: input.observedAt,
      });
      const providerUpdatedAt = input.updatedAt ?? input.createdAt;
      this.database.prepare(`
        UPDATE conversations
        SET preview = ?, history_state = 'indexed', history_error = NULL,
          native_history_revision = ?, native_history_updated_at = ?,
          history_synced_revision = NULL, history_synced_at = NULL,
          created_at = ?, updated_at = ?
        WHERE conversation_id = ?
      `).run(
        input.preview,
        input.historyRevision ?? null,
        input.updatedAt ?? null,
        input.createdAt,
        providerUpdatedAt,
        input.conversationId,
      );
      this.database.prepare(`
        UPDATE executions SET created_at = ?, updated_at = ? WHERE execution_id = ?
      `).run(input.createdAt, providerUpdatedAt, input.rootExecutionId);
    });
    return input.conversationId;
  }

  bindNativeSession(input: {
    executionId: string;
    nativeSession: NativeSessionRef;
    adapterVersion: string;
    now: number;
  }) {
    this.transaction(() => {
      this.database.prepare(`
      INSERT INTO native_sessions(
        execution_id, provider, provider_instance_id, native_session_id,
        private_ref_json, adapter_version, state, first_observed_at, last_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET
        native_session_id = excluded.native_session_id,
        private_ref_json = excluded.private_ref_json,
        adapter_version = excluded.adapter_version,
        state = 'ready',
        last_observed_at = excluded.last_observed_at
      `).run(
        input.executionId,
        input.nativeSession.provider,
        input.nativeSession.providerInstanceId,
        input.nativeSession.sessionId,
        JSON.stringify(input.nativeSession),
        input.adapterVersion,
        input.now,
        input.now,
      );
      // Binding settles a newly materialized session that has never admitted
      // a turn, but it says nothing about an accepted turn's lifecycle. Keep
      // an active recovery intact so session health/snapshot authority can
      // move it to running without a later idle write racing that decision.
      this.database.prepare(`
      UPDATE executions SET state = CASE
        WHEN state = 'recovering' AND NOT EXISTS (
          SELECT 1 FROM turns
          WHERE turns.execution_id = executions.execution_id
            AND turns.state IN ('running', 'recovering')
        ) THEN 'idle'
        ELSE state
      END, updated_at = ? WHERE execution_id = ?
      `).run(input.now, input.executionId);
      this.database.prepare(`
      UPDATE conversations SET state = CASE
        WHEN state = 'recovering' AND active_turn_id IS NULL THEN 'idle'
        ELSE state
      END, resumable = 1, updated_at = ?
      WHERE root_execution_id = ?
      `).run(input.now, input.executionId);
    });
  }

  /**
   * True only after the native harness has confirmed that its durable session
   * exists. Older Claude rows predate the semantic marker, so system/init is
   * retained as a narrow compatibility signal while those rows age out.
   */
  nativeSessionMaterialized(executionId: string) {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM (
        SELECT event_type, native_kind FROM events WHERE execution_id = ?
        UNION ALL
        SELECT event_type, native_kind FROM legacy_events WHERE execution_id = ?
      )
      WHERE event_type = 'session.materialized' OR native_kind = 'system/init'
      LIMIT 1
    `).get(executionId, executionId));
  }

  createFederatedExecution(input: {
    executionId: string;
    conversationId: string;
    parentExecutionId: string;
    rootTurnId: string;
    provider: ProviderKind;
    providerInstanceId: string;
    model: string;
    effort?: string;
    serviceTier?: string;
    checkoutKey?: string;
    access: 'read-only' | 'workspace-write';
    scheduling: 'background' | 'foreground';
    depth: number;
    title: string;
    now: number;
  }) {
    const activeStrandId = this.conversationHead(input.conversationId)?.strandId ?? null;
    this.database.prepare(`
      INSERT INTO executions(
        execution_id, conversation_id, strand_id, parent_execution_id, root_turn_id,
        ownership, provider, provider_instance_id, model, effort, service_tier, checkout_key, access,
        federation_scheduling, federation_depth, title, state,
        transcript_available, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'federated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recovering', 1, ?, ?)
    `).run(
      input.executionId,
      input.conversationId,
      activeStrandId,
      input.parentExecutionId,
      input.rootTurnId,
      input.provider,
      input.providerInstanceId,
      input.model,
      input.effort ?? null,
      input.serviceTier ?? null,
      input.checkoutKey ?? null,
      input.access,
      input.scheduling,
      input.depth,
      input.title,
      input.now,
      input.now,
    );
  }

  reserveFederatedCheckout(input: {
    executionId: string;
    checkoutKey: string;
    commandId: string;
    expectedTurnId: string;
    access: 'read-only' | 'workspace-write' | 'full-access';
    scheduling: 'background' | 'foreground';
    now: number;
  }) {
    const active = this.database.prepare(`
      SELECT checkout_key, access, scheduling FROM federation_checkout_reservations
      WHERE state IN ('held', 'unknown')
    `).all() as Array<{ checkout_key: string | null; access: string; scheduling: string }>;
    const writer = input.access === 'workspace-write' || input.access === 'full-access';
    if (active.some((row) => row.checkout_key === null) &&
        (writer || input.scheduling === 'background')) {
      if (!writer) throw new Error('Background federated reader limit exceeded for this checkout.');
      throw new Error('A federated workspace writer is already active for this checkout.');
    }
    if (writer && active.some((row) => row.checkout_key === input.checkoutKey &&
          (row.access === 'workspace-write' || row.access === 'full-access'))) {
      throw new Error('A federated workspace writer is already active for this checkout.');
    }
    if (!writer && input.scheduling === 'background' && active.filter((row) =>
      row.checkout_key === input.checkoutKey && row.access === 'read-only' &&
      row.scheduling === 'background').length >= 4) {
      throw new Error('Background federated reader limit exceeded for this checkout.');
    }
    this.database.prepare(`
      INSERT INTO federation_checkout_reservations(
        execution_id, checkout_key, command_id, expected_turn_id, access, scheduling,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET
        checkout_key=excluded.checkout_key, command_id=excluded.command_id,
        expected_turn_id=excluded.expected_turn_id, access=excluded.access,
        scheduling=excluded.scheduling, state='held', terminal_evidence_json=NULL,
        release_reason=NULL, released_at=NULL,
        updated_at=MAX(federation_checkout_reservations.updated_at, excluded.updated_at)
      WHERE federation_checkout_reservations.state='released'
    `).run(input.executionId, input.checkoutKey, input.commandId, input.expectedTurnId,
      input.access, input.scheduling, input.now, input.now);
    const row = this.database.prepare(`SELECT command_id FROM federation_checkout_reservations
      WHERE execution_id=?`).get(input.executionId) as { command_id: string | null } | undefined;
    if (row?.command_id !== input.commandId) throw new Error('Federated execution already owns checkout capacity.');
  }

  releaseFederatedCheckout(input: { executionId: string; commandId: string; expectedTurnId: string;
    reason: 'pre-dispatch-failure' | 'native-terminal'; now: number; evidence?: unknown }) {
    return this.database.prepare(`UPDATE federation_checkout_reservations SET state='released',
      terminal_evidence_json=?, release_reason=?,
      released_at=MAX(created_at, updated_at, ?), updated_at=MAX(updated_at, ?)
      WHERE execution_id=? AND command_id=? AND expected_turn_id=? AND state IN ('held','unknown')
    `).run(input.evidence === undefined ? null : JSON.stringify(input.evidence), input.reason,
      input.now, input.now, input.executionId, input.commandId, input.expectedTurnId).changes === 1;
  }

  recordFederatedTerminalEvidence(input: { executionId: string; commandId: string;
    expectedTurnId: string; evidence: unknown; now: number }) {
    return this.database.prepare(`UPDATE federation_checkout_reservations
      SET terminal_evidence_json=?, updated_at=MAX(updated_at, ?)
      WHERE execution_id=? AND command_id=? AND expected_turn_id=? AND state IN ('held','unknown')
    `).run(JSON.stringify(input.evidence), input.now, input.executionId, input.commandId,
      input.expectedTurnId).changes === 1;
  }

  markFederatedCheckoutUnknown(executionId: string, commandId: string, expectedTurnId: string, now: number) {
    return this.database.prepare(`UPDATE federation_checkout_reservations SET state='unknown', updated_at=MAX(updated_at, ?)
      WHERE execution_id=? AND command_id=? AND expected_turn_id=? AND state='held'
    `).run(now, executionId, commandId, expectedTurnId).changes === 1;
  }

  markNativeSessionClosed(executionId: string, now: number) {
    this.database.prepare(`
      UPDATE native_sessions SET state = 'closed', last_observed_at = ? WHERE execution_id = ?
    `).run(now, executionId);
  }

  closeFederatedExecution(executionId: string, now: number) {
    this.transaction(() => {
      this.database.prepare(`
        UPDATE turns SET state = 'failed', outcome = 'recovery_failed', error_json = ?,
          completed_at = ?, updated_at = ?
        WHERE execution_id = ? AND state IN ('running', 'recovering')
      `).run(JSON.stringify({
        code: 'recovery_failed',
        message: 'Native session closed before an authoritative terminal event was observed.',
      }), now, now, executionId);
      this.database.prepare(`
        UPDATE executions
        SET state = CASE WHEN state IN ('running', 'recovering') THEN 'failed' ELSE state END,
            outcome = CASE WHEN state IN ('running', 'recovering') THEN 'recovery_failed' ELSE outcome END,
            summary = CASE WHEN state IN ('running', 'recovering')
              THEN 'Native session closed before an authoritative terminal event was observed.'
              ELSE summary END,
            completed_at = CASE WHEN state IN ('running', 'recovering') THEN ? ELSE completed_at END,
            updated_at = ?
        WHERE execution_id = ? AND ownership = 'federated'
      `).run(now, now, executionId);
      this.markNativeSessionClosed(executionId, now);
    });
  }

  nativeSession(executionId: string): NativeSessionRef | undefined {
    const row = this.database.prepare(`
      SELECT private_ref_json FROM native_sessions WHERE execution_id = ?
    `).get(executionId) as { private_ref_json: string } | undefined;
    return row ? JSON.parse(row.private_ref_json) as NativeSessionRef : undefined;
  }

  nativeChildHandle(executionId: string): { nativeSessionId: string } | undefined {
    const row = this.database.prepare(`
      SELECT native_session_id FROM native_child_handles WHERE execution_id = ?
    `).get(executionId) as { native_session_id: string } | undefined;
    return row ? { nativeSessionId: row.native_session_id } : undefined;
  }

  nativeSessionState(executionId: string) {
    const row = this.database.prepare(`
      SELECT state FROM native_sessions WHERE execution_id = ?
    `).get(executionId) as { state: 'ready' | 'recovering' | 'lost' | 'closed' } | undefined;
    return row?.state;
  }

  executionForNativeSession(providerInstanceId: string, nativeSessionId: string) {
    const row = this.database.prepare(`
      SELECT e.* FROM native_sessions n
      JOIN executions e USING(execution_id)
      WHERE n.provider_instance_id = ? AND n.native_session_id = ?
    `).get(providerInstanceId, nativeSessionId) as Record<string, unknown> | undefined;
    return row ? executionRow(row) : undefined;
  }

  createTurn(input: {
    turnId: string;
    conversationId: string;
    executionId: string;
    clientMessageId: string;
    commandId: string;
    content: readonly UserContentPart[];
    model: string;
    effort?: string;
    serviceTier?: string;
    state: 'queued' | 'running';
    now: number;
  }) {
    this.transaction(() => {
      const execution = this.execution(input.executionId);
      if (!execution || execution.conversationId !== input.conversationId) {
        throw new Error('Turn execution does not belong to the conversation.');
      }
      const strandId = execution.strandId ?? this.conversationHead(input.conversationId)?.strandId;
      if (!strandId) throw new Error('Turn execution has no conversation strand.');
      this.database.prepare(`
      INSERT INTO turns(
        turn_id, conversation_id, origin_strand_id, execution_id, client_message_id, command_id,
        user_content_json, model, effort, service_tier, ordering, state, created_at, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'native-exact', ?, ?, ?, ?)
      `).run(
        input.turnId,
        input.conversationId,
        strandId,
        input.executionId,
        input.clientMessageId,
        input.commandId,
        JSON.stringify(input.content),
        input.model,
        input.effort ?? null,
        input.serviceTier ?? null,
        input.state,
        input.now,
        input.state === 'running' ? input.now : null,
        input.now,
      );
      if (execution.ownership === 'root') {
        const ordinalRow = this.database.prepare(`
          SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
          FROM strand_turn_path WHERE strand_id = ?
        `).get(strandId) as { ordinal: number };
        this.database.prepare(`
          INSERT INTO strand_turn_path(
            path_entry_id, strand_id, ordinal, turn_id, source_path_entry_id,
            relation, branch_binding_id
          ) VALUES (?, ?, ?, ?, NULL, 'local', NULL)
        `).run(`path:${strandId}:${input.turnId}`, strandId, ordinalRow.ordinal, input.turnId);
      }
      this.database.prepare(`
      UPDATE conversations
      SET latest_turn_id = ?, active_turn_id = CASE WHEN ? = 'running' THEN ? ELSE active_turn_id END,
          state = CASE WHEN ? = 'running' THEN 'running' ELSE state END,
          preview = CASE WHEN preview = '' THEN ? ELSE preview END,
          updated_at = MAX(updated_at, ?)
      WHERE conversation_id = ?
        AND root_execution_id = ?
      `).run(
        input.turnId,
        input.state,
        input.turnId,
        input.state,
        previewText(input.content),
        input.now,
        input.conversationId,
        input.executionId,
      );
      if (input.state === 'running') {
        this.database.prepare(`
        UPDATE executions
        SET state = 'running', outcome = NULL, completed_at = NULL, updated_at = MAX(updated_at, ?)
        WHERE execution_id = ?
        `).run(input.now, input.executionId);
      }
      const head = this.conversationHead(input.conversationId);
      const conversation = this.conversation(input.conversationId);
      if (conversation && head?.strandId === strandId) {
        this.touchConversationFamily(conversation.rootConversationId, input.now);
      }
    });
  }

  enqueueTurn(input: {
    commandId: string;
    conversationId: string;
    turnId: string;
    clientMessageId: string;
    content: readonly UserContentPart[];
    model: string;
    effort?: string;
    serviceTier?: string;
    access: 'read-only' | 'workspace-write' | 'full-access';
    now: number;
  }) {
    const ordinal = this.nextQueueOrdinal(input.conversationId);
    this.database.prepare(`
      INSERT INTO queued_messages(
        command_id, conversation_id, turn_id, client_message_id, content_json,
        model, effort, service_tier, access, state, ordinal, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      input.commandId,
      input.conversationId,
      input.turnId,
      input.clientMessageId,
      JSON.stringify(input.content),
      input.model,
      input.effort ?? null,
      input.serviceTier ?? null,
      input.access,
      ordinal,
      input.now,
    );
  }

  claimQueuedTurn(conversationId: string, _now: number): NativeQueuedMessage | undefined {
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM queued_messages WHERE conversation_id = ? ORDER BY ordinal LIMIT 1
      `).get(conversationId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const queued = queueRow(row);
      if (queued.state === 'dispatching' || queued.state === 'delivery-unknown') return undefined;
      this.database.prepare(`
        UPDATE queued_messages SET state = 'dispatching' WHERE command_id = ?
      `).run(queued.commandId);
      return { ...queued, state: 'dispatching' };
    });
  }

  admitQueuedTurn(turnId: string, now: number, nativeTurnId?: string) {
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM queued_messages WHERE turn_id = ? AND state = 'dispatching'
      `).get(turnId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const queued = queueRow(row);
      const conversation = this.conversation(String(row.conversation_id));
      if (!conversation) throw new Error('Queued message conversation does not exist.');
      this.createTurn({
        turnId: queued.turnId,
        conversationId: conversation.conversationId,
        executionId: conversation.rootExecutionId,
        clientMessageId: String(row.client_message_id),
        commandId: queued.commandId,
        content: queued.content,
        model: queued.model,
        ...(queued.effort ? { effort: queued.effort } : {}),
        ...(queued.serviceTier ? { serviceTier: queued.serviceTier } : {}),
        state: 'running',
        now,
      });
      if (nativeTurnId) {
        this.upsertNativeTurnBinding({
          providerInstanceId: conversation.providerInstanceId,
          executionId: conversation.rootExecutionId,
          turnId: queued.turnId,
          nativeTurnId,
          branchCursor: { version: 1, nativeTurnId },
          cursorVersion: 1,
          now,
        });
      }
      this.database.prepare(`
        UPDATE conversations SET model = ?, effort = ?, service_tier = ?, access = ?, health_message = NULL,
          updated_at = ? WHERE conversation_id = ?
      `).run(
        queued.model,
        queued.effort ?? null,
        queued.serviceTier ?? null,
        queued.access,
        now,
        conversation.conversationId,
      );
      this.database.prepare(`
        UPDATE executions SET model = ?, effort = ?, service_tier = ?, access = ?, updated_at = ?
        WHERE execution_id = ?
      `).run(
        queued.model,
        queued.effort ?? null,
        queued.serviceTier ?? null,
        queued.access,
        now,
        conversation.rootExecutionId,
      );
      this.database.prepare('DELETE FROM queued_messages WHERE turn_id = ?').run(turnId);
      return queued;
    });
  }

  acknowledgeQueuedTurnDispatch(turnId: string) {
    return this.database.prepare(`
      DELETE FROM queued_messages WHERE turn_id = ? AND state = 'dispatching'
    `).run(turnId).changes > 0;
  }

  markQueuedTurnDeliveryUnknown(turnId: string) {
    return this.database.prepare(`
      UPDATE queued_messages SET state = 'delivery_unknown'
      WHERE turn_id = ? AND state = 'dispatching'
    `).run(turnId).changes > 0;
  }

  markInterruptedQueueDispatchesDeliveryUnknown() {
    return this.database.prepare(`
      UPDATE queued_messages SET state = 'delivery_unknown'
      WHERE state = 'dispatching'
    `).run().changes;
  }

  blockQueuedMessages(conversationId: string) {
    return this.database.prepare(`
      UPDATE queued_messages SET state = 'blocked'
      WHERE conversation_id = ? AND state = 'queued'
    `).run(conversationId).changes;
  }

  releaseBlockedMessages(conversationId: string) {
    return this.database.prepare(`
      UPDATE queued_messages SET state = 'queued'
      WHERE conversation_id = ? AND state = 'blocked'
    `).run(conversationId).changes;
  }

  conversationsWithQueuedWork(): string[] {
    return (this.database.prepare(`
      SELECT conversation_id FROM queued_messages
      UNION
      SELECT conversation_id FROM queued_compactions
      ORDER BY conversation_id
    `).all() as Array<{ conversation_id: string }>).map(({ conversation_id }) => conversation_id);
  }

  updateConversationConfiguration(
    conversationId: string,
    model: string,
    effort: string | undefined,
    now: number,
    serviceTier?: string,
  ) {
    this.transaction(() => {
      this.database.prepare(`
        UPDATE conversations SET model = ?, effort = ?, service_tier = ?, updated_at = ? WHERE conversation_id = ?
      `).run(model, effort ?? null, serviceTier ?? null, now, conversationId);
      this.database.prepare(`
        UPDATE executions SET model = ?, effort = ?, service_tier = ?, updated_at = ?
        WHERE execution_id = (SELECT root_execution_id FROM conversations WHERE conversation_id = ?)
      `).run(model, effort ?? null, serviceTier ?? null, now, conversationId);
    });
  }

  updateConversationAccess(
    conversationId: string,
    access: 'read-only' | 'workspace-write' | 'full-access',
    now: number,
  ) {
    this.transaction(() => {
      this.database.prepare(`
        UPDATE conversations SET access = ?, updated_at = ? WHERE conversation_id = ?
      `).run(access, now, conversationId);
      this.database.prepare(`
        UPDATE executions SET access = ?, updated_at = ?
        WHERE execution_id = (SELECT root_execution_id FROM conversations WHERE conversation_id = ?)
      `).run(access, now, conversationId);
    });
  }

  removeQueuedTurn(conversationId: string, commandId: string, _now: number) {
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT turn_id FROM queued_messages
        WHERE conversation_id = ? AND command_id = ? AND state != 'dispatching'
      `).get(conversationId, commandId) as { turn_id: string } | undefined;
      if (!row) return false;
      this.database.prepare('DELETE FROM queued_messages WHERE command_id = ?').run(commandId);
      return true;
    });
  }

  removeQueuedTurnById(conversationId: string, turnId: string, now: number) {
    const row = this.database.prepare(`
      SELECT command_id FROM queued_messages WHERE conversation_id = ? AND turn_id = ?
    `).get(conversationId, turnId) as { command_id: string } | undefined;
    return row ? this.removeQueuedTurn(conversationId, row.command_id, now) : false;
  }

  queuedMessages(conversationId: string): NativeQueuedMessage[] {
    return (this.database.prepare(`
      SELECT * FROM queued_messages
      WHERE conversation_id = ?
      ORDER BY ordinal
    `).all(conversationId) as Record<string, unknown>[]).map(queueRow);
  }

  createManualCompaction(input: {
    operationId: string;
    commandId: string;
    conversationId: string;
    state: 'queued' | 'running';
    now: number;
  }) {
    const generation = this.compactionGeneration(input.conversationId);
    this.database.prepare(`
      INSERT INTO compaction_operations(
        operation_id, command_id, conversation_id, trigger, state, generation,
        before_tokens, after_tokens, created_at, started_at, updated_at
      ) VALUES (?, ?, ?, 'manual', ?, ?, NULL, NULL, ?, ?, ?)
    `).run(
      input.operationId,
      input.commandId,
      input.conversationId,
      input.state,
      generation,
      input.now,
      input.state === 'running' ? input.now : null,
      input.now,
    );
    if (input.state === 'queued') {
      this.database.prepare(`
        INSERT INTO queued_compactions(command_id, conversation_id, operation_id, ordinal, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        input.commandId,
        input.conversationId,
        input.operationId,
        this.nextQueueOrdinal(input.conversationId),
        input.now,
      );
    }
  }

  queuedCompactions(conversationId: string): NativeQueuedCompact[] {
    return (this.database.prepare(`
      SELECT * FROM queued_compactions WHERE conversation_id = ? ORDER BY ordinal
    `).all(conversationId) as Record<string, unknown>[]).map((row) => ({
      kind: 'compact',
      commandId: String(row.command_id),
      operationId: String(row.operation_id),
      createdAt: Number(row.created_at),
    }));
  }

  queuedEntries(conversationId: string): NativeQueueEntry[] {
    const entries = this.database.prepare(`
      SELECT 'message' AS queue_kind, ordinal, command_id, turn_id, client_message_id,
        content_json, model, effort, access, state, created_at, NULL AS operation_id
      FROM queued_messages WHERE conversation_id = ?
      UNION ALL
      SELECT 'compact' AS queue_kind, ordinal, command_id, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, created_at, operation_id
      FROM queued_compactions WHERE conversation_id = ?
      ORDER BY ordinal
    `).all(conversationId, conversationId) as Record<string, unknown>[];
    return entries.map((row) => row.queue_kind === 'compact'
      ? {
          kind: 'compact' as const,
          commandId: String(row.command_id),
          operationId: String(row.operation_id),
          createdAt: Number(row.created_at),
        }
      : queueRow(row));
  }

  claimNext(conversationId: string, now: number): NativeQueueEntry | undefined {
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT queue_kind, ordinal, command_id FROM (
          SELECT 'message' AS queue_kind, ordinal, command_id
          FROM queued_messages WHERE conversation_id = ?
          UNION ALL
          SELECT 'compact' AS queue_kind, ordinal, command_id
          FROM queued_compactions WHERE conversation_id = ?
        ) ORDER BY ordinal LIMIT 1
      `).get(conversationId, conversationId) as {
        queue_kind: 'message' | 'compact'; command_id: string;
      } | undefined;
      if (!row) return undefined;
      if (row.queue_kind === 'message') return this.claimQueuedTurn(conversationId, now);
      const next = this.queuedCompactions(conversationId)
        .find(({ commandId }) => commandId === row.command_id);
      if (!next) return undefined;
      this.database.prepare('DELETE FROM queued_compactions WHERE command_id = ?').run(next.commandId);
      this.database.prepare(`
        UPDATE compaction_operations SET state = 'running', started_at = COALESCE(started_at, ?),
          updated_at = ? WHERE operation_id = ? AND state = 'queued'
      `).run(now, now, next.operationId);
      return next;
    });
  }

  removeQueuedCompaction(conversationId: string, operationId: string, now: number) {
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT command_id FROM queued_compactions WHERE conversation_id = ? AND operation_id = ?
      `).get(conversationId, operationId) as { command_id: string } | undefined;
      if (!row) return false;
      this.database.prepare('DELETE FROM queued_compactions WHERE command_id = ?').run(row.command_id);
      this.database.prepare(`
        UPDATE compaction_operations SET state = 'cancelled', completed_at = ?, updated_at = ?
        WHERE operation_id = ? AND state = 'queued'
      `).run(now, now, operationId);
      return true;
    });
  }

  failCompaction(
    operationId: string,
    error: { code: string; message: string; retryable?: boolean },
    now: number,
  ) {
    this.database.prepare(`
      UPDATE compaction_operations SET state = 'failed', error_json = ?, completed_at = ?, updated_at = ?
      WHERE operation_id = ? AND state IN ('queued', 'running')
    `).run(JSON.stringify(error), now, now, operationId);
  }

  markRunningCompactionDeliveryUnknown(
    conversationId: string,
    error: { code: string; message: string; retryable?: boolean },
    now: number,
  ) {
    return this.database.prepare(`
      UPDATE compaction_operations
      SET state = 'delivery_unknown', error_json = ?, completed_at = ?, updated_at = ?
      WHERE conversation_id = ? AND state = 'running'
    `).run(JSON.stringify(error), now, now, conversationId).changes > 0;
  }

  setCompactionNativeOperationId(operationId: string, nativeOperationId: string, now: number) {
    this.database.prepare(`
      UPDATE compaction_operations SET native_operation_id = ?, updated_at = ?
      WHERE operation_id = ?
    `).run(nativeOperationId, now, operationId);
  }

  satisfyQueuedCompactionsAfterAutomatic(
    conversationId: string,
    beforeTokens: number | null,
    afterTokens: number | null,
    now: number,
  ) {
    return this.transaction(() => {
      const generation = this.compactionGeneration(conversationId);
      const rows = this.database.prepare(`
        SELECT operation_id, command_id FROM compaction_operations
        WHERE conversation_id = ? AND trigger = 'manual' AND state = 'queued'
          AND generation < ?
        ORDER BY created_at, operation_id
      `).all(conversationId, generation) as Array<{ operation_id: string; command_id: string }>;
      for (const row of rows) {
        this.database.prepare('DELETE FROM queued_compactions WHERE command_id = ?').run(row.command_id);
        this.database.prepare(`
          UPDATE compaction_operations
          SET state = 'completed', disposition = 'satisfied-by-native-auto',
            before_tokens = ?, after_tokens = ?, completed_at = ?, updated_at = ?
          WHERE operation_id = ? AND state = 'queued'
        `).run(beforeTokens, afterTokens, now, now, row.operation_id);
      }
      return rows.map(({ operation_id }) => operation_id);
    });
  }

  private nextQueueOrdinal(conversationId: string) {
    return Number((this.database.prepare(`
      SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM (
        SELECT ordinal FROM queued_messages WHERE conversation_id = ?
        UNION ALL
        SELECT ordinal FROM queued_compactions WHERE conversation_id = ?
      )
    `).get(conversationId, conversationId) as { ordinal: number }).ordinal);
  }

  appendProviderEvent(unparsed: ProviderEventEnvelope) {
    return this.appendProviderEvents([unparsed]).length === 1;
  }

  appendProviderEvents(unparsed: readonly ProviderEventEnvelope[]) {
    const envelopes = unparsed.map((event) => parseProviderEventEnvelope(event));
    return this.transaction(() => {
      const inserted: ProviderEventEnvelope[] = [];
      for (const envelope of envelopes) {
        if (this.appendProviderEventInTransaction(envelope)) inserted.push(envelope);
      }
      return inserted;
    });
  }

  replaceSnapshot(
    events: readonly ProviderEventEnvelope[],
    coverage?: ProviderSnapshotCoverage,
  ) {
    const parsedEvents = events.map((event) => parseProviderEventEnvelope(event));
    const imported = new Map<string, {
      conversationId: string;
      executionId: string;
      content: readonly UserContentPart[];
      observedAt: number;
    }>();
    for (const event of parsedEvents) {
      if (event.scope.kind !== 'turn') continue;
      const current = imported.get(event.scope.turnId);
      imported.set(event.scope.turnId, {
        conversationId: event.scope.conversationId,
        executionId: event.scope.executionId,
        content: event.event.type === 'user.message'
          ? event.event.content
          : current?.content ?? [],
        observedAt: Math.min(current?.observedAt ?? event.observedAt, event.observedAt),
      });
    }
    const authoritativeBlockTurns = new Set(parsedEvents.flatMap((event) =>
      event.scope.kind === 'turn' &&
      event.native.position?.kind === 'snapshot-index' &&
      isTurnBlockLifecycleEvent(event.event)
        ? [event.scope.turnId]
        : []));
    const snapshotBlocksByTurn = new Map<string, TurnScopedBlockEnvelope[]>();
    for (const event of parsedEvents) {
      if (!isTurnScopedBlockEnvelope(event) ||
          event.native.position?.kind !== 'snapshot-index') continue;
      const blockEvents = snapshotBlocksByTurn.get(event.scope.turnId) ?? [];
      blockEvents.push(event);
      snapshotBlocksByTurn.set(event.scope.turnId, blockEvents);
    }
    return this.transaction(() => {
      for (const [turnId, turn] of imported) {
        if (this.turn(turnId)) continue;
        const execution = this.execution(turn.executionId);
        const conversation = this.conversation(turn.conversationId);
        this.createTurn({
          turnId,
          conversationId: turn.conversationId,
          executionId: turn.executionId,
          clientMessageId: `native-import-message:${turnId}`,
          commandId: `native-import-command:${turnId}`,
          content: turn.content,
          model: execution?.model ?? conversation?.model ?? 'unknown',
          ...((execution?.effort ?? conversation?.effort)
            ? { effort: execution?.effort ?? conversation!.effort }
            : {}),
          state: 'running',
          now: turn.observedAt,
        });
      }
      // Rebuild the visible ordering for each included turn. A native snapshot
      // is authoritative for text and terminal state, but Codex snapshots made
      // after compaction can omit completed command/tool details that Remux
      // already received live. The rebuild below selectively merges those
      // durable live actions rather than either colliding with reused snapshot
      // ordinals or erasing useful work history.
      const deletePasses = this.database.prepare(`
        DELETE FROM turn_passes WHERE turn_id = ?
      `);
      for (const turnId of authoritativeBlockTurns) deletePasses.run(turnId);

      let insertedCount = 0;
      for (const envelope of parsedEvents) {
        const authoritativeTurnBlock = envelope.scope.kind === 'turn' &&
          authoritativeBlockTurns.has(envelope.scope.turnId) &&
          isTurnBlockLifecycleEvent(envelope.event);
        if (!authoritativeTurnBlock) {
          if (this.appendProviderEventInTransaction(envelope)) insertedCount += 1;
          continue;
        }
        if (this.insertProviderEventRow(envelope)) insertedCount += 1;
      }
      for (const turnId of authoritativeBlockTurns) {
        const snapshotBlocks = snapshotBlocksByTurn.get(turnId) ?? [];
        for (const envelope of this.mergedSnapshotBlockEvents(turnId, snapshotBlocks, coverage)) {
          this.reduceEvent(envelope);
        }
        const turn = this.turn(turnId);
        if (turn && (turn.state === 'completed' || turn.state === 'failed' ||
            turn.state === 'interrupted')) {
          this.database.prepare(`
            UPDATE turn_passes SET state = 'completed', updated_at = MAX(updated_at, ?)
            WHERE turn_id = ?
          `).run(turn.updatedAt, turnId);
        }
      }
      return insertedCount;
    });
  }

  private mergedSnapshotBlockEvents(
    turnId: string,
    snapshotEvents: readonly TurnScopedBlockEnvelope[],
    coverage?: ProviderSnapshotCoverage,
  ): TurnScopedBlockEnvelope[] {
    const i3Repair = this.database.prepare(`SELECT value_json FROM meta WHERE key = ?`)
      .get('repair_i3_native_child_identity_v1') as { value_json: string } | undefined;
    const directives = i3Repair
      ? (JSON.parse(i3Repair.value_json) as { directives?: {
          suppressedBlockIds?: string[]; canonicalEnvelope?: TurnScopedBlockEnvelope;
          terminalSequence?: number;
        } }).directives
      : undefined;
    const suppressedBlockIds = new Set<string>(directives?.suppressedBlockIds ?? []);
    const phantomRepair = this.database.prepare(`SELECT value_json FROM meta WHERE key = ?`)
      .get('repair_i3_phantom_grandchildren_v2') as { value_json: string } | undefined;
    if (phantomRepair) {
      const audit = JSON.parse(phantomRepair.value_json) as { suppressedBlockIds?: unknown };
      if (Array.isArray(audit.suppressedBlockIds)) {
        for (const blockId of audit.suppressedBlockIds.slice(0, 10_000)) {
          if (typeof blockId === 'string') suppressedBlockIds.add(blockId);
        }
      }
    }
    const snapshotGroups = groupBlockLifecycles(snapshotEvents
      .filter(({ event }) => !suppressedBlockIds.has(event.structure.blockId))
      .map((envelope, index) => ({
      sequence: index,
      envelope,
    })));
    const snapshotBlocks = [...snapshotGroups.values()]
      .sort((left, right) => snapshotBlockOrder(left, right));
    const compactionMarkers = snapshotBlocks.filter(({ latest }) =>
      isCompactionMarker(latest.event));
    const completeKinds = coverage
      ? new Set(coverage.turnBlocks.completeKinds)
      : undefined;
    if (compactionMarkers.length === 0 && completeKinds === undefined) {
      return mergeSnapshotAndRetainedBlocksByOrdinal(snapshotBlocks, []);
    }

    const snapshotPassIds = new Set(snapshotBlocks.map(({ latest }) =>
      latest.event.structure.passId));
    const storedRows = this.database.prepare(`
      SELECT sequence, envelope_json FROM events WHERE turn_id = ? ORDER BY sequence
    `).all(turnId) as Array<{ sequence: number; envelope_json: string }>;
    const repairOverride = directives?.canonicalEnvelope;
    const liveRows = storedRows.flatMap((row) => {
      const envelope = parseProviderEventEnvelope(JSON.parse(row.envelope_json));
      return isTurnScopedBlockEnvelope(envelope) &&
        !suppressedBlockIds.has(envelope.event.structure.blockId) &&
        envelope.native.position?.kind !== 'snapshot-index'
        ? [{ sequence: Number(row.sequence), envelope }]
        : [];
    });
    if (repairOverride?.scope.turnId === turnId) {
      liveRows.push({ sequence: directives?.terminalSequence ?? 0, envelope: repairOverride });
    }
    const liveGroups = groupBlockLifecycles(liveRows);

    const snapshotBlockIds = new Set(snapshotBlocks.map(({ latest }) =>
      latest.event.structure.blockId));
    const snapshotItemIds = new Set(snapshotBlocks.flatMap(({ latest }) =>
      latest.native.itemId ? [latest.native.itemId] : []));
    const shouldRetainJournalBlock = (event: TurnBlockLifecycleEvent) =>
      (completeKinds !== undefined && !completeKinds.has(event.block.kind)) ||
      (compactionMarkers.length > 0 && event.type === 'turn.block.completed' &&
        isRetainableAction(event));
    const snapshotFingerprints = new Map<string, number>();
    for (const { latest } of snapshotBlocks) {
      if (!shouldRetainJournalBlock(latest.event)) continue;
      const key = blockFingerprint(latest.event);
      snapshotFingerprints.set(key, (snapshotFingerprints.get(key) ?? 0) + 1);
    }

    const liveBlocks = [...liveGroups.values()]
      .sort((left, right) => left.firstSequence - right.firstSequence)
      .filter(({ latest }) => snapshotPassIds.has(latest.event.structure.passId) &&
        shouldRetainJournalBlock(latest.event));
    const directlyRepresented = new Set<string>();
    for (const { latest } of liveBlocks) {
      if (!snapshotBlockIds.has(latest.event.structure.blockId) &&
          !(latest.native.itemId && snapshotItemIds.has(latest.native.itemId))) continue;
      directlyRepresented.add(latest.event.structure.blockId);
      const fingerprint = blockFingerprint(latest.event);
      const matchingSnapshots = snapshotFingerprints.get(fingerprint) ?? 0;
      if (matchingSnapshots > 0) {
        snapshotFingerprints.set(fingerprint, matchingSnapshots - 1);
      }
    }
    const retained = liveBlocks.filter(({ latest }) => {
      if (directlyRepresented.has(latest.event.structure.blockId)) return false;
      const fingerprint = blockFingerprint(latest.event);
      const matchingSnapshots = snapshotFingerprints.get(fingerprint) ?? 0;
      if (matchingSnapshots === 0) return true;
      snapshotFingerprints.set(fingerprint, matchingSnapshots - 1);
      return false;
    });
    if (retained.length === 0) {
      return mergeSnapshotAndRetainedBlocksByOrdinal(snapshotBlocks, []);
    }

    if (compactionMarkers.length === 0) {
      return mergeSnapshotAndRetainedBlocksByOrdinal(snapshotBlocks, retained);
    }

    const boundaryRows = this.database.prepare(`
      SELECT operation_id, MIN(created_at) AS created_at
      FROM conversation_control_events
      WHERE kind = 'compaction'
        AND json_extract(boundary_json, '$.kind') = 'within-turn'
        AND json_extract(boundary_json, '$.turnId') = ?
      GROUP BY operation_id
      ORDER BY created_at, operation_id
    `).all(turnId) as Array<{ operation_id: string; created_at: number }>;
    const boundaryTimes = compactionMarkers.map((marker, index) =>
      Number(boundaryRows[index]?.created_at ?? marker.latest.observedAt));
    const retainedByPassAndEpoch = new Map<string, Map<number, BlockLifecycleGroup[]>>();
    for (const group of retained) {
      const passId = group.latest.event.structure.passId;
      const epoch = Math.min(
        boundaryTimes.filter((boundary) => group.latest.observedAt > boundary).length,
        compactionMarkers.length,
      );
      const byEpoch = retainedByPassAndEpoch.get(passId) ?? new Map<number, BlockLifecycleGroup[]>();
      const groups = byEpoch.get(epoch) ?? [];
      groups.push(group);
      byEpoch.set(epoch, groups);
      retainedByPassAndEpoch.set(passId, byEpoch);
    }

    const output: TurnScopedBlockEnvelope[] = [];
    const blocksByPass = new Map<string, BlockLifecycleGroup[]>();
    for (const block of snapshotBlocks) {
      const passId = block.latest.event.structure.passId;
      const blocks = blocksByPass.get(passId) ?? [];
      blocks.push(block);
      blocksByPass.set(passId, blocks);
    }
    for (const [passId, passBlocks] of blocksByPass) {
      const passOrdinal = passBlocks[0]!.latest.event.structure.passOrdinal;
      const byEpoch = retainedByPassAndEpoch.get(passId) ?? new Map<number, BlockLifecycleGroup[]>();
      const ordered: BlockLifecycleGroup[] = [];
      let epoch = 0;
      const insertEpoch = () => {
        ordered.push(...(byEpoch.get(epoch) ?? []));
        byEpoch.delete(epoch);
      };
      for (const block of passBlocks) {
        if (isCompactionMarker(block.latest.event)) {
          insertEpoch();
          ordered.push(block);
          epoch += 1;
          continue;
        }
        if (block.latest.event.block.kind === 'final-message') insertEpoch();
        ordered.push(block);
      }
      insertEpoch();
      for (const [, remaining] of [...byEpoch].sort(([left], [right]) => left - right)) {
        ordered.push(...remaining);
      }
      ordered.forEach((block, blockOrdinal) => {
        for (const { envelope } of block.lifecycles) {
          output.push(withBlockStructure(envelope, passId, passOrdinal, blockOrdinal));
        }
      });
    }
    return output;
  }

  private appendProviderEventInTransaction(candidate: ProviderEventEnvelope) {
    const envelope = this.canonicalizeTurnBlockPlacement(
      this.canonicalizeCompactionEnvelope(candidate),
    );
    this.ensureNativeChildTurn(envelope);
    if (this.hasCanonicalCompactionState(envelope)) {
      this.reconcileCompactionPath(envelope);
      return false;
    }
    if (!this.insertProviderEventRow(envelope)) {
      this.reconcileCompactionPath(envelope);
      return false;
    }
    this.reduceEvent(envelope);
    this.reconcileCompactionPath(envelope);
    return true;
  }

  private canonicalizeTurnBlockPlacement(envelope: ProviderEventEnvelope) {
    if (!isTurnScopedBlockEnvelope(envelope)) return envelope;
    // Provider-native and Remux-federated streams both propose ordinals within
    // one root turn. Preserve a known identity, but append a new identity whose
    // proposed pass or block slot is already occupied. Canonicalize before the
    // event row is written so replay, terminal-output sealing, and the
    // materialized projection all observe the same durable order.
    const { structure } = envelope.event;
    const existingBlock = this.database.prepare(`
      SELECT b.pass_id, b.ordinal AS block_ordinal, p.ordinal AS pass_ordinal
      FROM turn_blocks b JOIN turn_passes p USING(pass_id)
      WHERE b.block_id = ?
    `).get(structure.blockId) as {
      pass_id: string;
      block_ordinal: number;
      pass_ordinal: number;
    } | undefined;
    const canonicalPassId = existingBlock?.pass_id ?? structure.passId;
    const existingPass = this.database.prepare(`
      SELECT turn_id, ordinal FROM turn_passes WHERE pass_id = ?
    `).get(canonicalPassId) as { turn_id: string; ordinal: number } | undefined;

    let canonicalPassOrdinal = existingBlock?.pass_ordinal ??
      existingPass?.ordinal ?? structure.passOrdinal;
    if (!existingPass) {
      const ordinalOccupied = this.database.prepare(`
        SELECT 1 FROM turn_passes WHERE turn_id = ? AND ordinal = ?
      `).get(envelope.scope.turnId, canonicalPassOrdinal);
      if (ordinalOccupied) {
        canonicalPassOrdinal = (this.database.prepare(`
          SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
          FROM turn_passes WHERE turn_id = ?
        `).get(envelope.scope.turnId) as { next_ordinal: number }).next_ordinal;
      }
    }

    let canonicalBlockOrdinal = existingBlock?.block_ordinal ?? structure.blockOrdinal;
    if (!existingBlock) {
      const ordinalOccupied = this.database.prepare(`
        SELECT 1 FROM turn_blocks WHERE pass_id = ? AND ordinal = ?
      `).get(canonicalPassId, canonicalBlockOrdinal);
      if (ordinalOccupied) {
        canonicalBlockOrdinal = (this.database.prepare(`
          SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
          FROM turn_blocks WHERE pass_id = ?
        `).get(canonicalPassId) as { next_ordinal: number }).next_ordinal;
      }
    }

    if (canonicalPassId === structure.passId &&
        canonicalPassOrdinal === structure.passOrdinal &&
        canonicalBlockOrdinal === structure.blockOrdinal) return envelope;
    return withBlockStructure(
      envelope,
      canonicalPassId,
      canonicalPassOrdinal,
      canonicalBlockOrdinal,
    );
  }

  private canonicalizeCompactionEnvelope(envelope: ProviderEventEnvelope) {
    if (!isContextCompactionEvent(envelope.event) || envelope.scope.kind === 'account') return envelope;
    const subjectKey = envelope.native.subject?.kind === 'context-compaction'
      ? envelope.native.subject.key
      : undefined;
    if (!subjectKey) return envelope;
    const canonical = this.database.prepare(`
      SELECT operation_id, trigger FROM compaction_operations
      WHERE conversation_id = ? AND provider_subject_key = ?
    `).get(envelope.scope.conversationId, subjectKey) as {
      operation_id: string;
      trigger: 'manual' | 'automatic';
    } | undefined;
    if (canonical) {
      this.database.prepare(`
        UPDATE conversation_control_events
        SET provider_subject_key = COALESCE(provider_subject_key, ?)
        WHERE conversation_id = ? AND operation_id = ?
      `).run(subjectKey, envelope.scope.conversationId, canonical.operation_id);
      if (canonical.operation_id === envelope.event.operationId &&
          canonical.trigger === envelope.event.trigger) return envelope;
      return parseProviderEventEnvelope({
        ...envelope,
        event: {
          ...envelope.event,
          operationId: canonical.operation_id,
          trigger: canonical.trigger,
        },
      });
    }
    const matchingOperation = this.compactionOperation(envelope.event.operationId);
    if (matchingOperation?.conversationId === envelope.scope.conversationId) {
      this.database.prepare(`
        UPDATE compaction_operations SET provider_subject_key = ?
        WHERE operation_id = ? AND provider_subject_key IS NULL
      `).run(subjectKey, envelope.event.operationId);
      this.database.prepare(`
        UPDATE conversation_control_events SET provider_subject_key = ?
        WHERE conversation_id = ? AND operation_id = ? AND provider_subject_key IS NULL
      `).run(subjectKey, envelope.scope.conversationId, envelope.event.operationId);
    }
    return envelope;
  }

  private hasCanonicalCompactionState(envelope: ProviderEventEnvelope) {
    if (!isContextCompactionEvent(envelope.event) || envelope.scope.kind === 'account' ||
        envelope.native.subject?.kind !== 'context-compaction') return false;
    const state = envelope.event.type === 'context.compaction.started'
      ? 'started'
      : envelope.event.type === 'context.compaction.completed' ? 'completed' : 'failed';
    const row = this.database.prepare(`
      SELECT 1 AS present FROM conversation_control_events
      WHERE conversation_id = ? AND provider_subject_key = ? AND state = ?
    `).get(envelope.scope.conversationId, envelope.native.subject.key, state) as
      | { present: number }
      | undefined;
    return row?.present === 1;
  }

  private reconcileCompactionPath(envelope: ProviderEventEnvelope) {
    if (!isContextCompactionEvent(envelope.event) || envelope.scope.kind === 'account' ||
        envelope.native.subject?.kind !== 'context-compaction' ||
        !envelope.native.timeline) return;
    const execution = this.execution(envelope.scope.executionId);
    if (!execution?.strandId) return;
    const strandId = execution.strandId;
    const resolveTurn = (nativeTurnId: string | undefined) => {
      if (!nativeTurnId) return null;
      const row = this.database.prepare(`
        SELECT t.turn_id FROM strand_turn_path p
        JOIN turns t USING(turn_id)
        WHERE p.strand_id = ? AND t.native_turn_id = ?
        LIMIT 1
      `).get(strandId, nativeTurnId) as { turn_id: string } | undefined;
      return row?.turn_id ?? null;
    };
    const previousTurnId = resolveTurn(envelope.native.timeline.previousTurnId);
    const nextTurnId = resolveTurn(envelope.native.timeline.nextTurnId);
    if ((envelope.native.timeline.previousTurnId && !previousTurnId) ||
        (envelope.native.timeline.nextTurnId && !nextTurnId) ||
        (!previousTurnId && !nextTurnId)) return;
    const operation = this.database.prepare(`
      SELECT operation_id FROM compaction_operations
      WHERE conversation_id = ? AND provider_subject_key = ?
    `).get(envelope.scope.conversationId, envelope.native.subject.key) as
      | { operation_id: string }
      | undefined;
    if (!operation) return;
    const local = this.database.prepare(`
      SELECT 1 AS present FROM conversation_control_events c
      JOIN events e ON e.event_id = c.control_event_id
      WHERE c.conversation_id = ? AND c.operation_id = ? AND e.execution_id = ?
      LIMIT 1
    `).get(envelope.scope.conversationId, operation.operation_id, envelope.scope.executionId) as
      | { present: number }
      | undefined;
    const ordinal = Number(envelope.native.subject.key.match(/:(\d+)$/u)?.[1] ?? 0);
    this.database.prepare(`
      INSERT INTO strand_control_path(
        path_entry_id, strand_id, operation_id, previous_turn_id, next_turn_id,
        native_ordinal, relation
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(strand_id, operation_id) DO UPDATE SET
        previous_turn_id = excluded.previous_turn_id,
        next_turn_id = excluded.next_turn_id,
        native_ordinal = excluded.native_ordinal,
        relation = CASE
          WHEN strand_control_path.relation = 'local' THEN 'local'
          ELSE excluded.relation
        END
    `).run(
      `path:${strandId}:control:${operation.operation_id}`,
      strandId,
      operation.operation_id,
      previousTurnId,
      nextTurnId,
      ordinal,
      local ? 'local' : 'inherited',
    );
  }

  private insertProviderEventRow(envelope: ProviderEventEnvelope) {
    const scope = envelope.scope;
    const conversationId = scope.kind === 'account' ? null : scope.conversationId;
    const executionId = scope.kind === 'account' ? null : scope.executionId;
    const turnId = scope.kind === 'turn'
      ? scope.turnId
      : scope.kind === 'execution' ? scope.rootTurnId ?? null : null;
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO events(
        event_id, provider_instance_id, scope_kind, conversation_id, execution_id,
        turn_id, event_type, native_kind, envelope_json, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      envelope.eventId,
      scope.providerInstanceId,
      scope.kind,
      conversationId,
      executionId,
      turnId,
      envelope.event.type,
      envelope.native.kind,
      JSON.stringify(envelope),
      envelope.observedAt,
    );
    return inserted.changes !== 0;
  }

  eventsForConversation(conversationId: string): ProviderEventEnvelope[] {
    return (this.database.prepare(`
      SELECT envelope_json FROM events WHERE conversation_id = ? ORDER BY sequence
    `).all(conversationId) as Array<{ envelope_json: string }>).map(({ envelope_json }) =>
      parseProviderEventEnvelope(JSON.parse(envelope_json)));
  }

  legacyEventsForConversation(conversationId: string): LegacyJournalEvent[] {
    return (this.database.prepare(`
      SELECT * FROM legacy_events WHERE conversation_id = ? ORDER BY sequence
    `).all(conversationId) as Record<string, unknown>[]).map(legacyEventRow);
  }

  legacyEventsForTurn(turnId: string): LegacyJournalEvent[] {
    return (this.database.prepare(`
      SELECT * FROM legacy_events WHERE turn_id = ? ORDER BY sequence
    `).all(turnId) as Record<string, unknown>[]).map(legacyEventRow);
  }

  eventsForExecution(executionId: string): ProviderEventEnvelope[] {
    return (this.database.prepare(`
      SELECT envelope_json FROM events WHERE execution_id = ? ORDER BY sequence
    `).all(executionId) as Array<{ envelope_json: string }>).map(({ envelope_json }) =>
      parseProviderEventEnvelope(JSON.parse(envelope_json)));
  }

  eventsForTurn(
    turnId: string,
    options: { includeToolOutputPreviews?: boolean } = {},
  ): ProviderEventEnvelope[] {
    const envelopeProjection = options.includeToolOutputPreviews === false
      ? `json_remove(envelope_json, '$.event.block.payload.outputPreview')`
      : 'envelope_json';
    return (this.database.prepare(`
      SELECT ${envelopeProjection} AS envelope_json
      FROM events WHERE turn_id = ? ORDER BY sequence
    `).all(turnId) as Array<{ envelope_json: string }>).map(({ envelope_json }) =>
      parseProviderEventEnvelope(JSON.parse(envelope_json)));
  }

  compactionControlEvents(
    conversationId: string,
    strandId = this.conversationHead(conversationId)?.strandId,
  ): JournalCompactionControlEvent[] {
    const rows = this.database.prepare(`
      SELECT c.*, e.execution_id, p.strand_id, p.previous_turn_id, p.next_turn_id
      FROM conversation_control_events c
      JOIN events e ON e.event_id = c.control_event_id
      LEFT JOIN strand_control_path p ON p.operation_id = c.operation_id
        AND p.strand_id = ?
      WHERE c.conversation_id = ? AND c.kind = 'compaction'
      ORDER BY c.created_at, c.control_event_id
    `).all(strandId ?? null, conversationId) as Record<string, unknown>[];
    return rows.map((row) => {
      const payload = JSON.parse(String(row.payload_json)) as {
        trigger: 'manual' | 'automatic';
        beforeTokens?: number | null;
        afterTokens?: number | null;
        error?: { code: string; message: string; retryable?: boolean };
      };
      return {
        controlEventId: String(row.control_event_id),
        conversationId: String(row.conversation_id),
        executionId: String(row.execution_id),
        boundary: JSON.parse(String(row.boundary_json)) as JournalCompactionBoundary,
        state: row.state as JournalCompactionControlEvent['state'],
        operationId: String(row.operation_id),
        providerSubjectKey: row.provider_subject_key === null
          ? null
          : String(row.provider_subject_key),
        strandId: row.strand_id === null ? null : String(row.strand_id),
        previousTurnId: row.previous_turn_id === null ? null : String(row.previous_turn_id),
        nextTurnId: row.next_turn_id === null ? null : String(row.next_turn_id),
        nativeIdentity: row.native_identity === null ? null : String(row.native_identity),
        trigger: payload.trigger,
        beforeTokens: payload.beforeTokens ?? null,
        afterTokens: payload.afterTokens ?? null,
        ...(payload.error ? { error: payload.error } : {}),
        createdAt: Number(row.created_at),
        ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
      };
    });
  }

  legacyEventsForExecution(executionId: string): LegacyJournalEvent[] {
    return (this.database.prepare(`
      SELECT * FROM legacy_events WHERE execution_id = ? ORDER BY sequence
    `).all(executionId) as Record<string, unknown>[]).map(legacyEventRow);
  }

  conversation(conversationId: string): JournalConversation | undefined {
    const row = this.database.prepare(`
      SELECT c.*, p.provider, h.strand_id AS active_strand_id,
        h.revision AS head_revision,
        (SELECT t.model FROM strand_turn_path path
          JOIN turns t USING(turn_id)
          WHERE path.strand_id = h.strand_id
            AND t.started_at IS NOT NULL
            AND t.command_id NOT LIKE 'native-import-command:%'
          ORDER BY path.ordinal DESC LIMIT 1) AS last_used_model,
        MAX(c.created_at, COALESCE(c.native_history_updated_at, 0),
          COALESCE((SELECT MAX(t.created_at) FROM strand_turn_path path
          JOIN turns t USING(turn_id)
          WHERE path.strand_id = h.strand_id
            AND t.command_id NOT LIKE 'native-import-command:%'), 0)) AS last_activity_at,
        (SELECT COUNT(*) FROM conversation_strands s
          WHERE s.conversation_id = c.conversation_id AND s.state IN ('ready', 'orphaned')) AS version_count,
        (SELECT COUNT(*) FROM conversations child
          WHERE child.parent_conversation_id = c.conversation_id AND child.archived_at IS NULL
            AND EXISTS (
              SELECT 1 FROM conversation_heads child_h
              JOIN conversation_strands child_s ON child_s.strand_id = child_h.strand_id
              WHERE child_h.conversation_id = child.conversation_id AND child_s.state = 'ready'
            )) AS child_count
      FROM conversations c
      JOIN provider_instances p USING(provider_instance_id)
      JOIN conversation_heads h USING(conversation_id)
      WHERE conversation_id = ?
    `).get(conversationId) as Record<string, unknown> | undefined;
    return row ? conversationRow(row) : undefined;
  }

  conversations(): JournalConversation[] {
    return (this.database.prepare(`
      SELECT c.*, p.provider, h.strand_id AS active_strand_id,
        h.revision AS head_revision,
        (SELECT t.model FROM strand_turn_path path
          JOIN turns t USING(turn_id)
          WHERE path.strand_id = h.strand_id
            AND t.started_at IS NOT NULL
            AND t.command_id NOT LIKE 'native-import-command:%'
          ORDER BY path.ordinal DESC LIMIT 1) AS last_used_model,
        MAX(c.created_at, COALESCE(c.native_history_updated_at, 0),
          COALESCE((SELECT MAX(t.created_at) FROM strand_turn_path path
          JOIN turns t USING(turn_id)
          WHERE path.strand_id = h.strand_id
            AND t.command_id NOT LIKE 'native-import-command:%'), 0)) AS last_activity_at,
        (SELECT COUNT(*) FROM conversation_strands s
          WHERE s.conversation_id = c.conversation_id AND s.state IN ('ready', 'orphaned')) AS version_count,
        (SELECT COUNT(*) FROM conversations child
          WHERE child.parent_conversation_id = c.conversation_id AND child.archived_at IS NULL
            AND EXISTS (
              SELECT 1 FROM conversation_heads child_h
              JOIN conversation_strands child_s ON child_s.strand_id = child_h.strand_id
              WHERE child_h.conversation_id = child.conversation_id AND child_s.state = 'ready'
            )) AS child_count
      FROM conversations c
      JOIN provider_instances p USING(provider_instance_id)
      JOIN conversation_heads h USING(conversation_id)
      JOIN conversation_strands active_s ON active_s.strand_id = h.strand_id
      WHERE active_s.state = 'ready'
      ORDER BY last_activity_at DESC, c.conversation_id
    `).all() as Record<string, unknown>[]).map(conversationRow);
  }

  renameConversation(conversationId: string, expectedRevision: number, title: string, now: number) {
    const result = this.database.prepare(`
      UPDATE conversations
      SET title = ?, title_source = 'manual', metadata_revision = metadata_revision + 1,
        subtree_updated_at = ?, updated_at = ?
      WHERE conversation_id = ? AND metadata_revision = ?
    `).run(title, now, now, conversationId, expectedRevision);
    if (result.changes !== 1) throw new ConversationMetadataConflictError(conversationId);
    const conversation = this.conversation(conversationId)!;
    this.touchConversationFamily(conversation.rootConversationId, now);
    return conversation;
  }

  setConversationArchived(
    conversationId: string,
    expectedRevision: number,
    archived: boolean,
    now: number,
  ) {
    const result = this.database.prepare(`
      UPDATE conversations
      SET archived_at = ?, metadata_revision = metadata_revision + 1,
        subtree_updated_at = ?, updated_at = ?
      WHERE conversation_id = ? AND metadata_revision = ?
    `).run(archived ? now : null, now, now, conversationId, expectedRevision);
    if (result.changes !== 1) throw new ConversationMetadataConflictError(conversationId);
    const conversation = this.conversation(conversationId)!;
    this.touchConversationFamily(conversation.rootConversationId, now);
    return true;
  }

  setConversationHistoryState(
    conversationId: string,
    state: NativeConversationSummary['history']['state'],
    error?: string,
  ) {
    this.database.prepare(`
      UPDATE conversations SET history_state = ?, history_error = ?
      WHERE conversation_id = ?
    `).run(state, state === 'failed' ? error ?? 'Native history could not be loaded.' : null,
      conversationId);
  }

  observeConversationHistoryRevision(
    conversationId: string,
    revision: string,
  ) {
    const conversation = this.conversation(conversationId);
    if (!conversation) return false;
    const changed = conversation.history.nativeRevision !== revision;
    this.database.prepare(`
      UPDATE conversations
      SET native_history_revision = ?,
        history_state = CASE WHEN ? THEN 'indexed' ELSE history_state END,
        history_error = CASE WHEN ? THEN NULL ELSE history_error END
      WHERE conversation_id = ?
    `).run(revision, changed ? 1 : 0, changed ? 1 : 0, conversationId);
    return changed;
  }

  markConversationHistorySynced(
    conversationId: string,
    now: number,
    revision?: string,
  ) {
    this.database.prepare(`
      UPDATE conversations
      SET history_state = 'ready', history_error = NULL,
        native_history_revision = COALESCE(?, native_history_revision),
        history_synced_revision = COALESCE(?, native_history_revision),
        history_synced_at = ?
      WHERE conversation_id = ?
    `).run(
      revision ?? null,
      revision ?? null,
      now,
      conversationId,
    );
  }

  resetInterruptedHistoryLoads() {
    return this.database.prepare(`
      UPDATE conversations SET history_state = 'indexed', history_error = NULL
      WHERE history_state = 'loading'
        OR (history_state = 'failed' AND NOT EXISTS (
          SELECT 1 FROM turns WHERE turns.conversation_id = conversations.conversation_id
        ))
    `).run().changes;
  }

  turn(turnId: string): JournalTurn | undefined {
    const row = this.database.prepare(`
      SELECT t.*, p.path_entry_id, p.strand_id AS path_strand_id, p.ordinal
      FROM turns t
      LEFT JOIN strand_turn_path p ON p.turn_id = t.turn_id
        AND p.strand_id = (
          SELECT h.strand_id FROM conversation_heads h
          WHERE h.conversation_id = t.conversation_id
        )
      WHERE t.turn_id = ?
    `).get(turnId) as
      | Record<string, unknown>
      | undefined;
    return row ? turnRow(row) : undefined;
  }

  turns(conversationId: string): JournalTurn[] {
    return (this.database.prepare(`
      SELECT t.*, p.path_entry_id, p.strand_id AS path_strand_id, p.ordinal
      FROM conversation_heads h
      JOIN strand_turn_path p ON p.strand_id = h.strand_id
      JOIN turns t USING(turn_id)
      WHERE h.conversation_id = ?
      ORDER BY p.ordinal
    `).all(conversationId) as Record<string, unknown>[]).map(turnRow);
  }

  turnsForStrand(strandId: string): JournalTurn[] {
    return (this.database.prepare(`
      SELECT t.*, p.path_entry_id, p.strand_id AS path_strand_id, p.ordinal
      FROM strand_turn_path p
      JOIN turns t USING(turn_id)
      WHERE p.strand_id = ?
      ORDER BY p.ordinal
    `).all(strandId) as Record<string, unknown>[]).map(turnRow);
  }

  turnsForExecution(executionId: string): JournalTurn[] {
    return (this.database.prepare(`
      SELECT t.*, p.path_entry_id, p.strand_id AS path_strand_id, p.ordinal
      FROM turns t
      LEFT JOIN strand_turn_path p ON p.turn_id = t.turn_id AND p.strand_id = t.origin_strand_id
      WHERE t.execution_id = ? ORDER BY t.created_at, t.rowid
    `).all(executionId) as Record<string, unknown>[]).map(turnRow);
  }

  execution(executionId: string): JournalExecution | undefined {
    const row = this.database.prepare('SELECT * FROM executions WHERE execution_id = ?').get(executionId) as
      | Record<string, unknown>
      | undefined;
    return row ? executionRow(row) : undefined;
  }

  childExecutions(parentExecutionId: string): JournalExecution[] {
    return (this.database.prepare(`
      SELECT * FROM executions WHERE parent_execution_id = ? ORDER BY created_at, execution_id
    `).all(parentExecutionId) as Record<string, unknown>[]).map(executionRow);
  }

  nativeChildBindings(parentExecutionId: string, nativeParentThreadId: string) {
    const descendants: JournalExecution[] = [];
    const queue = [parentExecutionId];
    const visited = new Set(queue);
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      for (const child of this.childExecutions(parentId)) {
        if (child.ownership !== 'native') continue;
        if (visited.has(child.executionId)) continue;
        visited.add(child.executionId);
        descendants.push(child);
        queue.push(child.executionId);
      }
    }
    const nativeThreadByExecution = new Map<string, string>([[parentExecutionId, nativeParentThreadId]]);
    for (const execution of descendants) {
      const handle = this.nativeChildHandle(execution.executionId);
      if (handle) nativeThreadByExecution.set(execution.executionId, handle.nativeSessionId);
    }
    return descendants.flatMap((execution) => {
      if (execution.ownership !== 'native' || !execution.rootTurnId) return [];
      const handle = this.nativeChildHandle(execution.executionId);
      const owner = this.turn(execution.rootTurnId);
      if (!handle || !owner?.nativeTurnId) return [];
      const nativeTurnBindings = this.turnsForExecution(execution.executionId)
        .filter((turn) => turn.nativeTurnId)
        .map((turn) => ({
          turnId: turn.turnId,
          nativeTurnId: turn.nativeTurnId!,
          nextBlockOrdinal: this.nextTurnBlockOrdinal(turn.turnId),
        }));
      const activeNativeTurnId = this.turnsForExecution(execution.executionId)
        .filter((turn) => turn.nativeTurnId &&
          (turn.state === 'running' || turn.state === 'recovering'))
        .map((turn) => turn.nativeTurnId!)
        .at(-1);
      const canonical = this.orderedPasses(execution.rootTurnId).flatMap((pass) =>
        pass.blocks.map((block) => ({ pass, block })))
        .find(({ block }) => block.kind === 'native-child' &&
          block.payload.kind === 'native-child' &&
          block.payload.child.executionId === execution.executionId);
      return [{
        nativeThreadId: handle.nativeSessionId,
        executionId: execution.executionId,
        parentExecutionId: execution.parentExecutionId!,
        nativeParentThreadId: nativeThreadByExecution.get(execution.parentExecutionId!)!,
        ownerTurnId: execution.rootTurnId,
        ownerNativeTurnId: owner.nativeTurnId,
        ...(activeNativeTurnId ? { activeNativeTurnId } : {}),
        nativeTurnBindings,
        terminalNativeTurnIds: this.turnsForExecution(execution.executionId)
          .filter((turn) => turn.nativeTurnId && turn.outcome)
          .map((turn) => turn.nativeTurnId!),
        ...(canonical ? { canonicalBlock: {
          structure: {
            passId: canonical.pass.passId,
            blockId: canonical.block.blockId,
            passOrdinal: canonical.pass.ordinal,
            blockOrdinal: canonical.block.ordinal,
          },
          revision: canonical.block.revision,
          block: {
            kind: canonical.block.kind,
            state: canonical.block.state,
            payload: canonical.block.payload,
          },
        } } : {}),
        ...(execution.outcome ? { outcome: execution.outcome } : {}),
      }];
    });
  }

  executionsForConversation(conversationId: string): JournalExecution[] {
    return (this.database.prepare(`
      SELECT * FROM executions WHERE conversation_id = ? ORDER BY created_at, execution_id
    `).all(conversationId) as Record<string, unknown>[]).map(executionRow);
  }

  executionsForAllConversations(): JournalExecution[] {
    return (this.database.prepare(`
      SELECT * FROM executions ORDER BY created_at, execution_id
    `).all() as Record<string, unknown>[]).map(executionRow);
  }

  outstandingStopIntent(conversationId: string, scopeExecutionId: string | null) {
    return this.database.prepare(`
      SELECT * FROM stop_intents
      WHERE conversation_id = ? AND COALESCE(scope_execution_id, '') = COALESCE(?, '')
        AND state = 'outstanding'
    `).get(conversationId, scopeExecutionId) as Record<string, unknown> | undefined;
  }

  outstandingStopIntents() {
    return this.database.prepare(`
      SELECT * FROM stop_intents WHERE state = 'outstanding' ORDER BY created_at, intent_id
    `).all() as Record<string, unknown>[];
  }

  createStopIntent(input: {
    intentId: string; conversationId: string; rootExecutionId: string;
    scopeExecutionId: string | null; queuePaused: boolean; now: number;
  }) {
    this.database.prepare(`
      INSERT OR IGNORE INTO stop_intents(
        intent_id, conversation_id, root_execution_id, scope_execution_id, state,
        queue_paused, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'outstanding', ?, ?, ?)
    `).run(input.intentId, input.conversationId, input.rootExecutionId,
      input.scopeExecutionId, input.queuePaused ? 1 : 0, input.now, input.now);
  }

  addStopTarget(input: {
    intentId: string; executionId: string; assignmentTurnId: string;
    nativeTurnId?: string; now: number;
  }) {
    this.database.prepare(`
      INSERT OR IGNORE INTO stop_intent_targets(
        intent_id, execution_id, assignment_turn_id, native_turn_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(input.intentId, input.executionId, input.assignmentTurnId,
      input.nativeTurnId ?? null, input.now, input.now);
  }

  stopTargets(intentId: string) {
    return this.database.prepare(`
      SELECT * FROM stop_intent_targets WHERE intent_id = ?
      ORDER BY created_at, execution_id, assignment_turn_id
    `).all(intentId) as Record<string, unknown>[];
  }

  updateStopTarget(intentId: string, executionId: string, assignmentTurnId: string,
    state: 'pending' | 'accepted' | 'terminal' | 'failed', error: string | null, now: number) {
    this.database.prepare(`
      UPDATE stop_intent_targets SET state = ?, error = ?, updated_at = MAX(updated_at, ?)
      WHERE intent_id = ? AND execution_id = ? AND assignment_turn_id = ?
    `).run(state, error, now, intentId, executionId, assignmentTurnId);
  }

  settleStopIntent(intentId: string, now: number) {
    this.database.prepare(`
      UPDATE stop_intents SET state = 'settled', updated_at = MAX(updated_at, ?)
      WHERE intent_id = ? AND state = 'outstanding'
        AND NOT EXISTS (
          SELECT 1 FROM stop_intent_targets
          WHERE stop_intent_targets.intent_id = stop_intents.intent_id
            AND state != 'terminal'
        )
    `).run(now, intentId);
  }

  hasOutstandingConversationStop(conversationId: string) {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM stop_intents WHERE conversation_id = ? AND state = 'outstanding'
        AND scope_execution_id IS NULL
    `).get(conversationId));
  }

  hasConversationQueuePause(conversationId: string) {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM stop_intents WHERE conversation_id = ? AND queue_paused = 1
    `).get(conversationId));
  }

  stopLifecycle(conversationId: string) {
    const intents = this.database.prepare(`
      SELECT * FROM stop_intents WHERE conversation_id = ? AND state = 'outstanding'
    `).all(conversationId) as Record<string, unknown>[];
    const targets = this.database.prepare(`
      SELECT t.*, CASE WHEN turns.outcome IS NOT NULL THEN 'terminal' ELSE t.state END AS state
      FROM stop_intent_targets t
      JOIN stop_intents i USING(intent_id)
      LEFT JOIN turns ON turns.turn_id = t.assignment_turn_id
      WHERE i.conversation_id = ? AND i.state = 'outstanding'
    `).all(conversationId) as Record<string, unknown>[];
    return { intents, targets };
  }

  clearSettledConversationQueuePause(conversationId: string, now: number) {
    this.database.prepare(`
      UPDATE stop_intents SET queue_paused = 0, updated_at = MAX(updated_at, ?)
      WHERE conversation_id = ? AND state = 'settled' AND queue_paused = 1
    `).run(now, conversationId);
  }

  federatedExecutionsNeedingRecovery(): JournalExecution[] {
    return (this.database.prepare(`
      SELECT e.* FROM executions e
      JOIN native_sessions n USING(execution_id)
      WHERE e.ownership = 'federated'
        AND e.state IN ('running', 'recovering')
        AND n.state != 'closed'
      ORDER BY e.updated_at, e.execution_id
    `).all() as Record<string, unknown>[]).map(executionRow);
  }

  federatedExecutionsWithoutRecoveryHandle(): JournalExecution[] {
    return (this.database.prepare(`
      SELECT e.* FROM executions e
      WHERE e.ownership = 'federated'
        AND e.state IN ('running', 'recovering')
        AND NOT EXISTS (
          SELECT 1 FROM native_sessions n WHERE n.execution_id = e.execution_id
        )
      ORDER BY e.updated_at, e.execution_id
    `).all() as Record<string, unknown>[]).map(executionRow);
  }

  federatedExecutionsWithoutInitialTurn(): JournalExecution[] {
    return (this.database.prepare(`
      SELECT e.* FROM executions e
      WHERE e.ownership = 'federated'
        AND e.outcome IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM turns t WHERE t.execution_id = e.execution_id
        )
      ORDER BY e.updated_at, e.execution_id
    `).all() as Record<string, unknown>[]).map(executionRow);
  }

  conversationsNeedingRecovery(): JournalConversation[] {
    return (this.database.prepare(`
      SELECT c.*, p.provider, h.strand_id AS active_strand_id, h.revision AS head_revision,
        (SELECT COUNT(*) FROM conversation_strands s
          WHERE s.conversation_id = c.conversation_id AND s.state IN ('ready', 'orphaned')) AS version_count,
        (SELECT COUNT(*) FROM conversations child
          WHERE child.parent_conversation_id = c.conversation_id AND child.archived_at IS NULL
            AND EXISTS (
              SELECT 1 FROM conversation_heads child_h
              JOIN conversation_strands child_s ON child_s.strand_id = child_h.strand_id
              WHERE child_h.conversation_id = child.conversation_id AND child_s.state = 'ready'
            )) AS child_count
      FROM conversations c
      JOIN provider_instances p USING(provider_instance_id)
      JOIN conversation_heads h USING(conversation_id)
      WHERE c.resumable = 1
        AND (c.state IN ('running', 'recovering') OR c.active_turn_id IS NOT NULL)
      ORDER BY c.updated_at
    `).all() as Record<string, unknown>[]).map(conversationRow);
  }

  conversationsWithoutRecoveryHandle(): JournalConversation[] {
    return (this.database.prepare(`
      SELECT c.*, p.provider, h.strand_id AS active_strand_id, h.revision AS head_revision,
        (SELECT COUNT(*) FROM conversation_strands s
          WHERE s.conversation_id = c.conversation_id AND s.state IN ('ready', 'orphaned')) AS version_count,
        (SELECT COUNT(*) FROM conversations child
          WHERE child.parent_conversation_id = c.conversation_id AND child.archived_at IS NULL
            AND EXISTS (
              SELECT 1 FROM conversation_heads child_h
              JOIN conversation_strands child_s ON child_s.strand_id = child_h.strand_id
              WHERE child_h.conversation_id = child.conversation_id AND child_s.state = 'ready'
            )) AS child_count
      FROM conversations c
      JOIN provider_instances p USING(provider_instance_id)
      JOIN conversation_heads h USING(conversation_id)
      WHERE c.resumable = 0
        AND (c.state IN ('running', 'recovering') OR c.active_turn_id IS NOT NULL)
      ORDER BY c.updated_at
    `).all() as Record<string, unknown>[]).map(conversationRow);
  }

  markConversationRecovering(
    conversationId: string,
    message: string | undefined,
    now: number,
    expectedRootExecutionId?: string,
  ) {
    return this.transaction(() => {
      const conversation = this.conversation(conversationId);
      if (!conversation || (expectedRootExecutionId &&
          conversation.rootExecutionId !== expectedRootExecutionId)) return false;
      this.database.prepare(`
        UPDATE conversations SET state = 'recovering', health_message = ?, updated_at = ?
        WHERE conversation_id = ?
      `).run(message ?? null, now, conversationId);
      this.database.prepare(`
        UPDATE executions SET state = 'recovering', updated_at = ?
        WHERE execution_id = ?
      `).run(now, conversation.rootExecutionId);
      this.database.prepare(`
        UPDATE turns SET state = 'recovering', updated_at = ?
        WHERE turn_id = (SELECT active_turn_id FROM conversations WHERE conversation_id = ?)
          AND execution_id = ? AND state = 'running'
      `).run(now, conversationId, conversation.rootExecutionId);
      return true;
    });
  }

  markExecutionRecovering(executionId: string, now: number) {
    this.transaction(() => {
      this.database.prepare(`
        UPDATE executions SET state = 'recovering', updated_at = ? WHERE execution_id = ?
      `).run(now, executionId);
      this.database.prepare(`
        UPDATE native_sessions SET state = 'recovering', last_observed_at = ? WHERE execution_id = ?
      `).run(now, executionId);
      this.database.prepare(`
        UPDATE turns SET state = 'recovering', updated_at = ?
        WHERE execution_id = ? AND state = 'running'
      `).run(now, executionId);
    });
  }

  confirmExecutionRunning(executionId: string, now: number) {
    return this.transaction(() => {
      const active = this.database.prepare(`
        SELECT turn_id, conversation_id FROM turns
        WHERE execution_id = ? AND state IN ('running', 'recovering')
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(executionId) as { turn_id: string; conversation_id: string } | undefined;
      if (!active) return undefined;
      this.database.prepare(`
        UPDATE turns SET state = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE turn_id = ? AND state IN ('running', 'recovering')
      `).run(now, now, active.turn_id);
      this.database.prepare(`
        UPDATE executions SET state = 'running', outcome = NULL, completed_at = NULL, updated_at = ?
        WHERE execution_id = ?
      `).run(now, executionId);
      if (this.isRootExecution(active.conversation_id, executionId)) {
        this.database.prepare(`
          UPDATE conversations SET state = 'running', active_turn_id = ?,
            health_message = NULL, updated_at = ?
          WHERE conversation_id = ? AND root_execution_id = ?
        `).run(active.turn_id, now, active.conversation_id, executionId);
      }
      return active.turn_id;
    });
  }

  setExecutionLifecycleError(executionId: string, message: string | null, now: number) {
    this.database.prepare(`
      UPDATE executions SET lifecycle_error = ?, updated_at = MAX(updated_at, ?)
      WHERE execution_id = ?
    `).run(message, now, executionId);
  }

  failTurnDispatch(turnId: string, message: string, now: number) {
    const turn = this.turn(turnId);
    if (!turn) return;
    this.transaction(() => {
      this.database.prepare(`
        UPDATE turns SET state = 'failed', outcome = 'failed', error_json = ?,
          completed_at = ?, updated_at = ? WHERE turn_id = ?
      `).run(JSON.stringify({ code: 'provider_dispatch_failed', message }), now, now, turnId);
      if (this.isRootExecution(turn.conversationId, turn.executionId)) {
        this.database.prepare(`
          UPDATE conversations SET state = 'idle', active_turn_id = NULL,
            health_message = ?, updated_at = ? WHERE conversation_id = ?
        `).run(message, now, turn.conversationId);
      }
      this.database.prepare(`
        UPDATE executions SET state = 'failed', outcome = 'failed',
          completed_at = ?, updated_at = ? WHERE execution_id = ?
      `).run(now, now, turn.executionId);
    });
  }

  failRecovery(
    conversationId: string,
    message: string,
    now: number,
    expectedRootExecutionId?: string,
  ) {
    return this.transaction(() => {
      const conversation = this.conversation(conversationId);
      if (!conversation || (expectedRootExecutionId &&
          conversation.rootExecutionId !== expectedRootExecutionId)) return false;
      if (conversation.activeTurnId) {
        this.database.prepare(`
          UPDATE turns SET state = 'failed', outcome = 'recovery_failed',
            error_json = ?, completed_at = ?, updated_at = ?
          WHERE turn_id = ? AND execution_id = ? AND state IN ('running', 'recovering')
        `).run(
          JSON.stringify({ code: 'recovery_failed', message }),
          now,
          now,
          conversation.activeTurnId,
          conversation.rootExecutionId,
        );
        this.database.prepare(`
          UPDATE turn_passes SET state = 'completed', updated_at = MAX(updated_at, ?)
          WHERE turn_id IN (
            SELECT turn_id FROM turns WHERE turn_id = ? AND execution_id = ?
          )
        `).run(now, conversation.activeTurnId, conversation.rootExecutionId);
      }
      this.database.prepare(`
        UPDATE conversations SET state = 'failed', active_turn_id = NULL,
          health_message = ?, resumable = 0, updated_at = ? WHERE conversation_id = ?
      `).run(message, now, conversationId);
      this.database.prepare(`
        UPDATE executions SET state = 'failed', outcome = 'recovery_failed',
          completed_at = ?, updated_at = ? WHERE execution_id = ?
      `).run(now, now, conversation.rootExecutionId);
      return true;
    });
  }

  /**
   * Repairs journals written by the pre-fencing recovery path. A native
   * terminal event observed after Remux inferred recovery_failed is stronger
   * evidence than that inference, but older reducers kept the first terminal
   * state forever. Re-reduce only those exact later terminal envelopes.
   */
  repairRecoveryFailuresWithLaterNativeTerminalEvents() {
    const rows = this.database.prepare(`
      SELECT e.envelope_json
      FROM events e
      JOIN turns t ON t.turn_id = e.turn_id
      WHERE t.outcome = 'recovery_failed'
        AND e.event_type = 'turn.completed'
        AND e.observed_at > COALESCE(t.completed_at, 0)
      ORDER BY e.sequence
    `).all() as Array<{ envelope_json: string }>;
    return this.transaction(() => {
      const repaired = new Set<string>();
      for (const row of rows) {
        const envelope = parseProviderEventEnvelope(JSON.parse(row.envelope_json));
        if (envelope.scope.kind !== 'turn' || envelope.event.type !== 'turn.completed') continue;
        this.reduceEvent(envelope);
        if (this.turn(envelope.scope.turnId)?.outcome === envelope.event.outcome) {
          repaired.add(envelope.scope.turnId);
        }
      }
      return [...repaired];
    });
  }

  failExecution(executionId: string, message: string, now: number) {
    this.transaction(() => {
      this.database.prepare(`
        UPDATE turns SET state = 'failed', outcome = 'recovery_failed', error_json = ?,
          completed_at = ?, updated_at = ?
        WHERE execution_id = ? AND state IN ('running', 'recovering')
      `).run(JSON.stringify({ code: 'recovery_failed', message }), now, now, executionId);
      this.database.prepare(`
        UPDATE turn_passes SET state = 'completed', updated_at = MAX(updated_at, ?)
        WHERE turn_id IN (
          SELECT turn_id FROM turns WHERE execution_id = ?
        )
      `).run(now, executionId);
      this.database.prepare(`
        UPDATE executions SET state = 'failed', outcome = 'recovery_failed', summary = ?,
          completed_at = ?, updated_at = ? WHERE execution_id = ?
      `).run(message, now, now, executionId);
    });
  }

  nextTurnBlockOrdinal(turnId: string) {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
      FROM turn_blocks WHERE turn_id = ?
    `).get(turnId) as { next_ordinal: number };
    return row.next_ordinal;
  }

  orderedPasses(
    turnId: string,
    options: { includeToolOutputPreviews?: boolean } = {},
  ): NativeAssistantPass[] {
    const passes = this.database.prepare(`
      SELECT * FROM turn_passes WHERE turn_id = ? ORDER BY ordinal, pass_id
    `).all(turnId) as Record<string, unknown>[];
    const payloadProjection = options.includeToolOutputPreviews === false
      ? `json_remove(b.payload_json, '$.outputPreview')`
      : 'b.payload_json';
    const blocks = this.database.prepare(`
      SELECT b.*, p.ordinal AS pass_ordinal, ${payloadProjection} AS projected_payload_json
      FROM turn_blocks b JOIN turn_passes p USING(pass_id)
      WHERE b.turn_id = ?
      ORDER BY p.ordinal, b.ordinal, b.block_id
    `).all(turnId) as Record<string, unknown>[];
    const byPass = new Map<string, NativeOrderedTurnBlock[]>();
    for (const row of blocks) {
      const passId = String(row.pass_id);
      const list = byPass.get(passId) ?? [];
      const persistedPayload = JSON.parse(String(row.projected_payload_json)) as unknown;
      list.push({
        blockId: String(row.block_id),
        passId,
        ordinal: Number(row.ordinal),
        kind: row.kind as NativeOrderedTurnBlock['kind'],
        state: row.state as NativeOrderedTurnBlock['state'],
        revision: Number(row.revision),
        payload: row.kind === 'reasoning-summary'
          ? normalizeLegacyReasoningSummaryPayload(persistedPayload)
          : persistedPayload as NativeOrderedTurnBlock['payload'],
        startedAt: row.started_at === null ? null : Number(row.started_at),
        completedAt: row.completed_at === null ? null : Number(row.completed_at),
      });
      byPass.set(passId, list);
    }
    return passes.map((row) => ({
      passId: String(row.pass_id),
      ordinal: Number(row.ordinal),
      state: row.state as NativeAssistantPass['state'],
      blocks: byPass.get(String(row.pass_id)) ?? [],
    }));
  }

  latestUsage(conversationId: string, turnId?: string): UsageDisplay | null {
    const row = this.database.prepare(`
      SELECT u.usage_json, t.execution_id, x.provider, e.native_kind, e.sequence
      FROM usage_snapshots u
      JOIN turns t ON t.turn_id = u.turn_id
      JOIN executions x ON x.execution_id = t.execution_id
      JOIN conversations c ON c.conversation_id = u.conversation_id
      LEFT JOIN events e ON e.event_id = u.event_id
      WHERE u.conversation_id = ? AND (
        (? IS NULL AND t.execution_id = c.root_execution_id) OR u.turn_id = ?
      )
      ORDER BY u.observed_at DESC, u.event_id DESC LIMIT 1
    `).get(conversationId, turnId ?? null, turnId ?? null) as {
      usage_json: string; execution_id: string; provider: ProviderKind;
      native_kind: string | null; sequence: number | null;
    } | undefined;
    if (!row) return null;
    const usage = JSON.parse(row.usage_json) as UsageDisplay;
    // The old Claude result mapper persisted accumulated turn usage as context.
    // Keep its accounting, but never replay that invalid measurement. This also
    // covers legacy snapshots without a matching event, without mutating history.
    if (row.provider === 'claude-code' &&
        (row.native_kind === 'result/usage' || row.native_kind === null)) {
      return { ...usage, context: null };
    }
    if (usage.context && this.database.prepare(`
      SELECT 1 FROM events
      WHERE execution_id = ? AND event_type = 'context.compaction.completed'
        AND (observed_at > ? OR (observed_at = ? AND sequence > ?)) LIMIT 1
    `).get(row.execution_id, usage.context.observedAt, usage.context.observedAt, row.sequence ?? -1)) {
      return { ...usage, context: null };
    }
    return usage;
  }

  providerAccountUsage(providerInstanceId: string): ProviderAccountUsage | null {
    const row = this.database.prepare(`
      SELECT usage_json FROM provider_account_usage WHERE provider_instance_id = ?
    `).get(providerInstanceId) as { usage_json: string } | undefined;
    return row ? JSON.parse(row.usage_json) as ProviderAccountUsage : null;
  }

  markPersistedUsageCached() {
    this.transaction(() => {
      this.database.prepare(`
        UPDATE provider_account_usage
        SET usage_json = json_set(usage_json, '$.freshness', 'cached')
        WHERE json_extract(usage_json, '$.freshness') = 'live'
      `).run();
      this.database.prepare(`
        UPDATE usage_snapshots
        SET usage_json = json_set(usage_json, '$.context.freshness', 'cached')
        WHERE json_extract(usage_json, '$.context.freshness') = 'live'
      `).run();
    });
  }

  composerPreference(
    scope: JournalComposerPreference['scope'],
    scopeId: string,
  ): JournalComposerPreference | undefined {
    const row = this.database.prepare(`
      SELECT * FROM composer_preferences WHERE scope = ? AND scope_id = ?
    `).get(scope, scopeId) as Record<string, unknown> | undefined;
    return row ? composerPreferenceRow(row) : undefined;
  }

  listComposerPreferences(): JournalComposerPreference[] {
    return (this.database.prepare(`
      SELECT * FROM composer_preferences ORDER BY scope, scope_id
    `).all() as Record<string, unknown>[]).map(composerPreferenceRow);
  }

  setComposerPreference(input: {
    scope: JournalComposerPreference['scope'];
    scopeId: string;
    providerInstanceId: string;
    model: string | null;
    effort: string | null;
    serviceTier?: string | null;
    now: number;
  }) {
    const current = this.composerPreference(input.scope, input.scopeId);
    const revision = (current?.revision ?? 0) + 1;
    this.database.prepare(`
      INSERT INTO composer_preferences(
        scope, scope_id, provider_instance_id, model, effort, service_tier, revision, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, scope_id) DO UPDATE SET
        provider_instance_id = excluded.provider_instance_id,
        model = excluded.model,
        effort = excluded.effort,
        service_tier = excluded.service_tier,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `).run(
      input.scope,
      input.scopeId,
      input.providerInstanceId,
      input.model,
      input.effort,
      input.serviceTier ?? null,
      revision,
      input.now,
    );
    return this.composerPreference(input.scope, input.scopeId)!;
  }

  composerPreferencesRevision() {
    return hashJson(this.listComposerPreferences());
  }

  lastDispatchedTurn(conversationId: string): JournalTurn | null {
    const row = this.database.prepare(`
      SELECT * FROM turns
      WHERE conversation_id = ? AND started_at IS NOT NULL
      ORDER BY started_at DESC, turn_id DESC LIMIT 1
    `).get(conversationId) as Record<string, unknown> | undefined;
    return row ? turnRow(row) : null;
  }

  compactionOperation(operationId: string): JournalCompactionOperation | undefined {
    const row = this.database.prepare(`
      SELECT * FROM compaction_operations WHERE operation_id = ?
    `).get(operationId) as Record<string, unknown> | undefined;
    return row ? compactionOperationRow(row) : undefined;
  }

  latestCompactionOperation(conversationId: string): JournalCompactionOperation | undefined {
    const row = this.database.prepare(`
      SELECT * FROM compaction_operations WHERE conversation_id = ?
      ORDER BY created_at DESC, operation_id DESC LIMIT 1
    `).get(conversationId) as Record<string, unknown> | undefined;
    return row ? compactionOperationRow(row) : undefined;
  }

  compactionGeneration(conversationId: string) {
    return Number((this.database.prepare(`
      SELECT COUNT(*) AS generation FROM compaction_operations
      WHERE conversation_id = ? AND state = 'completed'
    `).get(conversationId) as { generation: number }).generation);
  }

  runtimeCompaction(conversationId: string, policy: RuntimeCompactionView['policy']): RuntimeCompactionView {
    const latest = this.latestCompactionOperation(conversationId);
    const lastCompletedRow = this.database.prepare(`
      SELECT * FROM compaction_operations
      WHERE conversation_id = ? AND state = 'completed'
      ORDER BY completed_at DESC, operation_id DESC LIMIT 1
    `).get(conversationId) as Record<string, unknown> | undefined;
    const lastCompleted = lastCompletedRow ? compactionOperationRow(lastCompletedRow) : undefined;
    const lastResult = lastCompleted ? {
      operationId: lastCompleted.operationId,
      trigger: lastCompleted.trigger,
      disposition: lastCompleted.disposition ?? 'dispatched' as const,
      beforeTokens: lastCompleted.beforeTokens,
      afterTokens: lastCompleted.afterTokens,
      completedAt: lastCompleted.completedAt ?? lastCompleted.updatedAt,
    } : null;
    if (latest?.state === 'queued' || latest?.state === 'running') {
      return {
        policy,
        operation: {
          state: 'running',
          trigger: latest.trigger,
          operationId: latest.operationId,
          startedAt: latest.startedAt ?? latest.createdAt,
        },
      };
    }
    if (latest?.state === 'failed' || latest?.state === 'delivery_unknown') {
      return {
        policy,
        operation: {
          state: 'failed',
          trigger: latest.trigger,
          operationId: latest.operationId,
          error: latest.error ?? {
            code: latest.state,
            message: latest.state === 'delivery_unknown'
              ? 'The native compaction result could not be reconciled.'
              : 'Native compaction failed.',
          },
          failedAt: latest.completedAt ?? latest.updatedAt,
          lastResult,
        },
      };
    }
    return { policy, operation: { state: 'idle', lastResult } };
  }

  latestSequence() {
    return Number((this.database.prepare(`
      SELECT MAX(sequence) AS sequence FROM (
        SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events
        UNION ALL
        SELECT COALESCE(MAX(sequence), 0) AS sequence FROM legacy_events
      )
    `)
      .get() as { sequence: number }).sequence);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private reduceEvent(envelope: ProviderEventEnvelope) {
    const event = envelope.event;
    // Provider events may precede durable admission or arrive again in history
    // snapshots. Preserve their observation time, but never move a materialized
    // row's updated_at backward (including before its created_at).
    const now = envelope.observedAt;
    const scope = envelope.scope;
    if (scope.kind === 'account') {
      if (event.type === 'account.usage-updated') {
        const previous = this.providerAccountUsage(scope.providerInstanceId);
        const usage = event.usage.source === 'provider-push' &&
          event.usage.availability === 'available' &&
          previous?.availability === 'available'
          ? {
              ...event.usage,
              windows: [...new Map([
                ...previous.windows,
                ...event.usage.windows,
              ].map((window) => [window.id, window])).values()],
            }
          : event.usage;
        this.database.prepare(`
          INSERT INTO provider_account_usage(
            provider_instance_id, event_id, usage_json, observed_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(provider_instance_id) DO UPDATE SET
            event_id = excluded.event_id,
            usage_json = excluded.usage_json,
            observed_at = excluded.observed_at
          WHERE excluded.observed_at >= provider_account_usage.observed_at
        `).run(scope.providerInstanceId, envelope.eventId, JSON.stringify(usage), now);
      }
      return;
    }
    const { conversationId, executionId } = scope;
    const turnId = scope.kind === 'turn'
      ? scope.turnId
      : scope.kind === 'execution' ? scope.rootTurnId : undefined;
    const rootExecution = this.isRootExecution(conversationId, executionId);
    if (turnId && envelope.native.turnId) {
      this.database.prepare(`
        UPDATE turns SET native_turn_id = COALESCE(native_turn_id, ?), updated_at = MAX(updated_at, ?)
        WHERE turn_id = ?
      `).run(envelope.native.turnId, now, turnId);
      this.upsertNativeTurnBinding({
        providerInstanceId: scope.providerInstanceId,
        executionId,
        turnId,
        nativeTurnId: envelope.native.turnId,
        branchCursor: { version: 1, nativeTurnId: envelope.native.turnId },
        cursorVersion: 1,
        now,
      });
    }
    switch (event.type) {
      case 'user.message': {
        if (scope.kind !== 'turn' || rootExecution) break;
        this.database.prepare(`
          UPDATE turns SET user_content_json = ?, updated_at = MAX(updated_at, ?)
          WHERE turn_id = ?
        `).run(JSON.stringify(event.content), now, scope.turnId);
        break;
      }
      case 'session.health': {
        const active = this.database.prepare(`
          SELECT turn_id FROM turns
          WHERE execution_id = ? AND state IN ('running', 'recovering')
          ORDER BY created_at DESC LIMIT 1
        `).get(executionId) as { turn_id: string } | undefined;
        const executionState = event.state === 'ready'
          ? (active ? 'running' : 'idle')
          : 'recovering';
        this.database.prepare(`
          UPDATE native_sessions
          SET state = ?, last_observed_at = MAX(last_observed_at, ?)
          WHERE execution_id = ?
        `).run(event.state, now, executionId);
        this.database.prepare(`
          UPDATE executions SET state = ?, updated_at = MAX(updated_at, ?) WHERE execution_id = ?
        `).run(executionState, now, executionId);
        if (rootExecution) {
          this.database.prepare(`
            UPDATE conversations SET state = ?, health_message = ?, updated_at = MAX(updated_at, ?)
            WHERE conversation_id = ?
          `).run(executionState, event.state === 'ready' ? null : event.message ?? null,
            now, conversationId);
        }
        break;
      }
      case 'turn.started':
      case 'turn.status': {
        if (scope.kind !== 'turn') break;
        if (event.type === 'turn.status' && event.state === 'idle') break;
        const state = event.type === 'turn.started'
          ? 'running'
          : event.state;
        const updated = this.database.prepare(`
          UPDATE turns SET state = ?, started_at = COALESCE(started_at, ?), updated_at = MAX(updated_at, ?)
          WHERE turn_id = ? AND state NOT IN ('completed', 'failed', 'interrupted')
            AND updated_at <= ?
        `).run(state, now, now, scope.turnId, now);
        if (updated.changes === 0) break;
        if (rootExecution) {
          this.database.prepare(`
            UPDATE conversations SET state = ?, active_turn_id = ?, updated_at = MAX(updated_at, ?)
            WHERE conversation_id = ?
          `).run(state, scope.turnId, now, conversationId);
        }
        this.database.prepare(`
          UPDATE executions SET state = ?, outcome = NULL, completed_at = NULL, updated_at = MAX(updated_at, ?)
          WHERE execution_id = ?
        `).run(state, now, executionId);
        break;
      }
      case 'turn.completed': {
        if (scope.kind !== 'turn') break;
        const previousTurn = this.turn(scope.turnId);
        const repairsRecoveryFailure = previousTurn?.outcome === 'recovery_failed' &&
          now > (previousTurn.completedAt ?? 0);
        const state = event.outcome === 'completed'
          ? 'completed'
          : event.outcome === 'interrupted' ? 'interrupted' : 'failed';
        const completed = this.database.prepare(`
          UPDATE turns SET state = ?, outcome = ?, error_json = ?, completed_at = ?, updated_at = MAX(updated_at, ?)
          WHERE turn_id = ? AND (
            state NOT IN ('completed', 'failed', 'interrupted') OR
            (outcome = 'recovery_failed' AND completed_at < ?)
          )
        `).run(
          state,
          event.outcome,
          event.error ? JSON.stringify(event.error) : null,
          now,
          now,
          scope.turnId,
          now,
        );
        if (completed.changes === 0) break;
        if (rootExecution) {
          this.database.prepare(`
            UPDATE conversations SET state = 'idle', active_turn_id = NULL,
              health_message = NULL, resumable = CASE WHEN ? THEN 1 ELSE resumable END,
              updated_at = MAX(updated_at, ?) WHERE conversation_id = ? AND (
                active_turn_id = ? OR (? = 1 AND active_turn_id IS NULL AND latest_turn_id = ?)
              )
          `).run(repairsRecoveryFailure ? 1 : 0, now, conversationId, scope.turnId,
            repairsRecoveryFailure ? 1 : 0, scope.turnId);
        }
        const executionState = event.outcome === 'completed'
          ? 'idle'
          : event.outcome === 'interrupted' ? 'interrupted' : 'failed';
        this.database.prepare(`
          UPDATE executions SET state = ?, outcome = ?, completed_at = ?, updated_at = MAX(updated_at, ?)
          WHERE execution_id = ? AND NOT EXISTS (
            SELECT 1 FROM turns newer
            WHERE newer.execution_id = executions.execution_id
              AND newer.turn_id != ?
              AND newer.state IN ('running', 'recovering')
          )
        `).run(executionState, event.outcome, now, now, executionId, scope.turnId);
        this.database.prepare(`
          UPDATE turn_passes SET state = 'completed', updated_at = MAX(updated_at, ?)
          WHERE turn_id = ?
        `).run(now, scope.turnId);
        break;
      }
      case 'turn.block.started':
      case 'turn.block.revised':
      case 'turn.block.completed': {
        if (scope.kind !== 'turn') break;
        const { structure, block } = event;
        this.database.prepare(`
          INSERT INTO turn_passes(
            pass_id, turn_id, native_message_id, ordinal, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, CASE WHEN (
              SELECT state FROM turns WHERE turn_id = ?
            ) IN ('completed', 'failed', 'interrupted')
            THEN 'completed' ELSE 'streaming' END, ?, ?)
          ON CONFLICT(pass_id) DO UPDATE SET
            native_message_id = COALESCE(excluded.native_message_id, native_message_id),
            ordinal = excluded.ordinal,
            updated_at = MAX(turn_passes.updated_at, excluded.updated_at)
        `).run(
          structure.passId,
          scope.turnId,
          envelope.native.messageId ?? null,
          structure.passOrdinal,
          scope.turnId,
          now,
          now,
        );
        const revision = event.type === 'turn.block.started' ? 0 : event.revision;
        const contentHash = event.type === 'turn.block.started'
          ? hashJson(block)
          : event.contentHash;
        const blockMutation = this.database.prepare(`
          INSERT INTO turn_blocks(
            block_id, turn_id, pass_id, kind, ordinal, state, revision,
            payload_json, content_hash, started_at, completed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(block_id) DO UPDATE SET
            pass_id = excluded.pass_id,
            kind = excluded.kind,
            ordinal = excluded.ordinal,
            state = excluded.state,
            revision = excluded.revision,
            payload_json = excluded.payload_json,
            content_hash = excluded.content_hash,
            started_at = COALESCE(turn_blocks.started_at, excluded.started_at),
            completed_at = COALESCE(excluded.completed_at, turn_blocks.completed_at),
            updated_at = MAX(turn_blocks.updated_at, excluded.updated_at)
          WHERE excluded.revision >= turn_blocks.revision
        `).run(
          structure.blockId,
          scope.turnId,
          structure.passId,
          block.kind,
          structure.blockOrdinal,
          block.state,
          revision,
          JSON.stringify(block.payload),
          contentHash,
          now,
          event.type === 'turn.block.completed' ? now : null,
          now,
          now,
        );
        if (blockMutation.changes > 0 &&
            (block.payload.kind === 'native-child' || block.payload.kind === 'federated-child')) {
          const { child } = block.payload;
          this.database.prepare(`
            INSERT INTO executions(
              execution_id, conversation_id, strand_id, parent_execution_id, root_turn_id,
              ownership, provider, provider_instance_id, model, title, state,
              outcome, summary, transcript_available, created_at, completed_at, updated_at
            ) VALUES (?, ?, (SELECT strand_id FROM executions WHERE execution_id = ?),
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(execution_id) DO UPDATE SET
              state = CASE
                WHEN executions.outcome IS NULL THEN excluded.state
                ELSE executions.state
              END,
              outcome = COALESCE(executions.outcome, excluded.outcome),
              summary = COALESCE(excluded.summary, executions.summary),
              model = COALESCE(excluded.model, executions.model),
              title = COALESCE(excluded.title, executions.title),
              transcript_available = MAX(
                executions.transcript_available,
                excluded.transcript_available
              ),
              completed_at = COALESCE(excluded.completed_at, executions.completed_at),
              updated_at = MAX(executions.updated_at, excluded.updated_at)
          `).run(
            child.executionId,
            conversationId,
            executionId,
            executionId,
            scope.turnId,
            child.ownership,
            child.provider,
            child.providerInstanceId ?? scope.providerInstanceId,
            child.model ?? null,
            child.title ?? null,
            block.payload.executionState,
            block.payload.outcome ?? null,
            block.payload.summary ?? null,
            child.ownership === 'federated' || child.transcriptAvailable === true ? 1 : 0,
            now,
            event.type === 'turn.block.completed' ? now : null,
            now,
          );
          this.bindNativeChildHandle(child, now);
        }
        if (!envelope.native.position) {
          this.database.prepare(`
            UPDATE turns SET ordering = CASE
              WHEN ordering = 'legacy-grouped' THEN ordering
              ELSE 'live-provisional'
            END, updated_at = MAX(updated_at, ?)
            WHERE turn_id = ?
          `).run(now, scope.turnId);
        } else if (envelope.native.position.kind === 'snapshot-index') {
          this.database.prepare(`
            UPDATE turns SET ordering = 'native-exact', updated_at = MAX(updated_at, ?)
            WHERE turn_id = ? AND ordering != 'legacy-grouped'
          `).run(now, scope.turnId);
        }
        break;
      }
      case 'turn.usage-updated': {
        if (scope.kind !== 'turn') break;
        this.database.prepare(`
          INSERT OR IGNORE INTO usage_snapshots(
            event_id, provider_instance_id, conversation_id, turn_id, usage_json, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          envelope.eventId,
          scope.providerInstanceId,
          conversationId,
          scope.turnId,
          JSON.stringify(event.usage),
          now,
        );
        break;
      }
      case 'turn.branch-point': {
        if (scope.kind !== 'turn') break;
        this.upsertNativeTurnBinding({
          providerInstanceId: scope.providerInstanceId,
          executionId,
          turnId: scope.turnId,
          ...(envelope.native.turnId ? { nativeTurnId: envelope.native.turnId } : {}),
          branchCursor: event.cursor,
          cursorVersion: event.cursorVersion,
          state: 'authoritative',
          now,
        });
        break;
      }
      case 'context.compaction.started':
      case 'context.compaction.completed':
      case 'context.compaction.failed': {
        const state = event.type === 'context.compaction.started'
          ? 'started'
          : event.type === 'context.compaction.completed' ? 'completed' : 'failed';
        this.database.prepare(`
          INSERT OR IGNORE INTO conversation_control_events(
            control_event_id, conversation_id, kind, boundary_json, state,
            operation_id, provider_subject_key, native_identity, payload_json,
            created_at, completed_at
          ) VALUES (?, ?, 'compaction', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          envelope.eventId,
          conversationId,
          JSON.stringify(this.compactionBoundary(executionId, envelope)),
          state,
          event.operationId,
          envelope.native.subject?.kind === 'context-compaction'
            ? envelope.native.subject.key
            : null,
          envelope.native.itemId ?? null,
          JSON.stringify(event),
          now,
          state === 'started' ? null : now,
        );
        this.reduceCompactionEvent(
          conversationId,
          event,
          now,
          envelope.native.subject?.kind === 'context-compaction'
            ? envelope.native.subject.key
            : undefined,
        );
        break;
      }
      case 'execution.started': {
        const child = event.child;
        this.database.prepare(`
          INSERT INTO executions(
            execution_id, conversation_id, strand_id, parent_execution_id, root_turn_id,
            ownership, provider, provider_instance_id, model, title, state,
            transcript_available, created_at, updated_at
          ) VALUES (?, ?, (SELECT strand_id FROM executions WHERE execution_id = ?),
            ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
          ON CONFLICT(execution_id) DO UPDATE SET
            state = CASE
              WHEN executions.outcome IS NULL AND excluded.updated_at >= executions.updated_at
                THEN 'running'
              ELSE executions.state
            END,
            model = COALESCE(excluded.model, model),
            title = COALESCE(excluded.title, title),
            transcript_available = MAX(
              executions.transcript_available,
              excluded.transcript_available
            ),
            updated_at = MAX(executions.updated_at, excluded.updated_at)
        `).run(
          child.executionId,
          conversationId,
          executionId,
          executionId,
          scope.kind === 'execution' ? scope.rootTurnId ?? null : null,
          child.ownership,
          child.provider,
          child.providerInstanceId ?? scope.providerInstanceId,
          child.model ?? null,
          child.title ?? null,
          child.ownership === 'federated' || child.transcriptAvailable === true ? 1 : 0,
          now,
          now,
        );
        this.bindNativeChildHandle(child, now);
        break;
      }
      case 'execution.status':
        this.database.prepare(`
          UPDATE executions SET state = ?, updated_at = MAX(updated_at, ?)
          WHERE execution_id = ? AND outcome IS NULL AND updated_at <= ?
        `).run(event.state, now, event.childExecutionId, now);
        break;
      case 'execution.summary':
        this.database.prepare(`
          UPDATE executions SET summary = ?, updated_at = MAX(updated_at, ?) WHERE execution_id = ?
        `).run(event.summary, now, event.childExecutionId);
        break;
      case 'execution.completed': {
        const state = event.outcome === 'completed'
          ? 'idle'
          : event.outcome === 'interrupted' ? 'interrupted' : 'failed';
        this.database.prepare(`
          UPDATE executions SET state = ?, outcome = ?, completed_at = ?, updated_at = MAX(updated_at, ?)
          WHERE execution_id = ? AND outcome IS NULL
        `).run(state, event.outcome, now, now, event.childExecutionId);
        break;
      }
    }
    const conversation = this.conversation(conversationId);
    if (conversation) this.touchConversationFamily(conversation.rootConversationId, now);
  }

  private bindNativeChildHandle(child: ChildExecutionDisplay, now: number) {
    if (child.ownership !== 'native' || !child.nativeSessionId) return;
    this.database.prepare(`
      INSERT INTO native_child_handles(
        execution_id, native_session_id, private_ref_json, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET
        native_session_id = excluded.native_session_id,
        private_ref_json = excluded.private_ref_json,
        updated_at = MAX(native_child_handles.updated_at, excluded.updated_at)
    `).run(
      child.executionId,
      child.nativeSessionId,
      JSON.stringify({ nativeSessionId: child.nativeSessionId }),
      now,
    );
  }

  private ensureNativeChildTurn(envelope: ProviderEventEnvelope) {
    if (envelope.scope.kind !== 'turn' || this.turn(envelope.scope.turnId)) return;
    const execution = this.execution(envelope.scope.executionId);
    if (!execution || execution.ownership !== 'native' ||
        execution.conversationId !== envelope.scope.conversationId) return;
    const conversation = this.conversation(execution.conversationId);
    if (!conversation) return;
    const content = envelope.event.type === 'user.message' ? envelope.event.content : [];
    this.createTurn({
      turnId: envelope.scope.turnId,
      conversationId: execution.conversationId,
      executionId: execution.executionId,
      clientMessageId: `native-child-message:${envelope.scope.turnId}`,
      commandId: `native-child-command:${envelope.scope.turnId}`,
      content,
      model: execution.model ?? conversation.model,
      ...(execution.effort ? { effort: execution.effort } : {}),
      state: 'running',
      now: envelope.observedAt,
    });
    this.database.prepare(`
      UPDATE executions SET transcript_available = 1, updated_at = MAX(updated_at, ?)
      WHERE execution_id = ?
    `).run(envelope.observedAt, execution.executionId);
  }

  private reduceCompactionEvent(
    conversationId: string,
    event: Extract<ProviderEventEnvelope['event'], { type: `context.compaction.${string}` }>,
    now: number,
    providerSubjectKey?: string,
  ) {
    const existing = this.compactionOperation(event.operationId);
    if (event.type === 'context.compaction.started') {
      if (!existing) {
        const generation = this.compactionGeneration(conversationId);
        this.database.prepare(`
          INSERT INTO compaction_operations(
            operation_id, command_id, conversation_id, trigger, state, generation,
            before_tokens, after_tokens, provider_subject_key, created_at, started_at, updated_at
          ) VALUES (?, NULL, ?, ?, 'running', ?, ?, NULL, ?, ?, ?, ?)
        `).run(
          event.operationId,
          conversationId,
          event.trigger,
          generation,
          event.beforeTokens,
          providerSubjectKey ?? null,
          now,
          now,
          now,
        );
      } else {
        this.database.prepare(`
          UPDATE compaction_operations
          SET state = 'running', before_tokens = COALESCE(before_tokens, ?),
            provider_subject_key = COALESCE(provider_subject_key, ?),
            started_at = COALESCE(started_at, ?), updated_at = MAX(updated_at, ?)
          WHERE operation_id = ? AND state IN ('queued', 'running')
        `).run(event.beforeTokens, providerSubjectKey ?? null, now, now, event.operationId);
      }
      return;
    }
    if (!existing) {
      const generation = this.compactionGeneration(conversationId);
      this.database.prepare(`
        INSERT INTO compaction_operations(
          operation_id, command_id, conversation_id, trigger, state, disposition,
          generation, before_tokens, after_tokens, error_json, created_at,
          completed_at, updated_at, provider_subject_key
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.operationId,
        conversationId,
        event.trigger,
        event.type === 'context.compaction.completed' ? 'completed' : 'failed',
        event.type === 'context.compaction.completed' ? 'dispatched' : null,
        generation,
        event.type === 'context.compaction.completed' ? event.beforeTokens : null,
        event.type === 'context.compaction.completed' ? event.afterTokens : null,
        event.type === 'context.compaction.failed' ? JSON.stringify(event.error) : null,
        now,
        now,
        now,
        providerSubjectKey ?? null,
      );
      return;
    }
    this.database.prepare(`
      UPDATE compaction_operations
      SET state = ?, disposition = ?, before_tokens = COALESCE(before_tokens, ?),
        after_tokens = ?, error_json = ?, completed_at = ?, updated_at = MAX(updated_at, ?),
        provider_subject_key = COALESCE(provider_subject_key, ?)
      WHERE operation_id = ?
    `).run(
      event.type === 'context.compaction.completed' ? 'completed' : 'failed',
      event.type === 'context.compaction.completed' ? 'dispatched' : null,
      event.type === 'context.compaction.completed' ? event.beforeTokens : null,
      event.type === 'context.compaction.completed' ? event.afterTokens : null,
      event.type === 'context.compaction.failed' ? JSON.stringify(event.error) : null,
      now,
      now,
      providerSubjectKey ?? null,
      event.operationId,
    );
  }

  private assertOpen() {
    if (this.closed) throw new Error('Native Agent journal is closed.');
  }

  private compactionBoundary(
    executionId: string,
    envelope: ProviderEventEnvelope,
  ): JournalCompactionBoundary {
    const nativeTurnId = envelope.native.turnId;
    if (!nativeTurnId) return { kind: 'between-turns' };
    if (envelope.native.kind.startsWith('control/')) {
      return {
        kind: 'between-turns',
        nativeTurnId,
        ...(envelope.native.timeline?.previousTurnId
          ? { previousNativeTurnId: envelope.native.timeline.previousTurnId }
          : {}),
        ...(envelope.native.timeline?.nextTurnId
          ? { nextNativeTurnId: envelope.native.timeline.nextTurnId }
          : {}),
      };
    }
    const binding = this.database.prepare(`
      SELECT turn_id FROM native_turn_bindings
      WHERE native_session_execution_id = ? AND native_turn_id = ?
      LIMIT 1
    `).get(executionId, nativeTurnId) as { turn_id: string } | undefined;
    return binding
      ? {
          kind: 'within-turn',
          turnId: binding.turn_id,
          nativeTurnId,
          ...(envelope.native.itemId ? { nativeItemId: envelope.native.itemId } : {}),
        }
      : { kind: 'native-unresolved', nativeTurnId };
  }

  private resolveCompactionBoundariesForNativeTurn(
    executionId: string,
    turnId: string,
    nativeTurnId: string,
  ) {
    const conversation = this.database.prepare(`
      SELECT conversation_id FROM turns WHERE turn_id = ? AND execution_id = ?
    `).get(turnId, executionId) as { conversation_id: string } | undefined;
    if (!conversation) return;
    const rows = this.database.prepare(`
      SELECT control_event_id, boundary_json, native_identity
      FROM conversation_control_events
      WHERE conversation_id = ? AND kind = 'compaction'
    `).all(conversation.conversation_id) as Array<{
      control_event_id: string;
      boundary_json: string;
      native_identity: string | null;
    }>;
    const update = this.database.prepare(`
      UPDATE conversation_control_events SET boundary_json = ?
      WHERE control_event_id = ?
    `);
    for (const row of rows) {
      const boundary = JSON.parse(row.boundary_json) as JournalCompactionBoundary;
      if ((boundary.kind !== 'native-unresolved' && boundary.kind !== 'native-unknown') ||
          boundary.nativeTurnId !== nativeTurnId) continue;
      update.run(JSON.stringify({
        kind: 'within-turn',
        turnId,
        nativeTurnId,
        ...(row.native_identity ? { nativeItemId: row.native_identity } : {}),
      }), row.control_event_id);
    }
  }

  private isRootExecution(conversationId: string, executionId: string) {
    const row = this.database.prepare(`
      SELECT 1 AS matched FROM conversations
      WHERE conversation_id = ? AND root_execution_id = ?
    `).get(conversationId, executionId) as { matched: number } | undefined;
    return row?.matched === 1;
  }

  private touchConversationFamily(rootConversationId: string, now: number) {
    this.database.prepare(`
      UPDATE conversations SET subtree_updated_at = MAX(subtree_updated_at, ?)
      WHERE root_conversation_id = ?
    `).run(now, rootConversationId);
  }
}

export async function openNativeAgentJournal(options: NativeAgentJournalOptions = {}) {
  const root = resolveNativeAgentDataRoot(options);
  const paths = await prepareAgentDataPaths({ dataRoot: root });
  const sqlite = await import('node:sqlite');
  const database = new sqlite.DatabaseSync(paths.database, { timeout: 5_000 });
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
    `);
    const version = pragma(database, 'user_version');
    const applicationId = pragma(database, 'application_id');
    const tables = listNativeAgentTables(database);
    if (version === 0 && applicationId === 0 && tables.length === 0) {
      database.exec('BEGIN IMMEDIATE');
      try {
        createNativeAgentSchema(database);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    } else if (version >= 1 && version < NATIVE_AGENT_SCHEMA_VERSION &&
        applicationId === NATIVE_AGENT_APPLICATION_ID) {
      const migratedAt = Date.now();
      const backupDirectory = join(root, 'backups');
      await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') await chmod(backupDirectory, 0o700);
      const backupPath = join(backupDirectory, `before-schema-v${NATIVE_AGENT_SCHEMA_VERSION}-${migratedAt}.sqlite3`);
      database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
      if (process.platform !== 'win32') await chmod(backupPath, 0o600);
      database.exec('BEGIN IMMEDIATE');
      try {
        migrateNativeAgentSchema(database, version, { backupPath, migratedAt });
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    } else if (version !== NATIVE_AGENT_SCHEMA_VERSION || applicationId !== NATIVE_AGENT_APPLICATION_ID) {
      throw new NativeAgentSchemaError(
        `Refusing to open ${paths.database}: it is not a ${NATIVE_AGENT_SCHEMA_VERSION} ` +
        'Native Agent database. Preserve or explicitly remove that path before retrying.',
      );
    }
    // Agent owns one synchronous SQLite connection. A rollback journal gives
    // that single writer the same durable commit boundary without WAL's
    // memory-mapped shared-index sidecar. Avoiding that native mmap also keeps
    // a provider-process crash or abrupt extension restart from surfacing as a
    // process-level SIGBUS in Node's SQLite binding.
    const journalMode = database.prepare('PRAGMA journal_mode = DELETE').get() as
      | { journal_mode: string }
      | undefined;
    if (journalMode?.journal_mode.toLowerCase() !== 'delete') {
      throw new Error('Native Agent database failed to enter rollback-journal mode.');
    }
    await secureDatabaseSidecars(paths.database);
    validateNativeAgentSchema(database);
    return new NativeAgentJournal(database, paths.database);
  } catch (error) {
    database.close();
    throw error;
  }
}

export function resolveNativeAgentDataRoot(options: NativeAgentJournalOptions = {}) {
  if (options.dataRoot) return resolve(options.dataRoot);
  const env = options.env ?? process.env;
  if (env.REMUX_AGENT_NATIVE_DATA_DIR) return resolve(env.REMUX_AGENT_NATIVE_DATA_DIR);
  const base = env.XDG_DATA_HOME
    ? resolve(env.XDG_DATA_HOME)
    : join(options.homeDirectory ?? homedir(), '.local', 'share');
  return join(base, 'remux', 'agent-native-v1');
}

export class CommandReceiptConflictError extends Error {
  constructor(commandId: string) {
    super(`Command ${commandId} was reused with different input.`);
    this.name = 'CommandReceiptConflictError';
  }
}

export class ConversationHeadConflictError extends Error {
  constructor(conversationId: string) {
    super(`Conversation ${conversationId} changed while the branch was being prepared.`);
    this.name = 'ConversationHeadConflictError';
  }
}

export class ConversationMetadataConflictError extends Error {
  constructor(conversationId: string) {
    super(`Conversation ${conversationId} metadata changed; refresh and retry.`);
    this.name = 'ConversationMetadataConflictError';
  }
}

function providerRow(row: Record<string, unknown>): JournalProviderInstance {
  return {
    providerInstanceId: String(row.provider_instance_id),
    provider: row.provider as ProviderKind,
    label: String(row.label),
    probe: JSON.parse(String(row.probe_json)) as ProviderProbe,
    capabilityRevision: String(row.capability_revision),
    updatedAt: Number(row.updated_at),
  };
}

function conversationRow(row: Record<string, unknown>): JournalConversation {
  return {
    conversationId: String(row.conversation_id),
    provider: row.provider as ProviderKind,
    providerInstanceId: String(row.provider_instance_id),
    title: String(row.title),
    preview: String(row.preview),
    cwd: String(row.cwd),
    model: String(row.model),
    ...(row.effort === null ? {} : { effort: String(row.effort) }),
    serviceTier: row.service_tier === null ? null : String(row.service_tier),
    access: row.access as JournalConversation['access'],
    state: row.state as JournalConversation['state'],
    rootExecutionId: String(row.root_execution_id),
    parentConversationId: row.parent_conversation_id === null
      ? null
      : String(row.parent_conversation_id),
    rootConversationId: String(row.root_conversation_id),
    forkedFromPathEntryId: row.forked_from_path_entry_id === null
      ? null
      : String(row.forked_from_path_entry_id),
    activeStrandId: String(row.active_strand_id),
    headRevision: Number(row.head_revision),
    versionCount: Number(row.version_count),
    childCount: Number(row.child_count),
    subtreeUpdatedAt: Number(row.subtree_updated_at),
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
    metadataRevision: Number(row.metadata_revision),
    ...(row.last_used_model === undefined
      ? {}
      : { lastUsedModel: row.last_used_model === null ? null : String(row.last_used_model) }),
    ...(row.last_activity_at === undefined ? {} : { lastActivityAt: Number(row.last_activity_at) }),
    activeTurnId: row.active_turn_id === null ? null : String(row.active_turn_id),
    latestTurnId: row.latest_turn_id === null ? null : String(row.latest_turn_id),
    history: {
      state: row.history_state as NativeConversationSummary['history']['state'],
      ...(row.history_error === null ? {} : { error: String(row.history_error) }),
      ...(row.history_synced_at === null
        ? {}
        : { lastSyncedAt: Number(row.history_synced_at) }),
      ...(row.native_history_revision === null
        ? {}
        : { nativeRevision: String(row.native_history_revision) }),
      ...(row.history_synced_revision === null
        ? {}
        : { syncedRevision: String(row.history_synced_revision) }),
    },
    resumable: row.resumable === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.health_message === null ? {} : { healthMessage: String(row.health_message) }),
  };
}

function conversationHeadRow(row: Record<string, unknown>): JournalConversationHead {
  return {
    conversationId: String(row.conversation_id),
    strandId: String(row.strand_id),
    revision: Number(row.revision),
    switchedAt: Number(row.switched_at),
  };
}

function conversationStrandRow(row: Record<string, unknown>): JournalConversationStrand {
  return {
    strandId: String(row.strand_id),
    conversationId: String(row.conversation_id),
    sourceStrandId: row.source_strand_id === null ? null : String(row.source_strand_id),
    sourcePathEntryId: row.source_path_entry_id === null ? null : String(row.source_path_entry_id),
    cutoffKind: row.cutoff_kind as JournalConversationStrand['cutoffKind'],
    reason: row.reason as JournalConversationStrand['reason'],
    rootExecutionId: String(row.root_execution_id),
    state: row.state as JournalConversationStrand['state'],
    createdAt: Number(row.created_at),
    readyAt: row.ready_at === null ? null : Number(row.ready_at),
  };
}

function strandPathRow(row: Record<string, unknown>): JournalStrandPathEntry {
  return {
    pathEntryId: String(row.path_entry_id),
    strandId: String(row.strand_id),
    ordinal: Number(row.ordinal),
    turnId: String(row.turn_id),
    sourcePathEntryId: row.source_path_entry_id === null ? null : String(row.source_path_entry_id),
    relation: row.relation as JournalStrandPathEntry['relation'],
    branchBindingId: row.branch_binding_id === null ? null : String(row.branch_binding_id),
  };
}

function nativeTurnBindingRow(row: Record<string, unknown>): JournalNativeTurnBinding {
  return {
    nativeBindingId: String(row.native_binding_id),
    providerInstanceId: String(row.provider_instance_id),
    nativeSessionExecutionId: String(row.native_session_execution_id),
    turnId: String(row.turn_id),
    nativeTurnId: row.native_turn_id === null ? null : String(row.native_turn_id),
    branchCursor: row.branch_cursor_json === null
      ? null
      : JSON.parse(String(row.branch_cursor_json)) as unknown,
    cursorVersion: row.cursor_version === null ? null : Number(row.cursor_version),
    bindingState: row.binding_state as JournalNativeTurnBinding['bindingState'],
    validatedAt: Number(row.validated_at),
  };
}

function turnRow(row: Record<string, unknown>): JournalTurn {
  return {
    ...(row.path_entry_id === undefined || row.path_entry_id === null
      ? {}
      : { pathEntryId: String(row.path_entry_id) }),
    ...(row.path_strand_id === undefined || row.path_strand_id === null
      ? row.origin_strand_id === undefined || row.origin_strand_id === null
        ? {}
        : { strandId: String(row.origin_strand_id) }
      : { strandId: String(row.path_strand_id) }),
    ...(row.ordinal === undefined || row.ordinal === null ? {} : { ordinal: Number(row.ordinal) }),
    turnId: String(row.turn_id),
    conversationId: String(row.conversation_id),
    executionId: String(row.execution_id),
    clientMessageId: String(row.client_message_id),
    commandId: String(row.command_id),
    userContent: JSON.parse(String(row.user_content_json)) as UserContentPart[],
    model: String(row.model),
    ...(row.effort === null ? {} : { effort: String(row.effort) }),
    ...(row.service_tier === null ? {} : { serviceTier: String(row.service_tier) }),
    ...(row.native_turn_id === null ? {} : { nativeTurnId: String(row.native_turn_id) }),
    ...(row.assistant_artifact_id === null
      ? {}
      : { assistantArtifactId: String(row.assistant_artifact_id) }),
    ordering: (row.ordering ?? 'legacy-grouped') as JournalTurn['ordering'],
    state: row.state as JournalTurn['state'],
    ...(row.outcome === null ? {} : { outcome: row.outcome as ProviderTurnOutcome }),
    ...(row.error_json === null
      ? {}
      : { error: JSON.parse(String(row.error_json)) as JournalTurn['error'] }),
    createdAt: Number(row.created_at),
    ...(row.started_at === null ? {} : { startedAt: Number(row.started_at) }),
    ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
    updatedAt: Number(row.updated_at),
  };
}

function executionRow(row: Record<string, unknown>): JournalExecution {
  return {
    executionId: String(row.execution_id),
    conversationId: String(row.conversation_id),
    ...(row.strand_id === null || row.strand_id === undefined
      ? {}
      : { strandId: String(row.strand_id) }),
    parentExecutionId: row.parent_execution_id === null ? null : String(row.parent_execution_id),
    rootTurnId: row.root_turn_id === null ? null : String(row.root_turn_id),
    ownership: row.ownership as JournalExecution['ownership'],
    provider: row.provider as ProviderKind,
    providerInstanceId: String(row.provider_instance_id),
    ...(row.model === null ? {} : { model: String(row.model) }),
    ...(row.effort === null ? {} : { effort: String(row.effort) }),
    ...(row.service_tier === null ? {} : { serviceTier: String(row.service_tier) }),
    ...(row.checkout_key === null || row.checkout_key === undefined
      ? {}
      : { checkoutKey: String(row.checkout_key) }),
    ...(row.access === null
      ? {}
      : { access: row.access as NonNullable<JournalExecution['access']> }),
    ...(row.federation_scheduling === null
      ? {}
      : { federationScheduling: row.federation_scheduling as 'background' | 'foreground' }),
    federationDepth: Number(row.federation_depth),
    ...(row.title === null ? {} : { title: String(row.title) }),
    state: row.state as JournalExecution['state'],
    ...(row.outcome === null ? {} : { outcome: row.outcome as ProviderTurnOutcome }),
    ...(row.summary === null ? {} : { summary: String(row.summary) }),
    ...(row.lifecycle_error === null || row.lifecycle_error === undefined
      ? {} : { lifecycleError: String(row.lifecycle_error) }),
    transcriptAvailable: row.transcript_available === 1,
    createdAt: Number(row.created_at),
    ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
    updatedAt: Number(row.updated_at),
  };
}

function queueRow(row: Record<string, unknown>): NativeQueuedMessage {
  return {
    kind: 'message',
    commandId: String(row.command_id),
    conversationId: String(row.conversation_id),
    turnId: String(row.turn_id),
    clientMessageId: String(row.client_message_id),
    content: JSON.parse(String(row.content_json)) as UserContentPart[],
    model: String(row.model),
    ...(row.effort === null ? {} : { effort: String(row.effort) }),
    serviceTier: row.service_tier === null ? null : String(row.service_tier),
    access: row.access as NativeQueuedMessage['access'],
    state: row.state === 'delivery_unknown'
      ? 'delivery-unknown'
      : row.state as NativeQueuedMessage['state'],
    createdAt: Number(row.created_at),
  } as NativeQueuedMessage & { conversationId: string };
}

function composerPreferenceRow(row: Record<string, unknown>): JournalComposerPreference {
  return {
    scope: row.scope as JournalComposerPreference['scope'],
    scopeId: String(row.scope_id),
    providerInstanceId: String(row.provider_instance_id),
    model: row.model === null ? null : String(row.model),
    effort: row.effort === null ? null : String(row.effort),
    serviceTier: row.service_tier === null ? null : String(row.service_tier),
    revision: Number(row.revision),
    updatedAt: Number(row.updated_at),
  };
}

function compactionOperationRow(row: Record<string, unknown>): JournalCompactionOperation {
  return {
    operationId: String(row.operation_id),
    ...(row.command_id === null ? {} : { commandId: String(row.command_id) }),
    conversationId: String(row.conversation_id),
    trigger: row.trigger as JournalCompactionOperation['trigger'],
    state: row.state as JournalCompactionOperation['state'],
    ...(row.disposition === null
      ? {}
      : { disposition: row.disposition as NonNullable<JournalCompactionOperation['disposition']> }),
    generation: Number(row.generation),
    beforeTokens: row.before_tokens === null ? null : Number(row.before_tokens),
    afterTokens: row.after_tokens === null ? null : Number(row.after_tokens),
    ...(row.native_operation_id === null ? {} : { nativeOperationId: String(row.native_operation_id) }),
    ...(row.provider_subject_key === null
      ? {}
      : { providerSubjectKey: String(row.provider_subject_key) }),
    ...(row.error_json === null
      ? {}
      : { error: JSON.parse(String(row.error_json)) as NonNullable<JournalCompactionOperation['error']> }),
    createdAt: Number(row.created_at),
    ...(row.started_at === null ? {} : { startedAt: Number(row.started_at) }),
    ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
    updatedAt: Number(row.updated_at),
  };
}

function legacyEventRow(row: Record<string, unknown>): LegacyJournalEvent {
  const envelope = JSON.parse(String(row.envelope_json)) as Record<string, unknown>;
  return {
    sequence: Number(row.sequence),
    eventId: String(row.event_id),
    conversationId: String(row.conversation_id),
    executionId: String(row.execution_id),
    ...(row.turn_id === null ? {} : { turnId: String(row.turn_id) }),
    nativeKind: String(row.native_kind),
    observedAt: Number(row.observed_at),
    event: envelope.event && typeof envelope.event === 'object' && !Array.isArray(envelope.event)
      ? envelope.event as Record<string, unknown>
      : { type: 'compatibility.notice', code: 'legacy_event_invalid', message: 'Legacy event was invalid.' },
  };
}

function receiptRow(row: Record<string, unknown>): CommandReceipt {
  return {
    commandId: String(row.command_id),
    kind: String(row.kind),
    requestHash: String(row.request_hash),
    state: row.state as CommandReceipt['state'],
    ...(row.result_json === null ? {} : { result: JSON.parse(String(row.result_json)) }),
    ...(row.error_message === null ? {} : { errorMessage: String(row.error_message) }),
  };
}

function artifactRow(row: Record<string, unknown>): JournalArtifact {
  return {
    artifactId: String(row.artifact_id),
    sha256: String(row.sha256),
    byteLength: Number(row.byte_length),
    mediaType: String(row.media_type),
    visibility: row.visibility as JournalArtifact['visibility'],
    storagePath: String(row.storage_path),
    createdAt: Number(row.created_at),
  };
}

type TurnBlockLifecycleEvent = Extract<
  ProviderEventEnvelope['event'],
  { type: 'turn.block.started' | 'turn.block.revised' | 'turn.block.completed' }
>;

type TurnScopedBlockEnvelope = ProviderEventEnvelope & {
  scope: Extract<ProviderEventEnvelope['scope'], { kind: 'turn' }>;
  event: TurnBlockLifecycleEvent;
};

type SequencedBlockEnvelope = {
  sequence: number;
  envelope: TurnScopedBlockEnvelope;
};

type BlockLifecycleGroup = {
  firstSequence: number;
  latest: TurnScopedBlockEnvelope;
  lifecycles: SequencedBlockEnvelope[];
};

function isTurnBlockLifecycleEvent(
  event: ProviderEventEnvelope['event'],
): event is TurnBlockLifecycleEvent {
  return event.type === 'turn.block.started' ||
    event.type === 'turn.block.revised' ||
    event.type === 'turn.block.completed';
}

function isTurnScopedBlockEnvelope(
  envelope: ProviderEventEnvelope,
): envelope is TurnScopedBlockEnvelope {
  return envelope.scope.kind === 'turn' && isTurnBlockLifecycleEvent(envelope.event);
}

function groupBlockLifecycles(
  rows: readonly SequencedBlockEnvelope[],
): Map<string, BlockLifecycleGroup> {
  const groups = new Map<string, BlockLifecycleGroup>();
  for (const row of rows) {
    const blockId = row.envelope.event.structure.blockId;
    const existing = groups.get(blockId);
    if (!existing) {
      groups.set(blockId, {
        firstSequence: row.sequence,
        latest: row.envelope,
        lifecycles: [row],
      });
      continue;
    }
    if (!existing.lifecycles.some(({ envelope }) => envelope.eventId === row.envelope.eventId)) {
      existing.lifecycles.push(row);
      existing.lifecycles.sort((left, right) => left.sequence - right.sequence);
    }
    existing.firstSequence = Math.min(existing.firstSequence, row.sequence);
    const latestRevision = blockEventRevision(existing.latest.event);
    const candidateRevision = blockEventRevision(row.envelope.event);
    if (candidateRevision > latestRevision ||
        (candidateRevision === latestRevision && row.sequence >=
          existing.lifecycles.at(-1)!.sequence)) {
      existing.latest = row.envelope;
    }
  }
  return groups;
}

function blockEventRevision(event: TurnBlockLifecycleEvent) {
  return event.type === 'turn.block.started' ? 0 : event.revision;
}

function snapshotBlockOrder(left: BlockLifecycleGroup, right: BlockLifecycleGroup) {
  const leftPosition = left.latest.native.position;
  const rightPosition = right.latest.native.position;
  const leftIndex = leftPosition?.kind === 'snapshot-index'
    ? leftPosition.itemIndex
    : left.latest.event.structure.blockOrdinal;
  const rightIndex = rightPosition?.kind === 'snapshot-index'
    ? rightPosition.itemIndex
    : right.latest.event.structure.blockOrdinal;
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  if (left.latest.event.structure.blockOrdinal !== right.latest.event.structure.blockOrdinal) {
    return left.latest.event.structure.blockOrdinal - right.latest.event.structure.blockOrdinal;
  }
  return left.firstSequence - right.firstSequence;
}

function isCompactionMarker(event: TurnBlockLifecycleEvent) {
  return event.block.payload.kind === 'compatibility-notice' &&
    event.block.payload.code === 'context-compaction';
}

function isContextCompactionEvent(
  event: ProviderEventEnvelope['event'],
): event is Extract<ProviderEventEnvelope['event'], { type: `context.compaction.${string}` }> {
  return event.type === 'context.compaction.started' ||
    event.type === 'context.compaction.completed' ||
    event.type === 'context.compaction.failed';
}

function isRetainableAction(event: TurnBlockLifecycleEvent) {
  return event.block.kind === 'tool' || event.block.kind === 'web' ||
    event.block.kind === 'native-child' || event.block.kind === 'federated-child';
}

function blockFingerprint(event: TurnBlockLifecycleEvent) {
  const payload = event.block.payload;
  if (payload.kind === 'tool') {
    const { callId: _callId, ...tool } = payload.tool;
    return hashJson({
      kind: payload.kind,
      tool,
      ...(payload.inputPreview === undefined ? {} : { inputPreview: payload.inputPreview }),
      ...(payload.outputPreview === undefined ? {} : { outputPreview: payload.outputPreview }),
      ...(payload.detailRef === undefined ? {} : { detailRef: payload.detailRef }),
    });
  }
  return hashJson({ kind: payload.kind, payload });
}

function mergeSnapshotAndRetainedBlocksByOrdinal(
  snapshotBlocks: readonly BlockLifecycleGroup[],
  retainedBlocks: readonly BlockLifecycleGroup[],
) {
  const output: TurnScopedBlockEnvelope[] = [];
  const blocksByPass = new Map<string, BlockLifecycleGroup[]>();
  for (const block of [...snapshotBlocks, ...retainedBlocks]) {
    const passId = block.latest.event.structure.passId;
    const blocks = blocksByPass.get(passId) ?? [];
    blocks.push(block);
    blocksByPass.set(passId, blocks);
  }
  for (const [passId, blocks] of blocksByPass) {
    blocks.sort(snapshotBlockOrder);
    const passOrdinal = blocks[0]!.latest.event.structure.passOrdinal;
    blocks.forEach((block, blockOrdinal) => {
      for (const { envelope } of block.lifecycles) {
        output.push(withBlockStructure(envelope, passId, passOrdinal, blockOrdinal));
      }
    });
  }
  return output;
}

function withBlockStructure(
  envelope: TurnScopedBlockEnvelope,
  passId: string,
  passOrdinal: number,
  blockOrdinal: number,
): TurnScopedBlockEnvelope {
  return {
    ...envelope,
    event: {
      ...envelope.event,
      structure: {
        ...envelope.event.structure,
        passId,
        passOrdinal,
        blockOrdinal,
      },
    },
  };
}

function previewText(content: readonly UserContentPart[]) {
  const text = content.flatMap((part) => part.type === 'text' ? [part.text] : []).join(' ').trim();
  return text.slice(0, 240) || '[Attachment]';
}

function hashJson(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Command input must contain finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new TypeError('Command input must be JSON serializable.');
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

function pragma(database: DatabaseSync, name: string) {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Number(Object.values(row)[0]);
}

export function viewerCapabilities(capabilities: ProviderCapabilities) {
  return {
    provider: capabilities.provider,
    providerVersion: capabilities.providerVersion,
    adapterVersion: capabilities.adapterVersion,
    authentication: capabilities.authentication,
    session: capabilities.session,
    // Queueing is implemented by the Agent command lane. The provider field
    // describes only whether the adapter also has a native queue primitive;
    // viewers must see the runtime capability.
    turns: { ...capabilities.turns, queue: true },
    content: capabilities.content,
    collaboration: capabilities.collaboration,
    access: capabilities.access,
    usage: capabilities.usage,
    compaction: capabilities.compaction,
  };
}
