import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';

import type { AssistantMessage } from '@earendil-works/pi-ai';

import {
  conversationResourceKey,
  queueResourceKey,
  type AgentComposerMessagePart,
  type AgentPendingQueueValue,
  type AgentResourceKey,
  type ConversationListValue,
  type ConversationSummary,
  type ContextInspectorValue,
  type MessageSendParams,
  type ReasoningLevel,
} from '../../../shared/protocol.ts';
import {
  DEFAULT_TRANSCRIPT_TAIL_TURNS,
  MAX_TRANSCRIPT_WINDOW_TURNS,
  MAX_VISIBLE_TEXT_BYTES,
  type AgentTextContentReference,
  type AgentUserMessagePart,
  type AgentTranscriptResourcesReadParams,
} from '../../../shared/transcript.ts';
import {
  canonicalProviderJson,
  createDurableContextSnapshot,
  logicalMessageSemanticValue,
  reduceLogicalReplay,
  type DurableContextSnapshot,
  type LogicalContextMessage,
  type LogicalReplayEvent,
} from '../logical-context.ts';
import {
  compileThreadContext,
  type ThreadContextSource,
} from '../context/compiler.ts';
import type {
  JournalOpenInput,
  JournalOpenResult,
  JournalSearchInput,
  JournalSearchResult,
  ThreadDocumentView,
  ThreadUpdateInput,
  WorkUnitEnterInput,
} from '../engine.ts';
import {
  PROMPT_MANIFEST_VERSION,
  promptManifestValue,
  type PromptManifest,
  type ThreadContextFrameCandidate,
} from '../context/manifest.ts';
import {
  CONVERSATION_PREVIEW_CODE_POINTS,
  CONVERSATION_TITLE_CODE_POINTS,
  normalizeConversationText,
  renderConversationList,
  renderConversationSummary,
  type ConversationSummaryMessage,
} from '../conversation-summary.ts';
import { canonicalJson, canonicalJsonHash, type CanonicalJsonValue } from './canonical-json.ts';
import {
  openAgentDatabase,
  type AgentDatabase,
  type AgentDatabaseDiagnostics,
} from './database.ts';
import type { AgentDataRootOptions } from './data-root.ts';
import { AgentArtifactStore, type StagedArtifact } from './artifact-store.ts';
import { durableProjectionDigest } from './projection-hash.ts';
import { agentComposerPartsHashValue, decodeAgentImageDataUrl } from '../user-input.ts';

const CREATE_CONVERSATION_KIND = 'conversation.create';
const SEND_MESSAGE_KIND = 'message.send';
const INITIAL_TITLE = 'New conversation';
const EVENT_PAYLOAD_LIMIT_BYTES = 32 * 1024;
const INLINE_CONTENT_LIMIT_BYTES = 16 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type IdKind =
  | 'project'
  | 'conversation'
  | 'strand'
  | 'turn'
  | 'scope'
  | 'event'
  | 'operation'
  | 'item'
  | 'message'
  | 'inference'
  | 'frame'
  | 'provider-item'
  | 'document'
  | 'document-version';

export type AgentJournalRepositoryOptions = AgentDataRootOptions & {
  now?: () => number;
  idFactory?: (kind: IdKind) => string;
};

export type CreateConversationParams = {
  operationId: string;
  cwd: string;
  modelId: string;
  reasoning: ReasoningLevel;
  inheritThreadFrom?: {
    conversationId: string;
    turnId: string;
    position: 'before' | 'after';
  };
};

export type CreateConversationResult = {
  accepted: true;
  operationId: string;
  projectId: string;
  conversationId: string;
  rootStrandId: string;
  threadDocumentId: string;
  threadVersionId: string;
  basisSequence: number;
  replayed: boolean;
};

export type DurableContentRef =
  | { kind: 'inline'; text: string; byteLength: number; sha256: string }
  | {
      kind: 'artifact';
      hash: string;
      byteLength: number;
      mediaType: string;
      storagePath: string;
    };

export type DurableTurnHandle = {
  projectId: string;
  conversationId: string;
  strandId: string;
  turnId: string;
  scopeId: string;
};

export type AcceptTurnParams = {
  operationId: string;
  conversationId: string;
  clientMessageId: string;
  parts?: AgentComposerMessagePart[];
  text: string;
};

export type AcceptTurnResult = DurableTurnHandle & {
  accepted: true;
  operationId: string;
  clientMessageId: string;
  basisSequence: number;
  transcriptSequence: number;
  transcriptCreatedAt: number;
  userItemId: string;
  userContent?: AgentTextContentReference;
  userParts?: AgentUserMessagePart[];
  replayed: boolean;
};

export type DurableTranscriptMutation = {
  basisSequence: number;
  createdAt: number;
  itemId: string | null;
  detailText?: string;
  detailContent?: AgentTextContentReference;
  outputText?: string;
  outputContent?: AgentTextContentReference;
};

export type DurableTurnStatus = 'completed' | 'failed' | 'interrupted' | 'interrupted_by_restart';
export type DurableTurnErrorCode = 'provider_error' | 'runtime_error' | 'storage_error';

export type DurableTranscriptAction =
  | {
      type: 'turn';
      turnId: string;
      clientMessageId: string;
      text: string;
      parts?: AgentUserMessagePart[];
      content?: AgentTextContentReference;
    }
  | {
      type: 'assistant';
      turnId: string;
      textDelta: string;
      reasoningDelta: string;
      textContent?: AgentTextContentReference;
      reasoningContent?: AgentTextContentReference;
    }
  | {
      type: 'tool-start';
      turnId: string;
      callId: string;
      name: string;
      args: unknown;
      detailText?: string;
      detailContent?: AgentTextContentReference;
    }
  | {
      type: 'tool-end';
      turnId: string;
      callId: string;
      result: unknown;
      isError: boolean;
      outputText?: string;
      outputContent?: AgentTextContentReference;
    }
  | {
      type: 'terminal';
      turnId: string;
      status: DurableTurnStatus;
      error: string | null;
      errorCode?: DurableTurnErrorCode | null;
      durationMs?: number;
    };

export type DurableTranscriptProjectionAction = DurableTranscriptAction & {
  sequence: number;
  createdAt: number;
  itemId: string | null;
};

export type DurableTranscriptProjection = {
  basisSequence: number;
  actions: DurableTranscriptProjectionAction[];
};

export type DurableTranscriptWindow = {
  requestIndex: number;
  startIndex: number;
  endIndexExclusive: number;
  hasEarlier: boolean;
  hasLater: boolean;
  turnIds: string[];
};

export type DurableTranscriptWindowProjection = DurableTranscriptProjection & {
  selectedTurnIds: string[];
  windows: DurableTranscriptWindow[];
  estimatedBytes: number;
};

export type AgentJournalEvent = {
  sequence: number;
  eventId: string;
  projectId: string;
  conversationId: string;
  strandId: string;
  turnId: string | null;
  scopeId: string | null;
  type: string;
  actor: string;
  visibility: string;
  causalEventId: string | null;
  operationId: string | null;
  payload: CanonicalJsonValue | null;
  artifactHash: string | null;
  createdAt: number;
};

export type DurableResourceProjection = {
  key: 'conversation-list' | `conversation:${string}` | `context:${string}` | `queue:${string}`;
  basisSequence: number;
  value: ConversationListValue | ConversationSummary | ContextInspectorValue | AgentPendingQueueValue;
};

export type DurableQueuedTurn = MessageSendParams & {
  queueOperationId: string;
};

export type QueueTurnResult = {
  accepted: true;
  delivery: 'queued' | 'sent';
  operationId: string;
  replayed: boolean;
  turnId: string | null;
};

export type DurableArtifact = {
  hash: string;
  byteLength: number;
  mediaType: string;
  offset: number;
  bytes: Buffer;
};

export type ArtifactScrubReport = {
  orphanStoragePaths: string[];
  referencedArtifacts: number;
  verifiedBytes: number;
};

export type DurableContextBoundarySnapshot = DurableContextSnapshot & {
  frame: ThreadContextFrameCandidate;
  scopeId: string;
  scopeKind: 'turn' | 'work_unit';
  nextFrameOrdinal: number;
};

export type DurableInferenceContext = {
  basisSequence: number;
  logicalHash: string;
  renderedHash: string;
  orderedMessageHashes: readonly string[];
  messageCount: number;
  fixedContractsHash: string;
  frame: ThreadContextFrameCandidate;
  frameBuildDurationMs: number;
  activeMessages: readonly LogicalContextMessage[];
};

type StoredCreateOutcome = {
  accepted: true;
  operationId: string;
  projectId: string;
  conversationId: string;
  threadDocumentId: string;
  threadVersionId: string;
};

type OperationReplayRow = {
  kind: string;
  arguments_hash: string;
  state: string;
  terminal_sequence: number | null;
  value_json: string;
  project_id: string;
  conversation_id: string;
  strand_id: string;
  thread_document_id: string;
  thread_version_id: string;
};

type ProjectRow = {
  project_id: string;
};

export class AgentJournalRepository {
  readonly databasePath: string;
  private readonly storage: AgentDatabase;
  private readonly now: () => number;
  private readonly idFactory: (kind: IdKind) => string;
  private readonly artifacts: AgentArtifactStore;
  private orphanArtifactPaths: string[] = [];
  private writerTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;

  private constructor(storage: AgentDatabase, options: AgentJournalRepositoryOptions) {
    this.storage = storage;
    this.databasePath = storage.paths.database;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.artifacts = new AgentArtifactStore(storage.paths);
  }

  static async open(options: AgentJournalRepositoryOptions = {}) {
    const storage = await openAgentDatabase(options);
    const repository = new AgentJournalRepository(storage, options);
    try {
      await repository.validateArtifactMetadata();
      repository.orphanArtifactPaths = await repository.findArtifactOrphans();
      await repository.recoverInterruptedTurns();
      await repository.upgradeLegacyAssistantProjections();
      await repository.rebuildJournalSearchIndex();
      await repository.rebuildConversationResources();
      return repository;
    } catch (error) {
      storage.close();
      throw error;
    }
  }

  diagnostics(): AgentDatabaseDiagnostics {
    this.assertOpen();
    return this.storage.diagnostics();
  }

  artifactDiagnostics() {
    this.assertOpen();
    return { orphanStoragePaths: [...this.orphanArtifactPaths] };
  }

  async scrubArtifacts(): Promise<ArtifactScrubReport> {
    this.assertOpen();
    await this.writerTail;
    const rows = this.artifactRows();
    let verifiedBytes = 0;
    for (const row of rows) {
      verifiedBytes += await this.artifacts.verify({
        hash: row.hash,
        byteLength: row.byte_length,
        storagePath: row.storage_path,
      }, true);
    }
    const orphanStoragePaths = await this.findArtifactOrphans();
    this.orphanArtifactPaths = orphanStoragePaths;
    return {
      orphanStoragePaths: [...orphanStoragePaths],
      referencedArtifacts: rows.length,
      verifiedBytes,
    };
  }

  async projectionDigest() {
    this.assertOpen();
    await this.writerTail;
    return durableProjectionDigest(this.storage.database);
  }

  async createConversation(params: CreateConversationParams) {
    this.assertOpen();
    const normalized = validateCreateConversationParams(params);
    const argumentsHash = canonicalJsonHash({
      kind: CREATE_CONVERSATION_KIND,
      params: {
        cwd: normalized.cwd,
        modelId: normalized.modelId,
        reasoning: normalized.reasoning,
        ...(normalized.inheritThreadFrom ? { inheritThreadFrom: normalized.inheritThreadFrom } : {}),
      },
    });
    const inheritedThread = normalized.inheritThreadFrom
      ? await this.readInheritedThread(normalized.inheritThreadFrom)
      : null;
    const initialThreadContent = inheritedThread?.content ?? '# Thread\n';
    const initialThread = await this.artifacts.put(
      Buffer.from(initialThreadContent, 'utf8'),
      'text/markdown; charset=utf-8',
    );
    return this.enqueueWrite(() => this.createConversationTransaction(
      normalized,
      argumentsHash,
      initialThread,
      initialThreadContent,
      inheritedThread?.versionId ?? null,
    ));
  }

  async acceptTurn(params: AcceptTurnParams): Promise<AcceptTurnResult> {
    this.assertOpen();
    const normalized = validateAcceptTurnParams(params);
    const input = await this.prepareUserInput(normalized);
    const argumentsHash = messageArgumentsHash(normalized);
    return this.enqueueWrite(() => this.acceptTurnTransaction(normalized, input, argumentsHash));
  }

  async reconcileTurn(params: AcceptTurnParams): Promise<AcceptTurnResult | null> {
    this.assertOpen();
    const normalized = validateAcceptTurnParams(params);
    const argumentsHash = messageArgumentsHash(normalized);
    await this.writerTail;
    return this.readTurnReplay(normalized, argumentsHash);
  }

  async reconcileQueuedTurn(params: AcceptTurnParams): Promise<QueueTurnResult | null> {
    this.assertOpen();
    const normalized = validateAcceptTurnParams(params);
    const argumentsHash = queuedMessageArgumentsHash(normalized);
    await this.writerTail;
    return this.readQueuedReplay(normalized, argumentsHash);
  }

  async enqueueTurn(params: AcceptTurnParams): Promise<QueueTurnResult> {
    this.assertOpen();
    const normalized = validateAcceptTurnParams(params);
    const argumentsHash = queuedMessageArgumentsHash(normalized);
    await this.writerTail;
    const replay = this.readQueuedReplay(normalized, argumentsHash);
    if (replay) return replay;
    const input = await this.prepareUserInput(normalized);
    return this.enqueueWrite(() => this.enqueueTurnTransaction(normalized, input, argumentsHash));
  }

  async readQueuedTurn(conversationId: string, operationId?: string): Promise<DurableQueuedTurn | null> {
    this.assertOpen();
    await this.writerTail;
    const condition = operationId ? 'AND o.operation_id = ?' : '';
    const parameters = operationId ? [conversationId, operationId] : [conversationId];
    const row = this.storage.database.prepare(`
      SELECT o.operation_id, o.value_json
      FROM operations o
      WHERE o.conversation_id = ? AND o.kind = 'message.queue' AND o.state = 'queued'
      ${condition}
      ORDER BY o.accepted_sequence, o.operation_id
      LIMIT 1
    `).get(...parameters) as { operation_id: string; value_json: string } | undefined;
    if (!row) return null;
    const value = parseQueuedOperationValue(row.value_json);
    const parts = await this.rehydrateStoredUserParts(value.parts);
    return {
      operationId: value.dispatchOperationId,
      queueOperationId: row.operation_id,
      conversationId,
      clientMessageId: value.clientMessageId,
      text: await this.readTextRef(value.content),
      ...(parts ? { parts } : {}),
    };
  }

  async readOldestQueuedConversationId(): Promise<string | null> {
    this.assertOpen();
    await this.writerTail;
    const row = this.storage.database.prepare(`
      SELECT conversation_id
      FROM operations
      WHERE kind = 'message.queue' AND state = 'queued' AND conversation_id IS NOT NULL
      ORDER BY accepted_sequence, operation_id
      LIMIT 1
    `).get() as { conversation_id: string } | undefined;
    return row?.conversation_id ?? null;
  }

  finishQueuedTurn(operationId: string, turnId: string) {
    this.assertOpen();
    return this.enqueueWrite(() => this.finishQueuedTurnTransaction(operationId, turnId));
  }

  removeQueuedTurn(conversationId: string, operationId: string) {
    this.assertOpen();
    return this.enqueueWrite(() => this.removeQueuedTurnTransaction(conversationId, operationId));
  }

  async appendAssistantCheckpoint(
    handle: DurableTurnHandle,
    checkpoint: { textDelta: string; reasoningDelta: string },
  ) {
    this.assertOpen();
    if (!checkpoint.textDelta && !checkpoint.reasoningDelta) return Promise.resolve(null);
    let payload: CanonicalJsonValue = checkpoint;
    let textArtifact: PreparedReference | null = null;
    let reasoningArtifact: PreparedReference | null = null;
    if (Buffer.byteLength(canonicalJson(checkpoint), 'utf8') > EVENT_PAYLOAD_LIMIT_BYTES) {
      [textArtifact, reasoningArtifact] = await Promise.all([
        this.prepareText(checkpoint.textDelta, true),
        this.prepareText(checkpoint.reasoningDelta, true),
      ]);
      payload = {
        reasoning: reasoningArtifact.ref,
        text: textArtifact.ref,
      };
    }
    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const scope = this.scopeIdentity(handle.scopeId);
      const recordedAt = safeTimestamp(this.now());
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'assistant.checkpoint',
        actor: 'model',
        visibility: scope.kind === 'turn' ? 'transcript' : 'internal',
        payload,
        artifactHash: textArtifact?.artifact?.hash ?? reasoningArtifact?.artifact?.hash ?? null,
        createdAt: recordedAt,
      });
      this.insertArtifact(textArtifact?.artifact ?? null, sequence);
      this.insertArtifact(reasoningArtifact?.artifact ?? null, sequence);
      if (scope.kind === 'work_unit') return null;
      const existing = this.storage.database.prepare(`
        SELECT item_id, value_json
        FROM transcript_items
        WHERE turn_id = ? AND kind = 'assistant'
      `).get(handle.turnId) as {
        item_id: string;
        value_json: string;
      } | undefined;
      const prior = existing
        ? assistantAccumulator(JSON.parse(existing.value_json) as Record<string, unknown>)
        : {
            reasoningByteLength: 0,
            summaryPendingSpace: false,
            summaryText: '',
            textByteLength: 0,
          };
      const summary = appendAssistantSummary(prior, checkpoint.textDelta);
      const value = canonicalJson({
        reasoningByteLength:
          prior.reasoningByteLength + Buffer.byteLength(checkpoint.reasoningDelta, 'utf8'),
        summaryPendingSpace: summary.pendingSpace,
        summaryText: summary.text,
        textByteLength: prior.textByteLength + Buffer.byteLength(checkpoint.textDelta, 'utf8'),
        version: 2,
      });
      let itemId: string;
      if (existing) {
        itemId = existing.item_id;
        this.storage.database.prepare(`
          UPDATE transcript_items
          SET last_sequence = ?, value_json = ?
          WHERE item_id = ?
        `).run(sequence, value, existing.item_id);
      } else {
        itemId = this.nextId('item');
        this.storage.database.prepare(`
          INSERT INTO transcript_items (
            item_id, conversation_id, strand_id, turn_id, first_sequence,
            last_sequence, kind, status, value_json
          ) VALUES (?, ?, ?, ?, ?, ?, 'assistant', 'running', ?)
        `).run(
          itemId,
          handle.conversationId,
          handle.strandId,
          handle.turnId,
          sequence,
          sequence,
          value,
        );
      }
      this.storage.database.prepare(`
        UPDATE conversations SET updated_at = ? WHERE conversation_id = ?
      `).run(recordedAt, handle.conversationId);
      this.refreshConversationResources(handle.conversationId, sequence, {
        role: 'assistant',
        text: summary.text,
        sequence,
        turnId: handle.turnId,
      });
      return {
        basisSequence: sequence,
        createdAt: recordedAt,
        itemId,
      } satisfies DurableTranscriptMutation;
    }));
  }

  async recordToolStarted(
    handle: DurableTurnHandle,
    input: { callId: string; name: string; args: unknown },
  ) {
    this.assertOpen();
    const args = await this.prepareJson(input.args);
    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const scope = this.scopeIdentity(handle.scopeId);
      const duplicateEvent = this.storage.database.prepare(`
        SELECT 1 FROM events
        WHERE scope_id = ? AND type = 'tool.called'
          AND json_extract(payload_json, '$.callId') = ?
      `).get(handle.scopeId, input.callId);
      if (duplicateEvent) return null;
      const duplicate = scope.kind === 'turn' ? this.findToolItem(handle.turnId, input.callId) : null;
      if (duplicate) return null;
      const recordedAt = safeTimestamp(this.now());
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'tool.called',
        actor: 'model',
        visibility: scope.kind === 'turn' ? 'transcript' : 'internal',
        payload: { args: args.ref, callId: input.callId, name: input.name },
        artifactHash: artifactHash(args.ref),
        createdAt: recordedAt,
      });
      this.insertArtifact(args.artifact, sequence);
      this.indexJournalText({
        ref: `journal://tool/${encodeURIComponent(input.callId)}`,
        projectId: handle.projectId,
        conversationId: handle.conversationId,
        strandId: handle.strandId,
        turnId: handle.turnId,
        kind: `operation:${input.name}`,
        sequence,
        text: `${input.name}\n${args.text}`,
      });
      if (scope.kind === 'work_unit') return null;
      const itemId = this.nextId('item');
      this.storage.database.prepare(`
        INSERT INTO transcript_items (
          item_id, conversation_id, strand_id, turn_id, first_sequence,
          last_sequence, kind, status, value_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'tool', 'running', ?)
      `).run(
        itemId,
        handle.conversationId,
        handle.strandId,
        handle.turnId,
        sequence,
        sequence,
        canonicalJson({ args: args.ref, callId: input.callId, name: input.name, result: null }),
      );
      const projected = preparedTextProjection(args, MAX_VISIBLE_TEXT_BYTES / 2);
      return {
        basisSequence: sequence,
        createdAt: recordedAt,
        itemId,
        detailText: projected.text,
        ...(projected.content ? { detailContent: projected.content } : {}),
      } satisfies DurableTranscriptMutation;
    }));
  }

  async recordToolFinished(
    handle: DurableTurnHandle,
    input: { callId: string; result: unknown; isError: boolean },
  ) {
    this.assertOpen();
    const result = await this.prepareJson(input.result);
    const mutation = await this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const scope = this.scopeIdentity(handle.scopeId);
      if (scope.kind === 'work_unit') {
        const started = this.storage.database.prepare(`
          SELECT 1 FROM events
          WHERE scope_id = ? AND type = 'tool.called'
            AND json_extract(payload_json, '$.callId') = ?
        `).get(handle.scopeId, input.callId);
        if (!started) throw new Error(`Tool call ${input.callId} was not durably started.`);
        const completed = this.storage.database.prepare(`
          SELECT 1 FROM events
          WHERE scope_id = ? AND type = 'tool.completed'
            AND json_extract(payload_json, '$.callId') = ?
        `).get(handle.scopeId, input.callId);
        if (completed) return null;
        const recordedAt = safeTimestamp(this.now());
        const sequence = this.insertEvent({
          ...handle,
          eventId: this.nextId('event'),
          type: 'tool.completed',
          actor: 'harness',
          visibility: 'internal',
          payload: { callId: input.callId, isError: input.isError, result: result.ref },
          artifactHash: artifactHash(result.ref),
          createdAt: recordedAt,
        });
        this.insertArtifact(result.artifact, sequence);
        return null;
      }
      const item = this.findToolItem(handle.turnId, input.callId);
      if (!item) throw new Error(`Tool call ${input.callId} was not durably started.`);
      if (item.status !== 'running') return null;
      const recordedAt = safeTimestamp(this.now());
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'tool.completed',
        actor: 'harness',
        visibility: 'transcript',
        payload: { callId: input.callId, isError: input.isError, result: result.ref },
        artifactHash: artifactHash(result.ref),
        createdAt: recordedAt,
      });
      this.insertArtifact(result.artifact, sequence);
      const value = JSON.parse(item.value_json) as Record<string, CanonicalJsonValue>;
      this.storage.database.prepare(`
        UPDATE transcript_items
        SET last_sequence = ?, status = ?, value_json = ?
        WHERE item_id = ?
      `).run(
        sequence,
        input.isError ? 'failed' : 'completed',
        canonicalJson({ ...value, isError: input.isError, result: result.ref }),
        item.item_id,
      );
      const projected = preparedTextProjection(result, MAX_VISIBLE_TEXT_BYTES / 2);
      return {
        basisSequence: sequence,
        createdAt: recordedAt,
        itemId: item.item_id,
        outputText: projected.text,
        ...(projected.content ? { outputContent: projected.content } : {}),
      } satisfies DurableTranscriptMutation;
    }));
    return mutation;
  }

  async startInference(
    handle: DurableTurnHandle,
    input: {
      modelId: string;
      requestMode: 'full' | 'continuation';
      estimatedInputTokens: number;
      payload: unknown;
      context: DurableInferenceContext;
    },
  ) {
    this.assertOpen();
    const inferenceId = this.nextId('inference');
    const frameId = this.nextId('frame');
    const dispatch = await this.prepareText(renderInspectableProviderPayload(input.payload), true);
    if (!dispatch.artifact) throw new Error('Provider dispatch payload must be stored durably.');
    const dispatchArtifact = dispatch.artifact;
    const manifestValue: PromptManifest = {
      version: PROMPT_MANIFEST_VERSION,
      compilerVersion: input.context.frame.compilerVersion,
      policyVersion: input.context.frame.policyVersion,
      piVersion: '0.84.0',
      provider: 'openai-codex',
      modelId: input.modelId,
      projectId: handle.projectId,
      conversationId: handle.conversationId,
      strandId: handle.strandId,
      turnId: handle.turnId,
      scopeId: handle.scopeId,
      frameId,
      inferenceId,
      basisSequence: input.context.basisSequence,
      threadVersionId: input.context.frame.threadVersionId,
      context: {
        semanticHash: input.context.frame.semanticHash,
        bootstrapHash: input.context.frame.bootstrapHash,
        logicalHash: input.context.logicalHash,
        renderedHash: input.context.renderedHash,
        orderedMessageHashes: input.context.orderedMessageHashes,
        messageCount: input.context.messageCount,
        estimatedInputTokens: input.estimatedInputTokens,
        selectedTurnIds: input.context.frame.selectedTurnIds,
        dialogueTurnIds: input.context.frame.dialogueTurnIds,
        omittedDialogueTurns: input.context.frame.omittedDialogueTurns,
        threadDocumentBytes: input.context.frame.threadDocumentBytes,
        scopeKind: input.context.frame.scopeKind,
        softContextLimit: input.context.frame.softContextLimit,
        hardContextLimit: input.context.frame.hardContextLimit,
        pressureNoticed: input.context.frame.pressureNoticed,
        layers: input.context.frame.layers,
        omissions: input.context.frame.omissions,
      },
      transport: {
        requestMode: input.requestMode,
        fixedContractsHash: input.context.fixedContractsHash,
        dispatchArtifact: {
          hash: dispatchArtifact.hash,
          byteLength: dispatchArtifact.byteLength,
          mediaType: dispatchArtifact.mediaType,
        },
      },
    };
    const [manifest, bootstrap] = await Promise.all([
      this.prepareJson(promptManifestValue(manifestValue), true),
      this.prepareText(input.context.frame.bootstrap, true),
    ]);
    if (!manifest.artifact || !bootstrap.artifact) {
      throw new Error('Inference context artifacts must be stored durably.');
    }
    if (bootstrap.sha256 !== input.context.frame.bootstrapHash) {
      throw new Error('Compiled bootstrap hash changed before durable commit.');
    }
    const manifestArtifact = manifest.artifact;
    const bootstrapArtifact = bootstrap.artifact;
    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const running = this.storage.database.prepare(`
        SELECT inference_id FROM inferences WHERE scope_id = ? AND state = 'running'
      `).get(handle.scopeId);
      if (running) throw new Error('A provider inference is already running in this scope.');
      const ordinalRow = this.storage.database.prepare(`
        SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM inferences WHERE scope_id = ?
      `).get(handle.scopeId) as { ordinal: number };
      const ordinal = safeInteger(ordinalRow.ordinal, 'inference ordinal');
      const frameOrdinalRow = this.storage.database.prepare(`
        SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM context_frames WHERE scope_id = ?
      `).get(handle.scopeId) as { ordinal: number };
      const frameOrdinal = safeInteger(frameOrdinalRow.ordinal, 'context frame ordinal');
      const recordedAt = safeTimestamp(this.now());
      const basisSequence = this.currentHead(handle);
      if (input.context.basisSequence !== basisSequence) {
        throw new Error(
          `Provider context basis ${input.context.basisSequence} is stale; journal head is ${basisSequence}.`,
        );
      }
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'inference.started',
        actor: 'harness',
        visibility: 'internal',
        payload: {
          estimatedInputTokens: input.estimatedInputTokens,
          frameId,
          frameRef: `journal://frame/${encodeURIComponent(frameId)}`,
          inferenceId,
          inputHash: input.context.renderedHash,
          manifestArtifactHash: manifestArtifact.hash,
          manifestVersion: PROMPT_MANIFEST_VERSION,
          contextLogicalHash: input.context.logicalHash,
          contextMessageCount: input.context.messageCount,
          contextRenderedHash: input.context.renderedHash,
          frameOrdinal,
          bootstrapHash: bootstrapArtifact.hash,
          semanticHash: input.context.frame.semanticHash,
          ordinal,
          requestMode: input.requestMode,
          dispatchArtifactHash: dispatchArtifact.hash,
        },
        artifactHash: manifestArtifact.hash,
        createdAt: recordedAt,
      });
      this.insertArtifact(manifestArtifact, sequence);
      this.insertArtifact(bootstrapArtifact, sequence);
      this.insertArtifact(dispatchArtifact, sequence);
      this.storage.database.prepare(`
        INSERT INTO context_frames (
          frame_id, project_id, conversation_id, strand_id, turn_id,
          scope_id, ordinal, basis_sequence, compiler_version,
          thread_version_id, manifest_artifact_hash, bootstrap_artifact_hash,
          input_hash, ordered_item_hashes_json, estimated_input_tokens,
          created_sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        frameId,
        handle.projectId,
        handle.conversationId,
        handle.strandId,
        handle.turnId,
        handle.scopeId,
        frameOrdinal,
        basisSequence,
        input.context.frame.compilerVersion,
        input.context.frame.threadVersionId,
        manifestArtifact.hash,
        bootstrapArtifact.hash,
        input.context.renderedHash,
        canonicalJson(input.context.orderedMessageHashes),
        input.estimatedInputTokens,
        sequence,
        recordedAt,
      );
      this.storage.database.prepare(`
        INSERT INTO inferences (
          inference_id, project_id, conversation_id, strand_id, turn_id,
          scope_id, frame_id, ordinal, basis_sequence, state, request_mode,
          dispatch_artifact_hash, input_hash, estimated_input_tokens,
          reported_input_tokens, reported_output_tokens,
          reported_cache_read_tokens, started_sequence, terminal_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)
      `).run(
        inferenceId,
        handle.projectId,
        handle.conversationId,
        handle.strandId,
        handle.turnId,
        handle.scopeId,
        frameId,
        ordinal,
        basisSequence,
        input.requestMode,
        dispatchArtifact.hash,
        input.context.renderedHash,
        input.estimatedInputTokens,
        sequence,
      );
      const inspector = contextInspectorValue({
        frameId,
        manifest: manifestValue,
        manifestArtifact,
        bootstrapArtifact,
        dispatchArtifact,
        activeMessages: input.context.activeMessages,
        buildDurationMs: input.context.frameBuildDurationMs,
      });
      this.upsertResource(`context:${handle.conversationId}`, sequence, inspector, recordedAt);
      return { inferenceId, ordinal, sequence, context: inspector };
    }));
  }

  recordInferenceTransport(
    handle: DurableTurnHandle,
    input: {
      plannedRequestMode: 'full' | 'continuation';
      actualRequestMode: 'full' | 'continuation';
    },
  ) {
    this.assertOpen();
    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const inference = this.storage.database.prepare(`
        SELECT inference_id, request_mode
        FROM inferences
        WHERE scope_id = ? AND state = 'running'
      `).get(handle.scopeId) as { inference_id: string; request_mode: string } | undefined;
      if (!inference) return false;
      if (inference.request_mode !== input.plannedRequestMode) {
        throw new Error('Provider transport plan changed after the durable inference fence.');
      }
      const existing = this.storage.database.prepare(`
        SELECT 1 FROM events
        WHERE conversation_id = ? AND type = 'inference.transport'
          AND json_extract(payload_json, '$.inferenceId') = ?
      `).get(handle.conversationId, inference.inference_id);
      if (existing) return false;
      const recordedAt = safeTimestamp(this.now());
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'inference.transport',
        actor: 'harness',
        visibility: 'internal',
        payload: {
          inferenceId: inference.inference_id,
          plannedRequestMode: input.plannedRequestMode,
          actualRequestMode: input.actualRequestMode,
        },
        createdAt: recordedAt,
      });
      this.storage.database.prepare(`
        UPDATE inferences SET request_mode = ? WHERE inference_id = ?
      `).run(input.actualRequestMode, inference.inference_id);
      const resourceKey = `context:${handle.conversationId}` as const;
      const resource = this.storage.database.prepare(`
        SELECT value_json FROM resources WHERE resource_key = ?
      `).get(resourceKey) as { value_json: string } | undefined;
      if (!resource) throw new Error('Inference context inspector is missing.');
      const inspector = JSON.parse(resource.value_json) as ContextInspectorValue;
      if (inspector.inferenceId !== inference.inference_id) {
        throw new Error('Inference context inspector does not match the active provider call.');
      }
      inspector.transportMode = input.actualRequestMode;
      this.upsertResource(resourceKey, sequence, inspector, recordedAt);
      return true;
    }));
  }

  async recordProviderItem(handle: DurableTurnHandle, message: AssistantMessage) {
    this.assertOpen();
    const [raw, inspectable] = await Promise.all([
      this.prepareProviderJson(message),
      this.prepareProviderJson(sanitizeProviderPayload(message)),
    ]);
    if (!raw.artifact || !inspectable.artifact) {
      throw new Error('Provider items must be stored as durable artifacts.');
    }
    const rawArtifact = raw.artifact;
    const inspectableArtifact = inspectable.artifact;
    const providerItemId = this.nextId('provider-item');
    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const inference = this.storage.database.prepare(`
        SELECT inference_id FROM inferences
        WHERE scope_id = ? AND state = 'running'
        ORDER BY ordinal DESC LIMIT 1
      `).get(handle.scopeId) as { inference_id: string } | undefined;
      if (!inference) throw new Error('A provider item has no running inference fence.');
      const ordinalRow = this.storage.database.prepare(`
        SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
        FROM provider_items WHERE inference_id = ?
      `).get(inference.inference_id) as { ordinal: number };
      const ordinal = safeInteger(ordinalRow.ordinal, 'provider item ordinal');
      const recordedAt = safeTimestamp(this.now());
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'provider.item.recorded',
        actor: 'harness',
        visibility: 'internal',
        payload: {
          inferenceId: inference.inference_id,
          inspectableArtifactHash: inspectableArtifact.hash,
          itemType: 'assistant_message',
          ordinal,
          providerItemId,
          rawArtifactHash: rawArtifact.hash,
        },
        artifactHash: inspectableArtifact.hash,
        createdAt: recordedAt,
      });
      this.insertArtifact(rawArtifact, sequence, 'private');
      this.insertArtifact(inspectableArtifact, sequence, 'inspectable');
      this.storage.database.prepare(`
        INSERT INTO provider_items (
          provider_item_id, inference_id, project_id, conversation_id,
          strand_id, turn_id, scope_id, ordinal, item_type,
          upstream_item_id, raw_artifact_hash, inspectable_artifact_hash,
          created_sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assistant_message', NULL, ?, ?, ?, ?)
      `).run(
        providerItemId,
        inference.inference_id,
        handle.projectId,
        handle.conversationId,
        handle.strandId,
        handle.turnId,
        handle.scopeId,
        ordinal,
        rawArtifact.hash,
        inspectableArtifact.hash,
        sequence,
        recordedAt,
      );
      this.storage.database.prepare(`
        UPDATE inferences
        SET reported_input_tokens = ?, reported_output_tokens = ?,
            reported_cache_read_tokens = ?
        WHERE inference_id = ?
      `).run(
        safeNonnegativeInteger(message.usage.input, 'provider input tokens'),
        safeNonnegativeInteger(message.usage.output, 'provider output tokens'),
        safeNonnegativeInteger(message.usage.cacheRead, 'provider cache-read tokens'),
        inference.inference_id,
      );
      return { providerItemId, inferenceId: inference.inference_id, ordinal, sequence };
    }));
  }

  finishInference(
    handle: DurableTurnHandle,
    input: {
      state: 'completed' | 'failed' | 'interrupted';
      reportedInputTokens?: number;
      reportedOutputTokens?: number;
    },
  ) {
    this.assertOpen();
    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const inference = this.storage.database.prepare(`
        SELECT inference_id, reported_input_tokens, reported_output_tokens
        FROM inferences
        WHERE scope_id = ? AND state = 'running'
        ORDER BY ordinal DESC LIMIT 1
      `).get(handle.scopeId) as {
        inference_id: string;
        reported_input_tokens: number | null;
        reported_output_tokens: number | null;
      } | undefined;
      if (!inference) return false;
      const reportedInputTokens = input.reportedInputTokens ?? inference.reported_input_tokens;
      const reportedOutputTokens = input.reportedOutputTokens ?? inference.reported_output_tokens;
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: `inference.${input.state}`,
        actor: 'harness',
        visibility: 'internal',
        payload: {
          inferenceId: inference.inference_id,
          reportedInputTokens,
          reportedOutputTokens,
        },
        createdAt: safeTimestamp(this.now()),
      });
      this.storage.database.prepare(`
        UPDATE inferences
        SET state = ?, reported_input_tokens = ?, reported_output_tokens = ?,
            terminal_sequence = ?
        WHERE inference_id = ?
      `).run(
        input.state,
        reportedInputTokens,
        reportedOutputTokens,
        sequence,
        inference.inference_id,
      );
      return true;
    }));
  }

  finishTurn(
    handle: DurableTurnHandle,
    input: {
      status: Exclude<DurableTurnStatus, 'interrupted_by_restart'>;
      error?: string | null;
      errorCode?: DurableTurnErrorCode | null;
      durationMs?: number;
    },
  ) {
    this.assertOpen();
    return this.enqueueWrite(async () => {
      const assistant = await this.prepareAssistantProjection(handle.turnId);
      const error = input.error ?? null;
      const finalization = await this.prepareTurnFinalization(
        handle,
        input.status,
        error,
        assistant,
      );
      return this.finishTurnTransaction(
        handle,
        input.status,
        error,
        input.errorCode ?? (error ? 'runtime_error' : null),
        input.durationMs,
        assistant,
        finalization,
      );
    });
  }

  async readTranscriptActions(conversationId: string): Promise<DurableTranscriptAction[]> {
    const projection = await this.readTranscriptProjection(conversationId);
    return projection?.actions.map(stripTranscriptProjectionMetadata) ?? [];
  }

  async readArtifact(
    hash: string,
    range?: { offset: number; byteLength: number },
  ): Promise<DurableArtifact | null> {
    this.assertOpen();
    await this.writerTail;
    const row = this.storage.database.prepare(`
      SELECT hash, byte_length, media_type, storage_path
      FROM artifacts WHERE hash = ? AND sensitivity <> 'private'
    `).get(hash) as {
      hash: string;
      byte_length: number;
      media_type: string;
      storage_path: string;
    } | undefined;
    if (!row) return null;
    const reference = {
      hash: row.hash,
      byteLength: row.byte_length,
      storagePath: row.storage_path,
    };
    const offset = range ? Math.min(range.offset, row.byte_length) : 0;
    const bytes = range
      ? await this.artifacts.readRange(reference, offset, range.byteLength)
      : await this.artifacts.read(reference);
    return {
      hash: row.hash,
      byteLength: row.byte_length,
      mediaType: row.media_type,
      offset,
      bytes,
    };
  }

  async readTranscriptBasis(conversationId: string): Promise<number | null> {
    this.assertOpen();
    await this.writerTail;
    const row = this.storage.database.prepare(`
      SELECT MAX(sequence) AS sequence FROM events WHERE conversation_id = ?
    `).get(conversationId) as { sequence: number | null };
    return row.sequence === null ? null : safeInteger(row.sequence, 'conversation transcript basis');
  }

  async readTranscriptProjection(
    conversationId: string,
  ): Promise<DurableTranscriptProjection | null> {
    this.assertOpen();
    await this.writerTail;
    const events = await this.readEvents({ conversationId });
    if (events.length === 0) return null;
    const itemRows = this.storage.database.prepare(`
      SELECT item_id, turn_id, first_sequence, kind, value_json
      FROM transcript_items
      WHERE conversation_id = ?
      ORDER BY first_sequence, item_id
    `).all(conversationId) as Array<{
      item_id: string;
      turn_id: string;
      first_sequence: number;
      kind: string;
      value_json: string;
    }>;
    const userItemsBySequence = new Map<number, { itemId: string; parts: AgentUserMessagePart[] }>();
    const assistantItemsByTurn = new Map<string, string>();
    const toolItemsByCall = new Map<string, string>();
    for (const item of itemRows) {
      if (item.kind === 'user') {
        const value = JSON.parse(item.value_json) as Record<string, CanonicalJsonValue>;
        userItemsBySequence.set(item.first_sequence, {
          itemId: item.item_id,
          parts: parseStoredUserParts(value.parts),
        });
      } else if (item.kind === 'assistant') {
        assistantItemsByTurn.set(item.turn_id, item.item_id);
      } else if (item.kind === 'tool') {
        const value = JSON.parse(item.value_json) as { callId?: unknown };
        if (typeof value.callId === 'string') {
          toolItemsByCall.set(`${item.turn_id}\0${value.callId}`, item.item_id);
        }
      }
    }
    const actions: DurableTranscriptProjectionAction[] = [];
    const startedAtByTurn = new Map<string, number>();
    for (const event of events) {
      if (!event.turnId || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) continue;
      const payload = event.payload as Record<string, CanonicalJsonValue>;
      if (event.type === 'message.user') {
        startedAtByTurn.set(event.turnId, event.createdAt);
        const userItem = userItemsBySequence.get(event.sequence);
        const parts = userItem?.parts ?? parseStoredUserParts(payload.parts);
        actions.push({
          type: 'turn',
          sequence: event.sequence,
          createdAt: event.createdAt,
          itemId: requiredProjectionItemId(
            userItem?.itemId,
            'user transcript item',
          ),
          turnId: event.turnId,
          clientMessageId: requiredString(payload.clientMessageId, 'clientMessageId'),
          text: await this.readTextRef(payload.content),
          ...(parts.length > 0 ? { parts } : {}),
        });
      } else if (event.type === 'assistant.checkpoint' && event.visibility === 'transcript') {
        actions.push({
          type: 'assistant',
          sequence: event.sequence,
          createdAt: event.createdAt,
          itemId: requiredProjectionItemId(
            assistantItemsByTurn.get(event.turnId),
            'assistant transcript item',
          ),
          turnId: event.turnId,
          textDelta: payload.textDelta === undefined
            ? await this.readTextRef(payload.text)
            : requiredString(payload.textDelta, 'textDelta'),
          reasoningDelta: payload.reasoningDelta === undefined
            ? await this.readTextRef(payload.reasoning)
            : requiredString(payload.reasoningDelta, 'reasoningDelta'),
        });
      } else if (event.type === 'tool.called') {
        const callId = requiredString(payload.callId, 'callId');
        actions.push({
          type: 'tool-start',
          sequence: event.sequence,
          createdAt: event.createdAt,
          itemId: requiredProjectionItemId(
            toolItemsByCall.get(`${event.turnId}\0${callId}`),
            'tool transcript item',
          ),
          turnId: event.turnId,
          callId,
          name: requiredString(payload.name, 'name'),
          args: await this.readJsonRef(payload.args),
        });
      } else if (event.type === 'tool.completed') {
        const callId = requiredString(payload.callId, 'callId');
        actions.push({
          type: 'tool-end',
          sequence: event.sequence,
          createdAt: event.createdAt,
          itemId: requiredProjectionItemId(
            toolItemsByCall.get(`${event.turnId}\0${callId}`),
            'tool transcript item',
          ),
          turnId: event.turnId,
          callId,
          result: await this.readJsonRef(payload.result),
          isError: payload.isError === true,
        });
      } else if (event.type === 'turn.terminal') {
        const error = terminalError(payload);
        actions.push({
          type: 'terminal',
          sequence: event.sequence,
          createdAt: event.createdAt,
          itemId: null,
          turnId: event.turnId,
          status: requiredTurnStatus(payload.status),
          error,
          errorCode: terminalErrorCode(payload, error),
          durationMs: terminalDuration(payload, startedAtByTurn.get(event.turnId), event.createdAt),
        });
      }
    }
    return {
      basisSequence: events.at(-1)!.sequence,
      actions,
    };
  }

  async readTranscriptWindowProjection(
    params: AgentTranscriptResourcesReadParams,
  ): Promise<DurableTranscriptWindowProjection | null> {
    this.assertOpen();
    await this.writerTail;
    const basisRow = this.storage.database.prepare(`
      SELECT MAX(sequence) AS sequence FROM events WHERE conversation_id = ?
    `).get(params.conversationId) as { sequence: number | null };
    if (basisRow.sequence === null) return null;
    const basisSequence = safeInteger(basisRow.sequence, 'conversation transcript basis');
    const windows: DurableTranscriptWindow[] = [];
    const selected = new Set<string>();
    for (const [requestIndex, request] of params.requests.entries()) {
      if (request.type === 'transcriptSync') {
        const window = this.resolveTranscriptWindow(
          params.conversationId,
          requestIndex,
          request.window,
        );
        windows.push(window);
        for (const turnId of window.turnIds) selected.add(turnId);
      } else {
        const row = this.storage.database.prepare(`
          SELECT turn_id FROM turns WHERE conversation_id = ? AND turn_id = ?
        `).get(params.conversationId, request.turnId) as { turn_id: string } | undefined;
        if (row) selected.add(row.turn_id);
      }
    }
    if (selected.size > MAX_TRANSCRIPT_WINDOW_TURNS) {
      throw new DurableTranscriptSelectionError(
        `A transcript resource batch may select at most ${MAX_TRANSCRIPT_WINDOW_TURNS} turns.`,
      );
    }
    const selectedTurnIds = selected.size === 0
      ? []
      : (this.storage.database.prepare(`
          SELECT turn_id FROM turns
          WHERE conversation_id = ? AND turn_id IN (${sqlPlaceholders(selected.size)})
          ORDER BY accepted_sequence, turn_id
        `).all(params.conversationId, ...selected) as Array<{ turn_id: string }>)
          .map((row) => row.turn_id);
    if (selectedTurnIds.length === 0) {
      return { basisSequence, actions: [], estimatedBytes: 0, selectedTurnIds, windows };
    }

    const placeholders = sqlPlaceholders(selectedTurnIds.length);
    const itemRows = this.storage.database.prepare(`
      SELECT item_id, turn_id, first_sequence, last_sequence, kind, value_json
      FROM transcript_items
      WHERE conversation_id = ? AND turn_id IN (${placeholders})
      ORDER BY first_sequence, item_id
    `).all(params.conversationId, ...selectedTurnIds) as TranscriptWindowItemRow[];
    const eventRows = this.storage.database.prepare(`
      SELECT sequence, event_id, project_id, conversation_id, strand_id,
             turn_id, scope_id, type, actor, visibility, causal_event_id,
             operation_id, payload_json, artifact_hash, created_at
      FROM events
      WHERE conversation_id = ? AND turn_id IN (${placeholders})
        AND type IN (
          'message.user', 'assistant.checkpoint', 'tool.called',
          'tool.completed', 'turn.terminal'
        )
      ORDER BY sequence
    `).all(params.conversationId, ...selectedTurnIds) as EventRow[];
    const events = eventRows.map(decodeEventRow);
    const createdAtBySequence = new Map(events.map((event) => [event.sequence, event.createdAt]));
    const userItemsBySequence = new Map<number, TranscriptWindowItemRow>();
    const assistantItemsByTurn = new Map<string, TranscriptWindowItemRow>();
    const toolItemsByCall = new Map<string, TranscriptWindowItemRow>();
    for (const item of itemRows) {
      if (item.kind === 'user') {
        userItemsBySequence.set(item.first_sequence, item);
      } else if (item.kind === 'assistant') {
        assistantItemsByTurn.set(item.turn_id, item);
      } else if (item.kind === 'tool') {
        const value = JSON.parse(item.value_json) as Record<string, CanonicalJsonValue>;
        if (typeof value.callId === 'string') {
          toolItemsByCall.set(`${item.turn_id}\0${value.callId}`, item);
        }
      }
    }
    const requestedDetailIds = new Set(params.requests.flatMap((request) =>
      request.type === 'workEntryDetail' ? [request.rowId] : []));
    const finalizedAssistantTurns = new Set<string>();
    const ordered: Array<{
      orderSequence: number;
      priority: number;
      action: DurableTranscriptProjectionAction;
    }> = [];
    const startedAtByTurn = new Map<string, number>();

    for (const item of assistantItemsByTurn.values()) {
      const finalized = parseFinalAssistantProjection(item.value_json);
      if (!finalized) continue;
      finalizedAssistantTurns.add(item.turn_id);
      for (const run of finalized.reasoningRuns) {
        const projected = await this.readProjectedTextRef(run.content);
        ordered.push({
          orderSequence: run.firstSequence,
          priority: 0,
          action: {
            type: 'assistant',
            sequence: run.lastSequence,
            createdAt: requiredSequenceTimestamp(createdAtBySequence, run.lastSequence),
            itemId: item.item_id,
            turnId: item.turn_id,
            textDelta: '',
            reasoningDelta: projected.text,
            ...(projected.content ? { reasoningContent: projected.content } : {}),
          },
        });
      }
      if (finalized.text) {
        const projected = await this.readProjectedTextRef(finalized.text.content);
        ordered.push({
          orderSequence: finalized.text.firstSequence,
          priority: 1,
          action: {
            type: 'assistant',
            sequence: finalized.text.lastSequence,
            createdAt: requiredSequenceTimestamp(createdAtBySequence, finalized.text.lastSequence),
            itemId: item.item_id,
            turnId: item.turn_id,
            textDelta: projected.text,
            reasoningDelta: '',
            ...(projected.content ? { textContent: projected.content } : {}),
          },
        });
      }
    }

    for (const event of events) {
      if (!event.turnId || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
        continue;
      }
      const payload = event.payload as Record<string, CanonicalJsonValue>;
      if (event.type === 'message.user') {
        startedAtByTurn.set(event.turnId, event.createdAt);
        const item = userItemsBySequence.get(event.sequence);
        if (!item) throw new Error('Durable user transcript item is missing.');
        const value = JSON.parse(item.value_json) as Record<string, CanonicalJsonValue>;
        const projected = await this.readProjectedTextRef(value.content ?? payload.content);
        const parts = parseStoredUserParts(value.parts ?? payload.parts);
        ordered.push({
          orderSequence: event.sequence,
          priority: 0,
          action: {
            type: 'turn',
            sequence: event.sequence,
            createdAt: event.createdAt,
            itemId: item.item_id,
            turnId: event.turnId,
            clientMessageId: requiredString(payload.clientMessageId, 'clientMessageId'),
            text: projected.text,
            ...(parts.length > 0 ? { parts } : {}),
            ...(projected.content ? { content: projected.content } : {}),
          },
        });
      } else if (
        event.type === 'assistant.checkpoint' &&
        !finalizedAssistantTurns.has(event.turnId)
      ) {
        const item = assistantItemsByTurn.get(event.turnId);
        if (!item) throw new Error('Durable assistant transcript item is missing.');
        const text = payload.textDelta === undefined
          ? await this.readProjectedTextRef(payload.text)
          : { text: requiredString(payload.textDelta, 'textDelta'), content: undefined };
        const reasoning = payload.reasoningDelta === undefined
          ? await this.readProjectedTextRef(payload.reasoning)
          : { text: requiredString(payload.reasoningDelta, 'reasoningDelta'), content: undefined };
        ordered.push({
          orderSequence: event.sequence,
          priority: 0,
          action: {
            type: 'assistant',
            sequence: event.sequence,
            createdAt: event.createdAt,
            itemId: item.item_id,
            turnId: event.turnId,
            textDelta: text.text,
            reasoningDelta: reasoning.text,
            ...(text.content ? { textContent: text.content } : {}),
            ...(reasoning.content ? { reasoningContent: reasoning.content } : {}),
          },
        });
      } else if (event.type === 'tool.called') {
        const callId = requiredString(payload.callId, 'callId');
        const item = toolItemsByCall.get(`${event.turnId}\0${callId}`);
        if (!item) throw new Error('Durable tool transcript item is missing.');
        const value = JSON.parse(item.value_json) as Record<string, CanonicalJsonValue>;
        const shouldReadDetail = requestedDetailIds.has(item.item_id);
        const argsRef = value.args ?? payload.args;
        const args = await this.projectToolValue(argsRef, shouldReadDetail);
        ordered.push({
          orderSequence: event.sequence,
          priority: 0,
          action: {
            type: 'tool-start',
            sequence: event.sequence,
            createdAt: event.createdAt,
            itemId: item.item_id,
            turnId: event.turnId,
            callId,
            name: requiredString(payload.name, 'name'),
            args: args.value,
            ...(args.text === undefined ? {} : { detailText: args.text }),
            ...(args.content ? { detailContent: args.content } : {}),
          },
        });
      } else if (event.type === 'tool.completed') {
        const callId = requiredString(payload.callId, 'callId');
        const item = toolItemsByCall.get(`${event.turnId}\0${callId}`);
        if (!item) throw new Error('Durable tool transcript item is missing.');
        const value = JSON.parse(item.value_json) as Record<string, CanonicalJsonValue>;
        const shouldReadDetail = requestedDetailIds.has(item.item_id);
        const result = await this.projectToolValue(value.result ?? payload.result, shouldReadDetail);
        ordered.push({
          orderSequence: event.sequence,
          priority: 0,
          action: {
            type: 'tool-end',
            sequence: event.sequence,
            createdAt: event.createdAt,
            itemId: item.item_id,
            turnId: event.turnId,
            callId,
            result: result.value,
            isError: payload.isError === true,
            ...(result.text === undefined ? {} : { outputText: result.text }),
            ...(result.content ? { outputContent: result.content } : {}),
          },
        });
      } else if (event.type === 'turn.terminal') {
        const error = terminalError(payload);
        ordered.push({
          orderSequence: event.sequence,
          priority: 0,
          action: {
            type: 'terminal',
            sequence: event.sequence,
            createdAt: event.createdAt,
            itemId: null,
            turnId: event.turnId,
            status: requiredTurnStatus(payload.status),
            error,
            errorCode: terminalErrorCode(payload, error),
            durationMs: terminalDuration(payload, startedAtByTurn.get(event.turnId), event.createdAt),
          },
        });
      }
    }
    ordered.sort((left, right) =>
      left.orderSequence - right.orderSequence || left.priority - right.priority);
    const actions = ordered.map((entry) => entry.action);
    return {
      basisSequence,
      actions,
      estimatedBytes: Buffer.byteLength(JSON.stringify(actions), 'utf8'),
      selectedTurnIds,
      windows,
    };
  }

  private resolveTranscriptWindow(
    conversationId: string,
    requestIndex: number,
    window: Extract<AgentTranscriptResourcesReadParams['requests'][number], {
      type: 'transcriptSync';
    }>['window'],
  ): DurableTranscriptWindow {
    const countRow = this.storage.database.prepare(`
      SELECT COUNT(*) AS count FROM turns WHERE conversation_id = ?
    `).get(conversationId) as { count: number };
    const total = safeNonnegativeInteger(countRow.count, 'transcript turn count');
    let rows: Array<{ turn_id: string; accepted_sequence: number }>;
    let startIndex: number;
    if (window.kind === 'tail') {
      const count = window.count ?? DEFAULT_TRANSCRIPT_TAIL_TURNS;
      startIndex = Math.max(0, total - count);
      rows = this.storage.database.prepare(`
        SELECT turn_id, accepted_sequence FROM turns
        WHERE conversation_id = ?
        ORDER BY accepted_sequence, turn_id LIMIT ? OFFSET ?
      `).all(conversationId, count, startIndex) as typeof rows;
    } else if (window.kind === 'around') {
      const anchor = this.storage.database.prepare(`
        SELECT accepted_sequence FROM turns
        WHERE conversation_id = ? AND turn_id = ?
      `).get(conversationId, window.turnId) as { accepted_sequence: number } | undefined;
      if (!anchor) throw new DurableTranscriptSelectionError('Transcript window anchor was not found.');
      const before = (this.storage.database.prepare(`
        SELECT turn_id, accepted_sequence FROM turns
        WHERE conversation_id = ? AND accepted_sequence < ?
        ORDER BY accepted_sequence DESC, turn_id DESC LIMIT ?
      `).all(conversationId, anchor.accepted_sequence, window.before) as typeof rows).reverse();
      const after = this.storage.database.prepare(`
        SELECT turn_id, accepted_sequence FROM turns
        WHERE conversation_id = ? AND accepted_sequence >= ?
        ORDER BY accepted_sequence, turn_id LIMIT ?
      `).all(conversationId, anchor.accepted_sequence, window.after + 1) as typeof rows;
      rows = [...before, ...after];
      const firstSequence = rows[0]?.accepted_sequence ?? anchor.accepted_sequence;
      const preceding = this.storage.database.prepare(`
        SELECT COUNT(*) AS count FROM turns
        WHERE conversation_id = ? AND accepted_sequence < ?
      `).get(conversationId, firstSequence) as { count: number };
      startIndex = safeNonnegativeInteger(preceding.count, 'transcript start index');
    } else {
      const anchors = this.storage.database.prepare(`
        SELECT turn_id, accepted_sequence FROM turns
        WHERE conversation_id = ? AND turn_id IN (?, ?)
      `).all(conversationId, window.startTurnId, window.endTurnId) as typeof rows;
      const start = anchors.find((row) => row.turn_id === window.startTurnId);
      const end = anchors.find((row) => row.turn_id === window.endTurnId);
      if (!start || !end || end.accepted_sequence < start.accepted_sequence) {
        throw new DurableTranscriptSelectionError('Transcript range anchors are invalid.');
      }
      rows = this.storage.database.prepare(`
        SELECT turn_id, accepted_sequence FROM turns
        WHERE conversation_id = ? AND accepted_sequence BETWEEN ? AND ?
        ORDER BY accepted_sequence, turn_id LIMIT ?
      `).all(
        conversationId,
        start.accepted_sequence,
        end.accepted_sequence,
        MAX_TRANSCRIPT_WINDOW_TURNS + 1,
      ) as typeof rows;
      if (rows.length > MAX_TRANSCRIPT_WINDOW_TURNS) {
        throw new DurableTranscriptSelectionError(
          `Transcript range exceeds the ${MAX_TRANSCRIPT_WINDOW_TURNS} turn limit.`,
        );
      }
      const preceding = this.storage.database.prepare(`
        SELECT COUNT(*) AS count FROM turns
        WHERE conversation_id = ? AND accepted_sequence < ?
      `).get(conversationId, start.accepted_sequence) as { count: number };
      startIndex = safeNonnegativeInteger(preceding.count, 'transcript start index');
    }
    const turnIds = rows.map((row) => row.turn_id);
    const endIndexExclusive = startIndex + turnIds.length;
    return {
      requestIndex,
      startIndex,
      endIndexExclusive,
      hasEarlier: startIndex > 0,
      hasLater: endIndexExclusive < total,
      turnIds,
    };
  }

  private async projectToolValue(value: CanonicalJsonValue | undefined, includeDetail: boolean) {
    const ref = parseReference(value);
    if (ref.kind === 'inline') {
      return {
        value: JSON.parse(ref.text) as unknown,
        ...(includeDetail ? { text: ref.text } : {}),
        content: undefined,
      };
    }
    if (!includeDetail) return { value: {}, text: undefined, content: undefined };
    const projected = await this.readProjectedTextRef(value, MAX_VISIBLE_TEXT_BYTES / 2);
    return { value: {}, text: projected.text, content: projected.content };
  }

  async compileContext(
    conversationId: string,
    contextWindow = 400_000,
  ): Promise<DurableContextBoundarySnapshot> {
    this.assertOpen();
    await this.writerTail;
    const activeScope = this.activeScopeIdentity(conversationId);
    const scopeKinds = new Map((this.storage.database.prepare(`
      SELECT scope_id, kind FROM execution_scopes WHERE conversation_id = ?
    `).all(conversationId) as Array<{
      scope_id: string;
      kind: 'turn' | 'work_unit';
    }>).map((row) => [row.scope_id, row.kind]));
    const visibleScopeIds = activeScope.kind === 'work_unit'
      ? [activeScope.rootScopeId, activeScope.scopeId]
      : [activeScope.rootScopeId];
    const visibleScopeSet = new Set(visibleScopeIds);
    const allEvents = (await this.readEvents({ conversationId }))
      .filter((event) => event.strandId === activeScope.strandId)
      .filter((event) =>
        event.scopeId === null ||
        scopeKinds.get(event.scopeId) === 'turn' ||
        visibleScopeSet.has(event.scopeId));
    if (allEvents.length === 0) throw new Error(`Conversation ${conversationId} does not exist.`);
    const replay = await this.logicalReplayEvents(allEvents);
    const logicalMessages = await this.attachActiveProviderMessages(
      reduceLogicalReplay(replay),
      visibleScopeIds,
      activeScope.turnId,
    );
    const thread = this.storage.database.prepare(`
      SELECT d.document_id, d.head_version_id, v.content_artifact_hash
      FROM state_documents d
      JOIN document_versions v ON v.version_id = d.head_version_id
      WHERE d.conversation_id = ? AND d.strand_id = ?
        AND d.scope_kind = 'strand' AND d.key = 'thread.md'
    `).get(conversationId, activeScope.strandId) as {
      document_id: string;
      head_version_id: string;
      content_artifact_hash: string;
    } | undefined;
    if (!thread) throw new Error('The active strand has no thread.md document.');
    const threadMarkdown = await this.readArtifactTextByHash(thread.content_artifact_hash);
    const basisSequence = allEvents.at(-1)!.sequence;
    const source: ThreadContextSource = {
      basisSequence,
      projectId: activeScope.projectId,
      conversationId,
      strandId: activeScope.strandId,
      turnId: activeScope.turnId,
      scopeId: activeScope.scopeId,
      scopeKind: activeScope.kind,
      threadVersionId: thread.head_version_id,
      threadMarkdown,
      messages: logicalMessages,
      pressureNoticed: allEvents.some((event) =>
        event.scopeId === activeScope.scopeId && event.type === 'context.pressure'),
    };
    const compiled = compileThreadContext(source, { contextWindow });
    const snapshot = createDurableContextSnapshot(basisSequence, compiled.messages);
    const frameRow = this.storage.database.prepare(`
      SELECT MAX(ordinal) AS frame_ordinal
      FROM context_frames WHERE scope_id = ?
    `).get(activeScope.scopeId) as { frame_ordinal: number | null };
    const nextFrameOrdinal = frameRow.frame_ordinal === null
      ? 0
      : safeNonnegativeInteger(frameRow.frame_ordinal, 'context frame ordinal') + 1;
    return {
      ...snapshot,
      frame: compiled.frame,
      scopeId: activeScope.scopeId,
      scopeKind: activeScope.kind,
      nextFrameOrdinal,
    };
  }

  async recordContextPressure(
    handle: DurableTurnHandle,
    input: {
      estimatedInputTokens: number;
      softContextLimit: number;
      hardContextLimit: number;
    },
  ) {
    this.assertOpen();
    const estimatedInputTokens = safeNonnegativeInteger(
      input.estimatedInputTokens,
      'estimated input tokens',
    );
    const softContextLimit = safeNonnegativeInteger(
      input.softContextLimit,
      'soft context limit',
    );
    const hardContextLimit = safeNonnegativeInteger(
      input.hardContextLimit,
      'hard context limit',
    );
    const scope = this.scopeIdentity(handle.scopeId);
    const notice = await this.prepareText(scope.kind === 'work_unit'
      ? [
          'Context pressure notice: this bounded work unit is approaching its healthy context boundary.',
          'Finish the current coherent checkpoint, perform the most important remaining validation, then call work_unit_return with the bounded result the parent needs.',
          'Do not claim unperformed work or validation. Exact evidence remains available through the journal.',
        ].join('\n\n')
      : [
          'Context pressure notice: this parent turn is approaching its healthy context boundary.',
          'Integrate completed work, update thread.md if future shared state changed, and complete the user turn honestly.',
          'Do not claim unperformed work or validation. Exact evidence remains available through the journal.',
        ].join('\n\n'));
    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const existing = this.storage.database.prepare(`
        SELECT 1 FROM events WHERE scope_id = ? AND type = 'context.pressure'
      `).get(handle.scopeId);
      if (existing) return false;
      const recordedAt = safeTimestamp(this.now());
      const pressureEventId = this.nextId('event');
      const pressureSequence = this.insertEvent({
        ...handle,
        eventId: pressureEventId,
        type: 'context.pressure',
        actor: 'harness',
        visibility: 'internal',
        payload: {
          estimatedInputTokens,
          hardContextLimit,
          scopeKind: scope.kind,
          softContextLimit,
        },
        createdAt: recordedAt,
      });
      const messageSequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'message.internal',
        actor: 'harness',
        visibility: 'internal',
        payload: {
          content: notice.ref,
          kind: 'context_pressure',
          pressureSequence,
        },
        artifactHash: artifactHash(notice.ref),
        createdAt: recordedAt,
      });
      this.insertArtifact(notice.artifact, messageSequence);
      return true;
    }));
  }

  async resumeActiveTurn(conversationId: string): Promise<{
    handle: DurableTurnHandle;
    rootHandle: DurableTurnHandle;
    prompt: string;
  } | null> {
    this.assertOpen();
    await this.writerTail;
    const row = this.storage.database.prepare(`
      SELECT t.project_id, t.conversation_id, t.strand_id, t.turn_id,
             t.root_scope_id, s.scope_id, s.kind
      FROM turns t
      JOIN execution_scopes s ON s.turn_id = t.turn_id
      WHERE t.conversation_id = ? AND t.terminal_sequence IS NULL
        AND s.terminal_sequence IS NULL
      ORDER BY t.accepted_sequence DESC,
               (s.kind = 'work_unit') DESC, s.created_sequence DESC
      LIMIT 1
    `).get(conversationId) as {
      project_id: string; conversation_id: string; strand_id: string;
      turn_id: string; root_scope_id: string; scope_id: string;
      kind: 'turn' | 'work_unit';
    } | undefined;
    if (!row) return null;
    const handle: DurableTurnHandle = {
      projectId: row.project_id,
      conversationId: row.conversation_id,
      strandId: row.strand_id,
      turnId: row.turn_id,
      scopeId: row.scope_id,
    };
    const rootHandle = { ...handle, scopeId: row.root_scope_id };
    const prompt = row.kind === 'work_unit'
      ? [
          'The runtime restarted inside this bounded work unit.',
          'Continue its objective from the exact child context and durable tool results.',
          'Do not answer the user directly; finish by calling work_unit_return.',
        ].join(' ')
      : [
          'The runtime restarted during this active turn.',
          'Continue the original user request from the exact current-turn context and durable tool results.',
          'Do not repeat completed work unless its result is uncertain; finish normally.',
        ].join(' ');
    const content = await this.prepareText(prompt);
    await this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const runningInference = this.storage.database.prepare(`
        SELECT 1 FROM inferences WHERE scope_id = ? AND state = 'running'
      `).get(handle.scopeId);
      if (runningInference) throw new Error('Cannot resume while a provider inference is still running.');
      const interrupted = this.storage.database.prepare(`
        SELECT MAX(sequence) AS sequence FROM events
        WHERE scope_id = ? AND type = 'inference.interrupted'
      `).get(handle.scopeId) as { sequence: number | null };
      const interruptedSequence = interrupted.sequence === null
        ? null
        : safeInteger(interrupted.sequence, 'interrupted inference sequence');
      const existing = interruptedSequence === null ? null : this.storage.database.prepare(`
        SELECT 1 FROM events
        WHERE scope_id = ? AND type = 'message.internal'
          AND json_extract(payload_json, '$.kind') = 'runtime_recovery'
          AND json_extract(payload_json, '$.interruptedSequence') = ?
      `).get(handle.scopeId, interruptedSequence);
      if (existing) return;
      const recordedAt = safeTimestamp(this.now());
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'message.internal',
        actor: 'harness',
        visibility: 'internal',
        payload: {
          content: content.ref,
          interruptedSequence,
          kind: 'runtime_recovery',
        },
        artifactHash: artifactHash(content.ref),
        createdAt: recordedAt,
      });
      this.insertArtifact(content.artifact, sequence);
    }));
    return { handle, rootHandle, prompt };
  }

  private async logicalReplayEvents(events: readonly AgentJournalEvent[]) {
    const replay: LogicalReplayEvent[] = [];
    for (const event of events) {
      if (!event.turnId || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
        continue;
      }
      const payload = event.payload as Record<string, CanonicalJsonValue>;
      if (event.type === 'message.user' || event.type === 'message.internal') {
        const parts = parseStoredUserParts(payload.parts);
        replay.push({
          type: 'user',
          sequence: event.sequence,
          turnId: event.turnId,
          timestamp: event.createdAt,
          text: await this.readTextRef(payload.content),
          images: await this.readLogicalImages(parts),
        });
      } else if (event.type === 'assistant.checkpoint') {
        replay.push({
          type: 'assistant-checkpoint',
          sequence: event.sequence,
          turnId: event.turnId,
          timestamp: event.createdAt,
          textDelta: payload.textDelta === undefined
            ? await this.readTextRef(payload.text)
            : requiredString(payload.textDelta, 'textDelta'),
          reasoningDelta: payload.reasoningDelta === undefined
            ? await this.readTextRef(payload.reasoning)
            : requiredString(payload.reasoningDelta, 'reasoningDelta'),
        });
      } else if (event.type === 'inference.started') {
        replay.push({
          type: 'inference-started',
          sequence: event.sequence,
          turnId: event.turnId,
          timestamp: event.createdAt,
          inferenceId: requiredString(payload.inferenceId, 'inferenceId'),
        });
      } else if (
        event.type === 'inference.completed' ||
        event.type === 'inference.failed' ||
        event.type === 'inference.interrupted'
      ) {
        replay.push({
          type: 'inference-terminal',
          sequence: event.sequence,
          turnId: event.turnId,
          timestamp: event.createdAt,
          inferenceId: requiredString(payload.inferenceId, 'inferenceId'),
          state: event.type === 'inference.completed'
            ? 'completed'
            : event.type === 'inference.failed'
              ? 'failed'
              : 'interrupted',
        });
      } else if (event.type === 'tool.called') {
        replay.push({
          type: 'tool-called',
          sequence: event.sequence,
          turnId: event.turnId,
          timestamp: event.createdAt,
          callId: requiredString(payload.callId, 'callId'),
          name: requiredString(payload.name, 'name'),
          args: await this.readJsonRef(payload.args),
        });
      } else if (event.type === 'tool.completed') {
        replay.push({
          type: 'tool-completed',
          sequence: event.sequence,
          turnId: event.turnId,
          timestamp: event.createdAt,
          callId: requiredString(payload.callId, 'callId'),
          result: await this.readJsonRef(payload.result),
          isError: payload.isError === true,
        });
      } else if (event.type === 'turn.terminal') {
        const status = requiredTurnStatus(payload.status);
        replay.push({
          type: 'turn-terminal',
          sequence: event.sequence,
          turnId: event.turnId,
          timestamp: event.createdAt,
          state: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted',
        });
      }
    }
    return replay;
  }

  async searchJournal(
    conversationId: string,
    input: JournalSearchInput,
  ): Promise<JournalSearchResult> {
    this.assertOpen();
    await this.writerTail;
    const query = input.query.trim();
    if (!query) throw new TypeError('Journal search query cannot be empty.');
    const limit = boundedSafeInteger(input.limit ?? 10, 1, 20, 'journal search limit');
    const scope = input.scope ?? 'project';
    const identity = this.contextIdentity(conversationId);
    const terms = journalSearchTerms(query);
    if (terms.length === 0) throw new TypeError('Journal search query must contain searchable text.');
    const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
    const rows = this.storage.database.prepare(`
      SELECT ref, conversation_id, strand_id, turn_id, kind, sequence, text,
             bm25(journal_search_index) AS relevance
      FROM journal_search_index
      WHERE journal_search_index MATCH ?
        AND project_id = ?
        AND (? = 'project' OR conversation_id = ?)
        AND (? = 'operations' OR kind NOT LIKE 'operation:%')
      ORDER BY
        CASE WHEN strand_id = ? THEN 0 WHEN conversation_id = ? THEN 1 ELSE 2 END,
        relevance,
        CAST(sequence AS INTEGER) DESC,
        ref
      LIMIT ?
    `).all(
      ftsQuery,
      identity.projectId,
      scope,
      conversationId,
      input.include ?? '',
      identity.strandId,
      conversationId,
      limit + 1,
    ) as Array<{
      ref: string;
      conversation_id: string;
      strand_id: string;
      turn_id: string;
      kind: string;
      sequence: number;
      text: string;
      relevance: number;
    }>;
    const selected = rows.slice(0, limit);
    const hits = selected.map((row) => ({
      ref: row.ref,
      kind: row.kind,
      excerpt: matchingExcerpt(row.text, terms, 480),
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      sequence: safeInteger(Number(row.sequence), 'journal search sequence'),
      historical: row.conversation_id !== conversationId || row.strand_id !== identity.strandId,
    }));
    return {
      query,
      scope,
      hits,
      truncated: rows.length > selected.length,
      retention: 'ephemeral',
    };
  }

  async openJournal(
    conversationId: string,
    input: JournalOpenInput,
  ): Promise<JournalOpenResult> {
    this.assertOpen();
    await this.writerTail;
    const content = await this.resolveOpenableContent(conversationId, input.ref);
    const bytes = Buffer.from(content, 'utf8');
    const offset = boundedSafeInteger(input.offset ?? 0, 0, bytes.byteLength, 'journal open offset');
    const maxBytes = boundedSafeInteger(input.maxBytes ?? 24 * 1024, 256, 32 * 1024, 'journal open maxBytes');
    const slice = boundedUtf8Slice(bytes, offset, maxBytes);
    return {
      ref: input.ref,
      content: slice.text,
      contentHash: createHash('sha256').update(content).digest('hex'),
      offset: slice.offset,
      byteLength: slice.byteLength,
      totalByteLength: bytes.byteLength,
      nextOffset: slice.offset + slice.byteLength < bytes.byteLength
        ? slice.offset + slice.byteLength
        : null,
      retention: 'ephemeral',
    };
  }

  private async resolveOpenableContent(conversationId: string, ref: string): Promise<string> {
    const identity = this.contextIdentity(conversationId);
    const eventMatch = /^journal:\/\/event\/(\d+)$/u.exec(ref);
    const eventIdMatch = /^journal:\/\/event-id\/([^/?#]+)$/u.exec(ref);
    if (eventMatch || eventIdMatch) {
      const selector = eventMatch ? 'sequence = ?' : 'event_id = ?';
      const value = eventMatch ? Number(eventMatch[1]) : decodeURIComponent(eventIdMatch![1]!);
      const row = this.storage.database.prepare(`
        SELECT sequence, event_id, project_id, conversation_id, strand_id,
               turn_id, scope_id, type, actor, visibility, causal_event_id,
               operation_id, payload_json, artifact_hash, created_at
        FROM events WHERE project_id = ? AND ${selector}
      `).get(identity.projectId, value) as EventRow | undefined;
      if (!row) throw new Error(`Journal event reference ${ref} does not exist in this project.`);
      const event = decodeEventRow(row);
      return canonicalJson({
        ...event,
        payload: await this.expandEventPayload(event),
      } as unknown as CanonicalJsonValue);
    }

    const artifactMatch = /^journal:\/\/artifact\/([0-9a-f]{64})$/u.exec(ref);
    if (artifactMatch) return this.openArtifactText(identity.projectId, artifactMatch[1]!);

    const documentVersionMatch = /^journal:\/\/document-version\/([^/?#]+)$/u.exec(ref);
    if (documentVersionMatch) {
      const versionId = decodeURIComponent(documentVersionMatch[1]!);
      const row = this.storage.database.prepare(`
        SELECT v.version_id, v.document_id, v.ordinal, v.parent_version_id,
               v.content_artifact_hash, v.based_on_turn_id, v.created_sequence
        FROM document_versions v
        JOIN state_documents d ON d.document_id = v.document_id
        WHERE d.project_id = ? AND v.version_id = ?
      `).get(identity.projectId, versionId) as {
        version_id: string; document_id: string; ordinal: number;
        parent_version_id: string | null; content_artifact_hash: string;
        based_on_turn_id: string | null; created_sequence: number;
      } | undefined;
      if (!row) throw new Error(`Thread document version ${versionId} does not exist in this project.`);
      return canonicalJson({
        versionId: row.version_id,
        documentId: row.document_id,
        ordinal: row.ordinal,
        parentVersionId: row.parent_version_id,
        basedOnTurnId: row.based_on_turn_id,
        createdSequence: row.created_sequence,
        content: await this.openArtifactText(identity.projectId, row.content_artifact_hash),
      });
    }

    const messageMatch = /^journal:\/\/message\/([^/?#]+)$/u.exec(ref);
    if (messageMatch) {
      const messageId = decodeURIComponent(messageMatch[1]!);
      const row = this.storage.database.prepare(`
        SELECT m.message_id, m.turn_id, m.scope_id, m.ordinal, m.role,
               m.visibility, m.state, m.content_artifact_hash, m.created_sequence
        FROM messages m
        WHERE m.project_id = ? AND m.message_id = ?
      `).get(identity.projectId, messageId) as {
        message_id: string; turn_id: string; scope_id: string; ordinal: number;
        role: string; visibility: string; state: string;
        content_artifact_hash: string; created_sequence: number;
      } | undefined;
      if (!row) throw new Error(`Journal message ${messageId} does not exist in this project.`);
      return canonicalJson({
        id: row.message_id,
        turnId: row.turn_id,
        scopeId: row.scope_id,
        ordinal: row.ordinal,
        role: row.role,
        visibility: row.visibility,
        state: row.state,
        createdSequence: row.created_sequence,
        content: JSON.parse(await this.openArtifactText(
          identity.projectId,
          row.content_artifact_hash,
        )) as CanonicalJsonValue,
      });
    }

    const journalTurn = /^journal:\/\/turn\/([^/?#]+)(#assistant|#call=[^#]+)?$/u.exec(ref);
    const agentTurn = /^agent:\/\/conversation\/([^/?#]+)\/turn\/([^/?#]+)(#assistant|#call=[^#]+)?$/u.exec(ref);
    if (journalTurn || agentTurn) {
      if (agentTurn && decodeURIComponent(agentTurn[1]!) !== conversationId) {
        throw new Error(`Turn reference ${ref} belongs to another conversation.`);
      }
      const turnId = decodeURIComponent((journalTurn?.[1] ?? agentTurn?.[2])!);
      const fragment = journalTurn?.[2] ?? agentTurn?.[3] ?? '';
      const turn = this.storage.database.prepare(`
        SELECT turn_id, state, accepted_sequence, terminal_sequence
        FROM turns WHERE project_id = ? AND turn_id = ?
      `).get(identity.projectId, turnId) as {
        turn_id: string; state: string; accepted_sequence: number; terminal_sequence: number | null;
      } | undefined;
      if (!turn) throw new Error(`Journal turn ${turnId} does not exist in this project.`);
      if (fragment === '#assistant') {
        const item = this.storage.database.prepare(`
          SELECT message_id FROM messages
          WHERE turn_id = ? AND role = 'assistant' ORDER BY ordinal DESC LIMIT 1
        `).get(turnId) as { message_id: string } | undefined;
        if (!item) throw new Error(`Turn ${turnId} has no assistant message.`);
        return this.resolveOpenableContent(
          conversationId,
          `journal://message/${encodeURIComponent(item.message_id)}`,
        );
      }
      if (fragment.startsWith('#call=')) {
        return this.resolveOpenableContent(conversationId, `journal://tool/${fragment.slice(6)}`);
      }
      return canonicalJson({
        ...turn,
        events: await this.expandedEventsFor('turn_id = ?', [turnId]),
      } as unknown as CanonicalJsonValue);
    }

    const toolMatch = /^journal:\/\/tool\/([^/?#]+)$/u.exec(ref);
    if (toolMatch) {
      const callId = decodeURIComponent(toolMatch[1]!);
      const rows = this.storage.database.prepare(`
        SELECT sequence, event_id, project_id, conversation_id, strand_id,
               turn_id, scope_id, type, actor, visibility, causal_event_id,
               operation_id, payload_json, artifact_hash, created_at
        FROM events
        WHERE project_id = ? AND type IN ('tool.called', 'tool.completed')
          AND json_extract(payload_json, '$.callId') = ?
        ORDER BY sequence
      `).all(identity.projectId, callId) as EventRow[];
      if (rows.length === 0) throw new Error(`Journal tool call ${callId} does not exist in this project.`);
      const events = await Promise.all(rows.map(async (row) => {
        const event = decodeEventRow(row);
        return { ...event, payload: await this.expandEventPayload(event) };
      }));
      return canonicalJson({ callId, events } as unknown as CanonicalJsonValue);
    }

    const scopeMatch = /^journal:\/\/scope\/([^/?#]+)(\/trace)?$/u.exec(ref);
    if (scopeMatch) {
      const scopeId = decodeURIComponent(scopeMatch[1]!);
      const row = this.storage.database.prepare(`
        SELECT scope_id, parent_scope_id, kind, objective_json, state,
               created_sequence, terminal_sequence, result_artifact_hash
        FROM execution_scopes WHERE project_id = ? AND scope_id = ?
      `).get(identity.projectId, scopeId) as {
        scope_id: string; parent_scope_id: string | null; kind: string; objective_json: string;
        state: string; created_sequence: number; terminal_sequence: number | null;
        result_artifact_hash: string | null;
      } | undefined;
      if (!row) throw new Error(`Execution scope ${scopeId} does not exist in this project.`);
      const common = {
        scopeId: row.scope_id,
        parentScopeId: row.parent_scope_id,
        kind: row.kind,
        objective: JSON.parse(row.objective_json) as CanonicalJsonValue,
        state: row.state,
        createdSequence: row.created_sequence,
        terminalSequence: row.terminal_sequence,
        resultRef: row.result_artifact_hash ? `journal://artifact/${row.result_artifact_hash}` : null,
        traceRef: `journal://scope/${encodeURIComponent(scopeId)}/trace`,
      };
      if (!scopeMatch[2]) return canonicalJson(common);
      return canonicalJson({
        ...common,
        events: await this.expandedEventsFor('scope_id = ?', [scopeId]),
      } as unknown as CanonicalJsonValue);
    }

    const frameMatch = /^journal:\/\/frame\/([^/?#]+)$/u.exec(ref);
    if (frameMatch) {
      const frameId = decodeURIComponent(frameMatch[1]!);
      const row = this.storage.database.prepare(`
        SELECT frame_id, scope_id, turn_id, ordinal, basis_sequence,
               compiler_version, thread_version_id, manifest_artifact_hash,
               bootstrap_artifact_hash, input_hash, ordered_item_hashes_json,
               estimated_input_tokens, created_sequence
        FROM context_frames WHERE project_id = ? AND frame_id = ?
      `).get(identity.projectId, frameId) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Context frame ${frameId} does not exist in this project.`);
      const manifestHash = requiredString(row.manifest_artifact_hash as CanonicalJsonValue, 'manifest hash');
      const bootstrapHash = requiredString(row.bootstrap_artifact_hash as CanonicalJsonValue, 'bootstrap hash');
      const normalizedRow = normalizeJson(row) as Record<string, CanonicalJsonValue>;
      return canonicalJson({
        ...normalizedRow,
        manifestRef: `journal://artifact/${manifestHash}`,
        bootstrapRef: `journal://artifact/${bootstrapHash}`,
      });
    }

    const agentProject = /^agent:\/\/project\/([^/?#]+)$/u.exec(ref);
    if (agentProject) {
      if (decodeURIComponent(agentProject[1]!) !== identity.projectId) {
        throw new Error(`Project reference ${ref} belongs to another project.`);
      }
      const row = this.storage.database.prepare(`
        SELECT project_id, root_path, title, state, updated_sequence
        FROM projects WHERE project_id = ?
      `).get(identity.projectId) as Record<string, unknown>;
      return canonicalJson(normalizeJson(row));
    }

    const turnList = /^agent:\/\/conversation\/([^/?#]+)\/turns(?:\?[^#]*)?$/u.exec(ref);
    if (turnList) {
      if (decodeURIComponent(turnList[1]!) !== conversationId) {
        throw new Error(`Turn-list reference ${ref} belongs to another conversation.`);
      }
      const rows = this.storage.database.prepare(`
        SELECT turn_id, state, accepted_sequence, terminal_sequence
        FROM turns WHERE conversation_id = ? ORDER BY accepted_sequence DESC LIMIT 100
      `).all(conversationId) as Array<Record<string, unknown>>;
      return canonicalJson({ conversationId, turns: normalizeJson(rows) });
    }

    throw new Error(`Unsupported journal reference ${ref}.`);
  }

  private async expandedEventsFor(where: string, parameters: readonly (string | number)[]) {
    const rows = this.storage.database.prepare(`
      SELECT sequence, event_id, project_id, conversation_id, strand_id,
             turn_id, scope_id, type, actor, visibility, causal_event_id,
             operation_id, payload_json, artifact_hash, created_at
      FROM events WHERE ${where} ORDER BY sequence
    `).all(...parameters) as EventRow[];
    return Promise.all(rows.map(async (row) => {
      const event = decodeEventRow(row);
      return { ...event, payload: await this.expandEventPayload(event) };
    }));
  }

  private async openArtifactText(projectId: string, hash: string) {
    const row = this.storage.database.prepare(`
      SELECT a.byte_length, a.media_type, a.storage_path
      FROM artifacts a
      WHERE a.hash = ? AND a.sensitivity <> 'private'
        AND EXISTS (
          SELECT 1 FROM events e
          WHERE e.project_id = ?
            AND (
              e.artifact_hash = a.hash
              OR EXISTS (
                SELECT 1 FROM json_tree(e.payload_json) linked
                WHERE linked.value = a.hash
                   OR linked.value = 'journal://artifact/' || a.hash
              )
            )
        )
    `).get(hash, projectId) as {
      byte_length: number; media_type: string; storage_path: string;
    } | undefined;
    if (!row) throw new Error(`Artifact ${hash} does not exist in this project.`);
    const bytes = await this.artifacts.read({
      hash,
      byteLength: row.byte_length,
      storagePath: row.storage_path,
    });
    if (bytes.includes(0)) {
      return canonicalJson({
        hash,
        mediaType: row.media_type,
        byteLength: row.byte_length,
        encoding: 'base64',
        content: bytes.toString('base64'),
      });
    }
    return bytes.toString('utf8');
  }

  async readThread(conversationId: string): Promise<ThreadDocumentView> {
    this.assertOpen();
    await this.writerTail;
    const row = this.storage.database.prepare(`
      SELECT d.document_id, d.head_version_id, v.content_artifact_hash
      FROM conversations c
      JOIN state_documents d
        ON d.conversation_id = c.conversation_id AND d.strand_id = c.head_strand_id
       AND d.scope_kind = 'strand' AND d.key = 'thread.md'
      JOIN document_versions v ON v.version_id = d.head_version_id
      WHERE c.conversation_id = ?
    `).get(conversationId) as {
      document_id: string;
      head_version_id: string;
      content_artifact_hash: string;
    } | undefined;
    if (!row) throw new Error(`Conversation ${conversationId} has no thread.md document.`);
    return {
      documentId: row.document_id,
      versionId: row.head_version_id,
      content: await this.readArtifactTextByHash(row.content_artifact_hash),
      ref: `journal://document-version/${encodeURIComponent(row.head_version_id)}`,
    };
  }

  async updateThread(
    handle: DurableTurnHandle,
    input: ThreadUpdateInput,
  ): Promise<ThreadDocumentView> {
    this.assertOpen();
    if (!input.baseVersionId.trim()) throw new TypeError('baseVersionId is required.');
    const bytes = Buffer.from(input.content, 'utf8');
    if (bytes.byteLength > 96 * 1024) {
      throw new TypeError('thread.md must not exceed 96 KiB.');
    }
    const artifact = await this.artifacts.put(bytes, 'text/markdown; charset=utf-8');
    const versionId = this.nextId('document-version');
    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      if (this.scopeIdentity(handle.scopeId).kind !== 'turn') {
        throw new Error('thread.md is parent-owned; return the work unit result first.');
      }
      const document = this.storage.database.prepare(`
        SELECT document_id, head_version_id
        FROM state_documents
        WHERE conversation_id = ? AND strand_id = ?
          AND scope_kind = 'strand' AND key = 'thread.md'
      `).get(handle.conversationId, handle.strandId) as {
        document_id: string;
        head_version_id: string;
      } | undefined;
      if (!document) throw new Error('The active strand has no thread.md document.');
      if (document.head_version_id !== input.baseVersionId) {
        throw new Error(
          `thread.md changed from ${input.baseVersionId} to ${document.head_version_id}; read it and retry.`,
        );
      }
      const ordinalRow = this.storage.database.prepare(`
        SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
        FROM document_versions WHERE document_id = ?
      `).get(document.document_id) as { ordinal: number };
      const ordinal = safeInteger(ordinalRow.ordinal, 'thread document ordinal');
      const recordedAt = safeTimestamp(this.now());
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'thread.document.updated',
        actor: 'model',
        visibility: 'internal',
        payload: {
          baseVersionId: input.baseVersionId,
          contentArtifactHash: artifact.hash,
          documentId: document.document_id,
          ordinal,
          versionId,
        },
        artifactHash: artifact.hash,
        createdAt: recordedAt,
      });
      this.insertArtifact(artifact, sequence, 'content');
      this.storage.database.prepare(`
        INSERT INTO document_versions (
          version_id, document_id, ordinal, parent_version_id,
          content_artifact_hash, based_on_turn_id, created_sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId,
        document.document_id,
        ordinal,
        document.head_version_id,
        artifact.hash,
        handle.turnId,
        sequence,
        recordedAt,
      );
      const updated = this.storage.database.prepare(`
        UPDATE state_documents
        SET head_version_id = ?, updated_sequence = ?, updated_at = ?
        WHERE document_id = ? AND head_version_id = ?
      `).run(versionId, sequence, recordedAt, document.document_id, input.baseVersionId);
      if (updated.changes !== 1) throw new Error('thread.md compare-and-swap failed.');
      this.indexJournalText({
        ref: `journal://document-version/${encodeURIComponent(versionId)}`,
        projectId: handle.projectId,
        conversationId: handle.conversationId,
        strandId: handle.strandId,
        turnId: handle.turnId,
        kind: 'thread-document',
        sequence,
        text: input.content,
      });
      return {
        documentId: document.document_id,
        versionId,
        content: input.content,
        ref: `journal://document-version/${encodeURIComponent(versionId)}`,
      };
    }));
  }

  async enterWorkUnit(handle: DurableTurnHandle, input: WorkUnitEnterInput) {
    this.assertOpen();
    const objective = input.objective.trim();
    if (!objective) throw new TypeError('A work unit objective is required.');
    if (Buffer.byteLength(objective, 'utf8') > 4 * 1024) {
      throw new TypeError('A work unit objective must not exceed 4 KiB.');
    }
    const evidenceRefs = [...new Set(input.evidenceRefs ?? [])];
    if (evidenceRefs.length > 8 || evidenceRefs.some((ref) => !ref.startsWith('journal://'))) {
      throw new TypeError('Work unit evidence must contain at most eight journal:// references.');
    }
    const orientation = await this.prepareText([
      'You are now inside a bounded Remux work unit.',
      `Objective: ${objective}`,
      evidenceRefs.length > 0 ? `Suggested evidence:\n${evidenceRefs.map((ref) => `- ${ref}`).join('\n')}` : '',
      'Keep reasoning and tool scratch local. Do not answer the user or update thread.md directly.',
      'When this objective is complete, call work_unit_return with the bounded result the parent needs.',
    ].filter(Boolean).join('\n\n'));
    const child: DurableTurnHandle = { ...handle, scopeId: this.nextId('scope') };
    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const parent = this.scopeIdentity(handle.scopeId);
      if (parent.kind !== 'turn' || parent.parent_scope_id !== null) {
        throw new Error('Work units cannot be nested.');
      }
      const runningChild = this.storage.database.prepare(`
        SELECT 1 FROM execution_scopes
        WHERE parent_scope_id = ? AND kind = 'work_unit' AND terminal_sequence IS NULL
      `).get(handle.scopeId);
      if (runningChild) throw new Error('A work unit is already active for this turn.');
      const recordedAt = safeTimestamp(this.now());
      const sequence = this.insertEvent({
        ...child,
        eventId: this.nextId('event'),
        type: 'work_unit.entered',
        actor: 'model',
        visibility: 'internal',
        payload: {
          evidenceRefs,
          objective,
          parentScopeId: handle.scopeId,
          scopeId: child.scopeId,
        },
        createdAt: recordedAt,
      });
      this.storage.database.prepare(`
        INSERT INTO execution_scopes (
          scope_id, project_id, conversation_id, strand_id, turn_id,
          parent_scope_id, kind, objective_json, state, created_sequence,
          terminal_sequence, result_artifact_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'work_unit', ?, 'running', ?, NULL, NULL, ?, ?)
      `).run(
        child.scopeId,
        child.projectId,
        child.conversationId,
        child.strandId,
        child.turnId,
        handle.scopeId,
        canonicalJson({ evidenceRefs, objective }),
        sequence,
        recordedAt,
        recordedAt,
      );
      this.indexJournalText({
        ref: `journal://scope/${encodeURIComponent(child.scopeId)}`,
        projectId: child.projectId,
        conversationId: child.conversationId,
        strandId: child.strandId,
        turnId: child.turnId,
        kind: 'work-unit-objective',
        sequence,
        text: objective,
      });
      const orientationSequence = this.insertEvent({
        ...child,
        eventId: this.nextId('event'),
        type: 'message.internal',
        actor: 'harness',
        visibility: 'internal',
        payload: { content: orientation.ref, kind: 'work_unit_orientation' },
        artifactHash: artifactHash(orientation.ref),
        createdAt: recordedAt,
      });
      this.insertArtifact(orientation.artifact, orientationSequence);
      return {
        handle: child,
        parentScopeId: handle.scopeId,
        objective,
        evidenceRefs,
      };
    }));
  }

  async returnWorkUnit(handle: DurableTurnHandle, input: { result: string }) {
    this.assertOpen();
    const result = input.result.trim();
    if (!result) throw new TypeError('A work unit result is required.');
    if (Buffer.byteLength(result, 'utf8') > 16 * 1024) {
      throw new TypeError('A work unit result must not exceed 16 KiB.');
    }
    const resultArtifact = await this.artifacts.put(
      Buffer.from(result, 'utf8'),
      'text/markdown; charset=utf-8',
    );
    const folded = await this.prepareText([
      'Active execution scope: parent turn. The child work unit is closed; do not call work_unit_return again.',
      `The bounded work unit returned from journal://scope/${encodeURIComponent(handle.scopeId)}.`,
      '',
      result,
      '',
      `Exact child evidence: journal://scope/${encodeURIComponent(handle.scopeId)}`,
    ].join('\n'));
    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const child = this.scopeIdentity(handle.scopeId);
      if (child.kind !== 'work_unit' || child.parent_scope_id === null) {
        throw new Error('No work unit is active.');
      }
      const parentHandle = { ...handle, scopeId: child.parent_scope_id };
      const parent = this.scopeIdentity(parentHandle.scopeId);
      if (parent.kind !== 'turn' || parent.state !== 'running') {
        throw new Error('The work unit parent is no longer running.');
      }
      const recordedAt = safeTimestamp(this.now());
      const terminalSequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'work_unit.returned',
        actor: 'model',
        visibility: 'internal',
        payload: {
          parentScopeId: parentHandle.scopeId,
          resultRef: `journal://artifact/${resultArtifact.hash}`,
          scopeId: handle.scopeId,
        },
        artifactHash: resultArtifact.hash,
        createdAt: recordedAt,
      });
      this.insertArtifact(resultArtifact, terminalSequence, 'content');
      this.storage.database.prepare(`
        UPDATE execution_scopes
        SET state = 'completed', terminal_sequence = ?, result_artifact_hash = ?, updated_at = ?
        WHERE scope_id = ? AND state = 'running' AND terminal_sequence IS NULL
      `).run(terminalSequence, resultArtifact.hash, recordedAt, handle.scopeId);
      this.indexJournalText({
        ref: `journal://artifact/${resultArtifact.hash}`,
        projectId: handle.projectId,
        conversationId: handle.conversationId,
        strandId: handle.strandId,
        turnId: handle.turnId,
        kind: 'work-unit-result',
        sequence: terminalSequence,
        text: result,
      });
      const foldedSequence = this.insertEvent({
        ...parentHandle,
        eventId: this.nextId('event'),
        type: 'message.internal',
        actor: 'harness',
        visibility: 'internal',
        payload: {
          childScopeId: handle.scopeId,
          content: folded.ref,
          kind: 'work_unit_result',
          resultRef: `journal://artifact/${resultArtifact.hash}`,
        },
        artifactHash: artifactHash(folded.ref),
        createdAt: recordedAt,
      });
      this.insertArtifact(folded.artifact, foldedSequence);
      return {
        parentHandle,
        result,
        resultRef: `journal://artifact/${resultArtifact.hash}`,
        scopeId: handle.scopeId,
      };
    }));
  }

  private contextIdentity(conversationId: string) {
    const row = this.storage.database.prepare(`
      SELECT c.project_id, c.head_strand_id, c.cwd
      FROM conversations c
      WHERE c.conversation_id = ?
    `).get(conversationId) as {
      project_id: string;
      head_strand_id: string;
      cwd: string;
    } | undefined;
    if (!row) throw new Error(`Conversation ${conversationId} has no context identity.`);
    return {
      projectId: row.project_id,
      strandId: row.head_strand_id,
      cwd: row.cwd,
    };
  }

  private activeScopeIdentity(conversationId: string) {
    const row = this.storage.database.prepare(`
      SELECT c.project_id, c.cwd, c.reasoning, t.turn_id, t.strand_id,
             t.root_scope_id, s.scope_id, s.parent_scope_id, s.kind,
             s.objective_json
      FROM conversations c
      JOIN turns t ON t.conversation_id = c.conversation_id
      JOIN execution_scopes s ON s.turn_id = t.turn_id
      WHERE c.conversation_id = ?
      ORDER BY (t.state = 'running') DESC, t.accepted_sequence DESC,
               (s.state = 'running') DESC,
               (s.kind = 'work_unit' AND s.state = 'running') DESC,
               (s.kind = 'turn') DESC, s.created_sequence DESC
      LIMIT 1
    `).get(conversationId) as {
      project_id: string;
      cwd: string;
      reasoning: string;
      turn_id: string;
      strand_id: string;
      root_scope_id: string;
      scope_id: string;
      parent_scope_id: string | null;
      kind: 'turn' | 'work_unit';
      objective_json: string;
    } | undefined;
    if (!row) throw new Error(`Conversation ${conversationId} has no active context boundary.`);
    return {
      projectId: row.project_id,
      cwd: row.cwd,
      reasoning: row.reasoning,
      turnId: row.turn_id,
      strandId: row.strand_id,
      rootScopeId: row.root_scope_id,
      scopeId: row.scope_id,
      parentScopeId: row.parent_scope_id,
      kind: row.kind,
      objective: JSON.parse(row.objective_json) as CanonicalJsonValue,
    };
  }

  private async assistantVisibleText(turnId: string) {
    const rows = this.storage.database.prepare(`
      SELECT sequence, event_id, project_id, conversation_id, strand_id,
             turn_id, scope_id, type, actor, visibility, causal_event_id,
             operation_id, payload_json, artifact_hash, created_at
      FROM events
      WHERE turn_id = ? AND type = 'assistant.checkpoint'
      ORDER BY sequence
    `).all(turnId) as EventRow[];
    const parts: string[] = [];
    for (const row of rows) {
      const event = decodeEventRow(row);
      const payload = await this.expandEventPayload(event) as Record<string, CanonicalJsonValue>;
      const text = payload.text ?? payload.textDelta ?? '';
      if (typeof text === 'string') parts.push(text);
    }
    return parts.join('');
  }

  private async expandEventPayload(event: AgentJournalEvent): Promise<CanonicalJsonValue> {
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      return event.payload;
    }
    const payload = event.payload as Record<string, CanonicalJsonValue>;
    if (event.type === 'message.user' || event.type === 'message.internal') {
      return { ...payload, content: await this.readTextRef(payload.content) };
    }
    if (event.type === 'assistant.checkpoint') {
      return {
        ...payload,
        reasoning: payload.reasoning === undefined ? payload.reasoningDelta ?? '' : await this.readTextRef(payload.reasoning),
        text: payload.text === undefined ? payload.textDelta ?? '' : await this.readTextRef(payload.text),
      };
    }
    if (event.type === 'tool.called' && payload.args !== undefined) {
      return { ...payload, args: normalizeJson(await this.readJsonRef(payload.args)) };
    }
    if (event.type === 'tool.completed' && payload.result !== undefined) {
      return { ...payload, result: normalizeJson(await this.readJsonRef(payload.result)) };
    }
    return payload;
  }

  async readEvents(options: { conversationId?: string; throughSequence?: number } = {}) {
    this.assertOpen();
    await this.writerTail;
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.conversationId) {
      conditions.push('conversation_id = ?');
      parameters.push(options.conversationId);
    }
    if (options.throughSequence !== undefined) {
      if (!Number.isSafeInteger(options.throughSequence) || options.throughSequence < 0) {
        throw new TypeError('throughSequence must be a nonnegative safe integer.');
      }
      conditions.push('sequence <= ?');
      parameters.push(options.throughSequence);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.storage.database.prepare(`
      SELECT sequence, event_id, project_id, conversation_id, strand_id,
             turn_id, scope_id, type, actor, visibility, causal_event_id,
             operation_id, payload_json, artifact_hash, created_at
      FROM events
      ${where}
      ORDER BY sequence
    `).all(...parameters) as EventRow[];
    return rows.map(decodeEventRow);
  }

  async journalHead() {
    this.assertOpen();
    await this.writerTail;
    const row = this.storage.database.prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events',
    ).get() as { sequence: number };
    return safeInteger(row.sequence, 'journal head');
  }

  async readResourceProjections(
    keys: readonly AgentResourceKey[],
  ): Promise<Array<DurableResourceProjection | null>> {
    this.assertOpen();
    await this.writerTail;
    const read = this.storage.database.prepare(`
      SELECT resource_key, basis_sequence, value_json
      FROM resources WHERE resource_key = ?
    `);
    return keys.map((key) => {
      if (
        key !== 'conversation-list' &&
        !key.startsWith('conversation:') &&
        !key.startsWith('context:') &&
        !key.startsWith('queue:')
      ) return null;
      const row = read.get(key) as {
        resource_key: string;
        basis_sequence: number;
        value_json: string;
      } | undefined;
      if (!row) return null;
      return {
        key: row.resource_key as DurableResourceProjection['key'],
        basisSequence: safeInteger(row.basis_sequence, 'resource basis sequence'),
        value: JSON.parse(row.value_json) as DurableResourceProjection['value'],
      };
    });
  }

  async rebuildConversationResources() {
    this.assertOpen();
    await this.writerTail;
    const rows = this.storage.database.prepare(`
      SELECT conversation_id, cwd, model_id, reasoning, state, created_at, updated_at
      FROM conversations ORDER BY conversation_id
    `).all() as ConversationProjectionRow[];
    const rebuilt: Array<{ summary: ConversationSummary; basisSequence: number }> = [];
    for (const row of rows) {
      const transcriptRows = this.storage.database.prepare(`
        SELECT turn_id, first_sequence, last_sequence, kind, value_json
        FROM transcript_items
        WHERE conversation_id = ? AND kind IN ('user', 'assistant')
        ORDER BY first_sequence, item_id
      `).all(row.conversation_id) as TranscriptProjectionRow[];
      const messages = transcriptRows.map((item): ConversationSummaryMessage => {
        const value = JSON.parse(item.value_json) as Record<string, unknown>;
        return item.kind === 'assistant'
          ? {
              role: 'assistant',
              text: assistantSummaryText(value),
              sequence: item.last_sequence,
              turnId: item.turn_id,
            }
          : {
              role: 'user',
              text: transcriptUserSummaryText(value),
              sequence: item.first_sequence,
              turnId: item.turn_id,
            };
      });
      rebuilt.push({
        summary: renderConversationSummary({
          ...conversationProjectionInput(row),
          latestTurn: this.latestTurn(row.conversation_id),
          messages,
        }),
        basisSequence: this.conversationResourceBasis(row.conversation_id),
      });
    }

    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.storage.database.prepare(`
        DELETE FROM resources
        WHERE resource_key = 'conversation-list' OR resource_key LIKE 'conversation:%'
      `).run();
      for (const entry of rebuilt) {
        this.upsertResource(
          conversationResourceKey(entry.summary.id),
          entry.basisSequence,
          entry.summary,
          entry.summary.updatedAt,
        );
        this.storage.database.prepare(`
          UPDATE conversations SET title = ? WHERE conversation_id = ?
        `).run(entry.summary.title, entry.summary.id);
      }
      this.refreshConversationList();
      return rebuilt.length;
    }));
  }

  close() {
    this.closePromise ??= this.drainAndClose();
    return this.closePromise;
  }

  private async drainAndClose() {
    await this.writerTail;
    this.storage.close();
  }

  private enqueueTurnTransaction(
    params: AcceptTurnParams,
    input: PreparedUserInput,
    argumentsHash: string,
  ): QueueTurnResult {
    const replay = this.readQueuedReplay(params, argumentsHash);
    if (replay) return replay;
    return this.storage.transaction(() => {
      const insideReplay = this.readQueuedReplay(params, argumentsHash);
      if (insideReplay) return insideReplay;
      const conversation = this.storage.database.prepare(`
        SELECT project_id, head_strand_id FROM conversations WHERE conversation_id = ?
      `).get(params.conversationId) as { project_id: string; head_strand_id: string } | undefined;
      if (!conversation) throw new Error(`Conversation ${params.conversationId} does not exist.`);
      const duplicateClient = this.storage.database.prepare(`
        SELECT operation_id FROM operations
        WHERE conversation_id = ? AND kind = 'message.queue'
          AND json_extract(value_json, '$.clientMessageId') = ?
        LIMIT 1
      `).get(params.conversationId, params.clientMessageId) as { operation_id: string } | undefined;
      if (duplicateClient) throw new ClientMessageConflictError(params.clientMessageId);
      const recordedAt = safeTimestamp(this.now());
      const acceptedSequence = this.insertEvent({
        eventId: this.nextId('event'),
        projectId: conversation.project_id,
        conversationId: params.conversationId,
        strandId: conversation.head_strand_id,
        operationId: params.operationId,
        type: 'operation.accepted',
        actor: 'harness',
        visibility: 'internal',
        payload: { argumentsHash, kind: 'message.queue' },
        createdAt: recordedAt,
      });
      for (const artifact of input.artifacts) this.insertArtifact(artifact, acceptedSequence);
      const value = {
        attachmentCount: input.parts?.filter((part) => part.type === 'image').length ?? 0,
        clientMessageId: params.clientMessageId,
        content: input.content.ref,
        dispatchOperationId: this.nextId('operation'),
        mentionCount: input.parts?.filter((part) => part.type === 'mention').length ?? 0,
        ...(input.parts ? { parts: input.parts } : {}),
        preview: truncateSummaryText(params.text),
      };
      this.storage.database.prepare(`
        INSERT INTO operations (
          operation_id, project_id, conversation_id, strand_id, turn_id,
          scope_id, kind, arguments_hash, state, accepted_sequence,
          terminal_sequence, result_artifact_hash, value_json
        ) VALUES (?, ?, ?, ?, NULL, NULL, 'message.queue', ?, 'queued', ?, NULL, NULL, ?)
      `).run(
        params.operationId,
        conversation.project_id,
        params.conversationId,
        conversation.head_strand_id,
        argumentsHash,
        acceptedSequence,
        canonicalJson(value),
      );
      this.refreshQueueResource(params.conversationId, acceptedSequence, recordedAt);
      return {
        accepted: true,
        delivery: 'queued',
        operationId: params.operationId,
        replayed: false,
        turnId: null,
      };
    });
  }

  private readQueuedReplay(params: AcceptTurnParams, argumentsHash: string): QueueTurnResult | null {
    const row = this.storage.database.prepare(`
      SELECT kind, arguments_hash, state, value_json
      FROM operations WHERE operation_id = ?
    `).get(params.operationId) as {
      kind: string;
      arguments_hash: string;
      state: string;
      value_json: string;
    } | undefined;
    if (!row) return null;
    if (row.kind !== 'message.queue') return null;
    if (row.arguments_hash !== argumentsHash) {
      throw new OperationConflictError(params.operationId);
    }
    const value = parseQueuedOperationValue(row.value_json);
    if (value.clientMessageId !== params.clientMessageId) {
      throw new OperationConflictError(params.operationId);
    }
    return {
      accepted: true,
      delivery: row.state === 'succeeded' ? 'sent' : 'queued',
      operationId: params.operationId,
      replayed: true,
      turnId: row.state === 'succeeded' ? value.turnId ?? null : null,
    };
  }

  private finishQueuedTurnTransaction(operationId: string, turnId: string) {
    return this.storage.transaction(() => {
      const row = this.queuedOperationIdentity(operationId);
      if (!row || row.state === 'succeeded') return false;
      if (row.state !== 'queued') return false;
      const recordedAt = safeTimestamp(this.now());
      const sequence = this.insertEvent({
        eventId: this.nextId('event'),
        projectId: row.project_id,
        conversationId: row.conversation_id,
        strandId: row.strand_id,
        operationId,
        type: 'operation.succeeded',
        payload: { kind: 'message.queue', result: { turnId } },
        createdAt: recordedAt,
      });
      const value = { ...parseQueuedOperationValue(row.value_json), turnId };
      this.storage.database.prepare(`
        UPDATE operations SET state = 'succeeded', terminal_sequence = ?, value_json = ?
        WHERE operation_id = ?
      `).run(sequence, canonicalJson(value), operationId);
      this.refreshQueueResource(row.conversation_id, sequence, recordedAt);
      return true;
    });
  }

  private removeQueuedTurnTransaction(conversationId: string, operationId: string) {
    return this.storage.transaction(() => {
      const row = this.queuedOperationIdentity(operationId);
      if (!row || row.conversation_id !== conversationId || row.state !== 'queued') return false;
      const recordedAt = safeTimestamp(this.now());
      const sequence = this.insertEvent({
        eventId: this.nextId('event'),
        projectId: row.project_id,
        conversationId,
        strandId: row.strand_id,
        operationId,
        type: 'operation.failed',
        payload: { kind: 'message.queue', reason: 'removed' },
        createdAt: recordedAt,
      });
      this.storage.database.prepare(`
        UPDATE operations SET state = 'removed', terminal_sequence = ? WHERE operation_id = ?
      `).run(sequence, operationId);
      this.refreshQueueResource(conversationId, sequence, recordedAt);
      return true;
    });
  }

  private queuedOperationIdentity(operationId: string) {
    return this.storage.database.prepare(`
      SELECT project_id, conversation_id, strand_id, state, value_json
      FROM operations WHERE operation_id = ? AND kind = 'message.queue'
    `).get(operationId) as {
      project_id: string;
      conversation_id: string;
      strand_id: string;
      state: string;
      value_json: string;
    } | undefined;
  }

  private refreshQueueResource(conversationId: string, basisSequence: number, updatedAt: number) {
    const rows = this.storage.database.prepare(`
      SELECT o.operation_id, o.value_json, e.created_at
      FROM operations o
      JOIN events e ON e.sequence = o.accepted_sequence
      WHERE o.conversation_id = ? AND o.kind = 'message.queue' AND o.state = 'queued'
      ORDER BY o.accepted_sequence, o.operation_id
    `).all(conversationId) as Array<{ operation_id: string; value_json: string; created_at: number }>;
    this.upsertResource(queueResourceKey(conversationId), basisSequence, {
      conversationId,
      entries: rows.map((row) => {
        const value = parseQueuedOperationValue(row.value_json);
        return {
          attachmentCount: value.attachmentCount,
          createdAt: safeTimestamp(row.created_at),
          id: row.operation_id,
          mentionCount: value.mentionCount,
          text: value.preview,
        };
      }),
    }, updatedAt);
  }

  private acceptTurnTransaction(
    params: AcceptTurnParams,
    input: PreparedUserInput,
    argumentsHash: string,
  ): AcceptTurnResult {
    const replay = this.readTurnReplay(params, argumentsHash);
    if (replay) return replay;

    return this.storage.transaction(() => {
      const insideReplay = this.readTurnReplay(params, argumentsHash);
      if (insideReplay) return insideReplay;
      const conversation = this.storage.database.prepare(`
        SELECT c.project_id, c.head_strand_id, c.state,
               d.head_version_id AS thread_version_id
        FROM conversations c
        JOIN state_documents d
          ON d.conversation_id = c.conversation_id
         AND d.strand_id = c.head_strand_id
         AND d.scope_kind = 'strand' AND d.key = 'thread.md'
        WHERE c.conversation_id = ?
      `).get(params.conversationId) as {
        project_id: string;
        head_strand_id: string;
        state: string;
        thread_version_id: string;
      } | undefined;
      if (!conversation) throw new Error(`Conversation ${params.conversationId} does not exist.`);
      if (conversation.state === 'running') throw new Error('A durable turn is already running.');

      const handle: DurableTurnHandle = {
        projectId: conversation.project_id,
        conversationId: params.conversationId,
        strandId: conversation.head_strand_id,
        turnId: this.nextId('turn'),
        scopeId: this.nextId('scope'),
      };
      const operationId = params.operationId;
      const recordedAt = safeTimestamp(this.now());
      const acceptedOperationSequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        operationId,
        type: 'operation.accepted',
        actor: 'harness',
        visibility: 'internal',
        payload: { argumentsHash, kind: SEND_MESSAGE_KIND },
        createdAt: recordedAt,
      });
      const acceptedTurnSequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        operationId,
        type: 'turn.accepted',
        actor: 'harness',
        visibility: 'internal',
        payload: {
          clientMessageId: params.clientMessageId,
          rootScopeId: handle.scopeId,
          turnId: handle.turnId,
        },
        createdAt: recordedAt,
      });
      const scopeSequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        operationId,
        type: 'execution_scope.created',
        actor: 'harness',
        visibility: 'internal',
        payload: {
          kind: 'turn',
          parentScopeId: null,
          scopeId: handle.scopeId,
          turnId: handle.turnId,
        },
        createdAt: recordedAt,
      });
      // The canonical message content already carries all text. Keep only the
      // structured non-text parts in the event so a large composer document
      // cannot overflow the bounded event envelope. The transcript item below
      // retains the complete ordered part list for rendering and branching.
      const eventParts = input.parts?.filter((part) => part.type !== 'text');
      const messageSequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        operationId,
        type: 'message.user',
        actor: 'user',
        visibility: 'transcript',
        payload: {
          clientMessageId: params.clientMessageId,
          content: input.content.ref,
          ...(eventParts?.length ? { parts: eventParts as unknown as CanonicalJsonValue } : {}),
        },
        artifactHash: artifactHash(input.content.ref),
        createdAt: recordedAt,
      });
      for (const artifact of input.artifacts) this.insertArtifact(artifact, messageSequence);
      this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        operationId,
        type: 'turn.started',
        actor: 'harness',
        visibility: 'internal',
        payload: {
          scopeId: handle.scopeId,
          threadVersionId: conversation.thread_version_id,
          turnId: handle.turnId,
        },
        createdAt: recordedAt,
      });
      const outcome = { accepted: true as const, operationId, turnId: handle.turnId };
      const terminalOperationSequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        operationId,
        type: 'operation.succeeded',
        actor: 'harness',
        visibility: 'internal',
        payload: { kind: SEND_MESSAGE_KIND, result: outcome },
        createdAt: recordedAt,
      });

      this.storage.database.prepare(`
        INSERT INTO turns (
          turn_id, project_id, conversation_id, strand_id, client_message_id,
          root_scope_id, state, accepted_sequence, terminal_sequence,
          thread_version_before, thread_version_after,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, NULL, ?, NULL, ?, ?)
      `).run(
        handle.turnId,
        handle.projectId,
        handle.conversationId,
        handle.strandId,
        params.clientMessageId,
        handle.scopeId,
        acceptedTurnSequence,
        conversation.thread_version_id,
        recordedAt,
        recordedAt,
      );
      this.storage.database.prepare(`
        INSERT INTO execution_scopes (
          scope_id, project_id, conversation_id, strand_id, turn_id,
          parent_scope_id, kind, objective_json, state, created_sequence,
          terminal_sequence, result_artifact_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'turn', ?, 'running', ?, NULL, NULL, ?, ?)
      `).run(
        handle.scopeId,
        handle.projectId,
        handle.conversationId,
        handle.strandId,
        handle.turnId,
        canonicalJson({ intent: 'Serve the accepted user turn.' }),
        scopeSequence,
        recordedAt,
        recordedAt,
      );
      const userItemId = this.nextId('item');
      const userMessageId = this.nextId('message');
      this.storage.database.prepare(`
        INSERT INTO messages (
          message_id, project_id, conversation_id, strand_id, turn_id,
          scope_id, ordinal, role, visibility, state, content_artifact_hash,
          provider_item_id, created_sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 'user', 'transcript', 'completed', ?, NULL, ?, ?)
      `).run(
        userMessageId,
        handle.projectId,
        handle.conversationId,
        handle.strandId,
        handle.turnId,
        handle.scopeId,
        input.messageArtifact.hash,
        messageSequence,
        recordedAt,
      );
      this.indexJournalText({
        ref: `journal://message/${encodeURIComponent(userMessageId)}`,
        projectId: handle.projectId,
        conversationId: handle.conversationId,
        strandId: handle.strandId,
        turnId: handle.turnId,
        kind: 'user-message',
        sequence: messageSequence,
        text: input.content.text,
      });
      this.storage.database.prepare(`
        INSERT INTO transcript_items (
          item_id, conversation_id, strand_id, turn_id, first_sequence,
          last_sequence, kind, status, value_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'user', 'completed', ?)
      `).run(
        userItemId,
        handle.conversationId,
        handle.strandId,
        handle.turnId,
        messageSequence,
        messageSequence,
        canonicalJson({
          clientMessageId: params.clientMessageId,
          content: input.content.ref,
          ...(input.parts ? { parts: input.parts } : {}),
          summaryText: truncateSummaryText(params.text),
        }),
      );
      this.storage.database.prepare(`
        INSERT INTO operations (
          operation_id, project_id, conversation_id, strand_id, turn_id,
          scope_id, kind, arguments_hash, state, accepted_sequence,
          terminal_sequence, result_artifact_hash, value_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, NULL, ?)
      `).run(
        operationId,
        handle.projectId,
        handle.conversationId,
        handle.strandId,
        handle.turnId,
        handle.scopeId,
        SEND_MESSAGE_KIND,
        argumentsHash,
        acceptedOperationSequence,
        terminalOperationSequence,
        canonicalJson(outcome),
      );
      this.storage.database.prepare(`
        UPDATE conversations SET state = 'running', updated_at = ?
        WHERE conversation_id = ?
      `).run(recordedAt, handle.conversationId);
      const summary = this.refreshConversationResources(
        handle.conversationId,
        terminalOperationSequence,
        {
          role: 'user',
          text: params.text,
          sequence: messageSequence,
          turnId: handle.turnId,
        },
      );
      this.storage.database.prepare(`
        UPDATE conversations SET title = ? WHERE conversation_id = ?
      `).run(summary.title, handle.conversationId);

      const userProjection = preparedTextProjection(input.content, MAX_VISIBLE_TEXT_BYTES);

      return {
        ...handle,
        accepted: true,
        operationId,
        clientMessageId: params.clientMessageId,
        basisSequence: terminalOperationSequence,
        transcriptSequence: messageSequence,
        transcriptCreatedAt: recordedAt,
        userItemId,
        ...(userProjection.content ? { userContent: userProjection.content } : {}),
        ...(input.parts ? { userParts: input.parts } : {}),
        replayed: false,
      };
    });
  }

  private readTurnReplay(params: AcceptTurnParams, argumentsHash: string): AcceptTurnResult | null {
    const operationIdentity = this.storage.database.prepare(`
      SELECT kind, arguments_hash
      FROM operations
      WHERE operation_id = ?
    `).get(params.operationId) as {
      kind: string;
      arguments_hash: string;
    } | undefined;
    if (
      operationIdentity &&
      (operationIdentity.kind !== SEND_MESSAGE_KIND ||
        operationIdentity.arguments_hash !== argumentsHash)
    ) {
      throw new OperationConflictError(params.operationId);
    }
    const operationRow = this.storage.database.prepare(`
      SELECT t.project_id, t.conversation_id, t.strand_id, t.turn_id,
             t.root_scope_id, t.client_message_id, o.kind,
             o.arguments_hash, o.terminal_sequence, ti.first_sequence,
             ti.item_id, message.created_at AS transcript_created_at
      FROM operations o
      JOIN turns t ON t.turn_id = o.turn_id
      JOIN transcript_items ti ON ti.turn_id = t.turn_id AND ti.kind = 'user'
      JOIN events message ON message.sequence = ti.first_sequence
      WHERE o.operation_id = ?
    `).get(params.operationId) as {
      project_id: string;
      conversation_id: string;
      strand_id: string;
      turn_id: string;
      root_scope_id: string;
      client_message_id: string;
      kind: string;
      arguments_hash: string;
      terminal_sequence: number;
      first_sequence: number;
      item_id: string;
      transcript_created_at: number;
    } | undefined;
    if (operationIdentity && !operationRow) {
      throw new Error(`Operation ${params.operationId} has no replayable durable turn outcome.`);
    }
    if (operationRow) {
      if (
        operationRow.kind !== SEND_MESSAGE_KIND ||
        operationRow.conversation_id !== params.conversationId ||
        operationRow.client_message_id !== params.clientMessageId ||
        operationRow.arguments_hash !== argumentsHash
      ) {
        throw new OperationConflictError(params.operationId);
      }
      return this.turnReplayResult(operationRow, params);
    }

    const messageRow = this.storage.database.prepare(`
      SELECT o.operation_id
      FROM turns t
      JOIN operations o ON o.turn_id = t.turn_id AND o.kind = ?
      WHERE t.conversation_id = ? AND t.client_message_id = ?
    `).get(SEND_MESSAGE_KIND, params.conversationId, params.clientMessageId) as {
      operation_id: string;
    } | undefined;
    if (messageRow) throw new ClientMessageConflictError(params.clientMessageId);
    return null;
  }

  private turnReplayResult(
    row: {
      project_id: string;
      conversation_id: string;
      strand_id: string;
      turn_id: string;
      root_scope_id: string;
      terminal_sequence: number;
      first_sequence: number;
      item_id: string;
      transcript_created_at: number;
    },
    params: AcceptTurnParams,
  ): AcceptTurnResult {
    return {
      accepted: true,
      operationId: params.operationId,
      projectId: row.project_id,
      conversationId: row.conversation_id,
      strandId: row.strand_id,
      turnId: row.turn_id,
      scopeId: row.root_scope_id,
      clientMessageId: params.clientMessageId,
      basisSequence: safeInteger(row.terminal_sequence, 'operation terminal sequence'),
      transcriptSequence: safeInteger(row.first_sequence, 'user transcript sequence'),
      transcriptCreatedAt: safeTimestamp(row.transcript_created_at),
      userItemId: row.item_id,
      replayed: true,
    };
  }

  private createConversationTransaction(
    params: CreateConversationParams,
    argumentsHash: string,
    initialThread: StagedArtifact,
    initialThreadContent: string,
    inheritedThreadVersionId: string | null,
  ): CreateConversationResult {
    const replay = this.readCreateReplay(params.operationId, argumentsHash);
    if (replay) return replay;

    return this.storage.transaction(() => {
      const insideReplay = this.readCreateReplay(params.operationId, argumentsHash);
      if (insideReplay) return insideReplay;

      const existingProject = this.storage.database.prepare(`
        SELECT project_id
        FROM projects
        WHERE root_path = ?
      `).get(params.cwd) as ProjectRow | undefined;
      const projectId = existingProject?.project_id ?? this.nextId('project');
      const conversationId = this.nextId('conversation');
      const rootStrandId = this.nextId('strand');
      const threadDocumentId = this.nextId('document');
      const threadVersionId = this.nextId('document-version');
      const recordedAt = safeTimestamp(this.now());
      const outcome: StoredCreateOutcome = {
        accepted: true,
        operationId: params.operationId,
        projectId,
        conversationId,
        threadDocumentId,
        threadVersionId,
      };

      const acceptedSequence = this.insertEvent({
        eventId: this.nextId('event'),
        projectId,
        conversationId,
        strandId: rootStrandId,
        operationId: params.operationId,
        type: 'operation.accepted',
        payload: { argumentsHash, kind: CREATE_CONVERSATION_KIND },
        createdAt: recordedAt,
      });
      let projectSequence: number | null = null;
      if (!existingProject) {
        projectSequence = this.insertEvent({
          eventId: this.nextId('event'),
          projectId,
          conversationId,
          strandId: rootStrandId,
          operationId: params.operationId,
          type: 'project.created',
          payload: {
            projectId,
            rootPath: params.cwd,
            state: 'active',
            title: projectTitle(params.cwd),
          },
          createdAt: recordedAt,
        });
      }
      const conversationSequence = this.insertEvent({
        eventId: this.nextId('event'),
        projectId,
        conversationId,
        strandId: rootStrandId,
        operationId: params.operationId,
        type: 'conversation.created',
        payload: {
          conversationId,
          cwd: params.cwd,
          forkedFromSequence: null,
          headStrandId: rootStrandId,
          modelId: params.modelId,
          parentStrandId: null,
          projectId,
          reasoning: params.reasoning,
          state: 'idle',
          strandState: 'active',
          threadDocumentId,
          threadVersionId,
          inheritedThreadVersionId,
          title: INITIAL_TITLE,
        },
        artifactHash: initialThread.hash,
        createdAt: recordedAt,
      });
      const terminalSequence = this.insertEvent({
        eventId: this.nextId('event'),
        projectId,
        conversationId,
        strandId: rootStrandId,
        operationId: params.operationId,
        type: 'operation.succeeded',
        payload: { kind: CREATE_CONVERSATION_KIND, result: outcome },
        createdAt: recordedAt,
      });

      if (projectSequence !== null) {
        const title = projectTitle(params.cwd);
        this.storage.database.prepare(`
          INSERT INTO projects (
            project_id, root_path, title, state,
            created_sequence, updated_sequence, created_at, updated_at
          ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
        `).run(
          projectId,
          params.cwd,
          title,
          projectSequence,
          projectSequence,
          recordedAt,
          recordedAt,
        );
      } else {
        this.storage.database.prepare(`
          UPDATE projects SET updated_sequence = ?, updated_at = ? WHERE project_id = ?
        `).run(conversationSequence, recordedAt, projectId);
      }
      this.storage.database.prepare(`
        INSERT INTO conversations (
          conversation_id, project_id, title, cwd, model_id, reasoning,
          head_strand_id, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        conversationId,
        projectId,
        INITIAL_TITLE,
        params.cwd,
        params.modelId,
        params.reasoning,
        rootStrandId,
        'idle',
        recordedAt,
        recordedAt,
      );
      this.storage.database.prepare(`
        INSERT INTO strands (
          strand_id, conversation_id, parent_strand_id, forked_from_sequence,
          state, created_at
        ) VALUES (?, ?, NULL, NULL, ?, ?)
      `).run(rootStrandId, conversationId, 'active', recordedAt);
      this.storage.database.prepare(`
        INSERT INTO state_documents (
          document_id, project_id, conversation_id, strand_id, scope_kind,
          key, head_version_id, created_sequence, updated_sequence,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'strand', 'thread.md', NULL, ?, ?, ?, ?)
      `).run(
        threadDocumentId,
        projectId,
        conversationId,
        rootStrandId,
        conversationSequence,
        conversationSequence,
        recordedAt,
        recordedAt,
      );
      this.insertArtifact(initialThread, conversationSequence, 'content');
      this.storage.database.prepare(`
        INSERT INTO document_versions (
          version_id, document_id, ordinal, parent_version_id,
          content_artifact_hash, based_on_turn_id, created_sequence, created_at
        ) VALUES (?, ?, 0, NULL, ?, NULL, ?, ?)
      `).run(threadVersionId, threadDocumentId, initialThread.hash, conversationSequence, recordedAt);
      this.storage.database.prepare(`
        UPDATE state_documents SET head_version_id = ? WHERE document_id = ?
      `).run(threadVersionId, threadDocumentId);
      this.indexJournalText({
        ref: `journal://document-version/${encodeURIComponent(threadVersionId)}`,
        projectId,
        conversationId,
        strandId: rootStrandId,
        kind: 'thread-document',
        sequence: conversationSequence,
        text: initialThreadContent,
      });
      this.storage.database.prepare(`
        INSERT INTO operations (
          operation_id, project_id, conversation_id, strand_id, turn_id,
          scope_id, kind, arguments_hash, state, accepted_sequence,
          terminal_sequence, result_artifact_hash, value_json
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?)
      `).run(
        params.operationId,
        projectId,
        conversationId,
        rootStrandId,
        CREATE_CONVERSATION_KIND,
        argumentsHash,
        'succeeded',
        acceptedSequence,
        terminalSequence,
        canonicalJson(outcome),
      );
      this.refreshConversationResources(conversationId, terminalSequence);

      return {
        ...outcome,
        rootStrandId,
        basisSequence: terminalSequence,
        replayed: false,
      };
    });
  }

  private async readInheritedThread(
    source: NonNullable<CreateConversationParams['inheritThreadFrom']>,
  ) {
    await this.writerTail;
    const column = source.position === 'before' ? 'thread_version_before' : 'thread_version_after';
    const row = this.storage.database.prepare(`
      SELECT t.${column} AS version_id, v.content_artifact_hash
      FROM turns t
      JOIN document_versions v ON v.version_id = t.${column}
      WHERE t.conversation_id = ? AND t.turn_id = ?
        AND t.terminal_sequence IS NOT NULL
    `).get(source.conversationId, source.turnId) as {
      version_id: string;
      content_artifact_hash: string;
    } | undefined;
    if (!row) {
      throw new Error(
        `Cannot inherit thread.md ${source.position} turn ${source.turnId} in ${source.conversationId}.`,
      );
    }
    return {
      versionId: row.version_id,
      content: await this.readArtifactTextByHash(row.content_artifact_hash),
    };
  }

  private readCreateReplay(operationId: string, argumentsHash: string): CreateConversationResult | null {
    const row = this.storage.database.prepare(`
      SELECT o.kind, o.arguments_hash, o.state, o.terminal_sequence,
             o.value_json, o.project_id, o.conversation_id, o.strand_id,
             d.document_id AS thread_document_id,
             d.head_version_id AS thread_version_id
      FROM operations o
      JOIN state_documents d
        ON d.conversation_id = o.conversation_id AND d.strand_id = o.strand_id
       AND d.scope_kind = 'strand' AND d.key = 'thread.md'
      WHERE o.operation_id = ?
    `).get(operationId) as OperationReplayRow | undefined;
    if (!row) return null;
    if (row.kind !== CREATE_CONVERSATION_KIND || row.arguments_hash !== argumentsHash) {
      throw new OperationConflictError(operationId);
    }
    if (row.state !== 'succeeded' || row.terminal_sequence === null) {
      throw new Error(`Operation ${operationId} has no replayable durable outcome.`);
    }
    const outcome = decodeStoredOutcome(
      row.value_json,
      operationId,
      row.project_id,
      row.conversation_id,
      row.thread_document_id,
      row.thread_version_id,
    );
    return {
      ...outcome,
      rootStrandId: row.strand_id,
      basisSequence: safeInteger(row.terminal_sequence, 'operation terminal sequence'),
      replayed: true,
    };
  }

  private async recoverInterruptedTurns() {
    this.assertOpen();
    const rows = this.storage.database.prepare(`
      SELECT i.inference_id, i.project_id, i.conversation_id, i.strand_id,
             i.turn_id, i.scope_id
      FROM inferences i
      JOIN turns t ON t.turn_id = i.turn_id
      WHERE i.state = 'running' AND t.terminal_sequence IS NULL
      ORDER BY i.started_sequence
    `).all() as Array<{
      inference_id: string; project_id: string; conversation_id: string;
      strand_id: string; turn_id: string; scope_id: string;
    }>;
    for (const row of rows) {
      await this.enqueueWrite(() => this.storage.transaction(() => {
        const recordedAt = safeTimestamp(this.now());
        const sequence = this.insertEvent({
          eventId: this.nextId('event'),
          projectId: row.project_id,
          conversationId: row.conversation_id,
          strandId: row.strand_id,
          turnId: row.turn_id,
          scopeId: row.scope_id,
          type: 'inference.interrupted',
          actor: 'harness',
          visibility: 'internal',
          payload: { inferenceId: row.inference_id, reason: 'process_restart' },
          createdAt: recordedAt,
        });
        this.storage.database.prepare(`
          UPDATE inferences SET state = 'interrupted', terminal_sequence = ?
          WHERE inference_id = ? AND state = 'running'
        `).run(sequence, row.inference_id);
      }));
    }
  }

  private async prepareTurnFinalization(
    handle: DurableTurnHandle,
    status: DurableTurnStatus,
    error: string | null,
    assistant: PreparedAssistantProjection | null,
  ): Promise<PreparedTurnFinalization> {
    const assistantMessageId = assistant ? this.nextId('message') : null;
    const assistantMessageArtifact = assistant
      ? await this.artifacts.put(
          Buffer.from(canonicalJson({ role: 'assistant', state: status, text: assistant.text }), 'utf8'),
          'application/vnd.remux.message+json',
        )
      : null;
    return { assistantMessageArtifact, assistantMessageId };
  }

  private async prepareAssistantProjection(
    turnId: string,
  ): Promise<PreparedAssistantProjection | null> {
    const item = this.storage.database.prepare(`
      SELECT item_id FROM transcript_items
      WHERE turn_id = ? AND kind = 'assistant'
    `).get(turnId) as { item_id: string } | undefined;
    if (!item) return null;
    const rows = this.storage.database.prepare(`
      SELECT sequence, type, payload_json
      FROM events
      WHERE turn_id = ? AND visibility = 'transcript'
        AND type IN ('assistant.checkpoint', 'tool.called')
      ORDER BY sequence
    `).all(turnId) as Array<{
      sequence: number;
      type: string;
      payload_json: string;
    }>;
    const textParts: string[] = [];
    let textFirstSequence: number | null = null;
    let textLastSequence: number | null = null;
    const reasoningRuns: Array<{
      firstSequence: number;
      lastSequence: number;
      parts: string[];
    }> = [];
    let activeReasoningRun: typeof reasoningRuns[number] | null = null;
    for (const row of rows) {
      if (row.type === 'tool.called') {
        activeReasoningRun = null;
        continue;
      }
      const payload = JSON.parse(row.payload_json) as Record<string, CanonicalJsonValue>;
      const textDelta = payload.textDelta === undefined
        ? await this.readTextRef(payload.text)
        : requiredString(payload.textDelta, 'textDelta');
      const reasoningDelta = payload.reasoningDelta === undefined
        ? await this.readTextRef(payload.reasoning)
        : requiredString(payload.reasoningDelta, 'reasoningDelta');
      if (textDelta) {
        textFirstSequence ??= safeInteger(row.sequence, 'assistant text first sequence');
        textLastSequence = safeInteger(row.sequence, 'assistant text last sequence');
        textParts.push(textDelta);
      }
      if (reasoningDelta) {
        activeReasoningRun ??= {
          firstSequence: safeInteger(row.sequence, 'assistant reasoning first sequence'),
          lastSequence: safeInteger(row.sequence, 'assistant reasoning last sequence'),
          parts: [],
        };
        activeReasoningRun.lastSequence = safeInteger(
          row.sequence,
          'assistant reasoning last sequence',
        );
        activeReasoningRun.parts.push(reasoningDelta);
        if (!reasoningRuns.includes(activeReasoningRun)) reasoningRuns.push(activeReasoningRun);
      }
    }

    const text = textParts.join('');
    const preparedText = text ? await this.prepareText(text) : null;
    const preparedReasoning = await Promise.all(reasoningRuns.map(async (run) => ({
      ...run,
      prepared: await this.prepareText(run.parts.join('')),
    })));
    const artifacts = [
      preparedText?.artifact ?? null,
      ...preparedReasoning.map((run) => run.prepared.artifact),
    ].filter((artifact): artifact is StagedArtifact => artifact !== null);
    return {
      artifacts: uniqueArtifacts(artifacts),
      itemId: item.item_id,
      text,
      valueJson: canonicalJson({
        reasoningRuns: preparedReasoning.map((run) => ({
          content: run.prepared.ref,
          firstSequence: run.firstSequence,
          lastSequence: run.lastSequence,
        })),
        summaryText: truncateSummaryText(text),
        text: preparedText && textFirstSequence !== null && textLastSequence !== null
          ? {
              content: preparedText.ref,
              firstSequence: textFirstSequence,
              lastSequence: textLastSequence,
            }
          : null,
        version: 2,
      }),
    };
  }

  private async upgradeLegacyAssistantProjections() {
    const rows = this.storage.database.prepare(`
      SELECT ti.item_id, ti.turn_id, ti.value_json, t.terminal_sequence
      FROM transcript_items ti
      JOIN turns t ON t.turn_id = ti.turn_id
      WHERE ti.kind = 'assistant' AND t.terminal_sequence IS NOT NULL
      ORDER BY ti.first_sequence, ti.item_id
    `).all() as Array<{
      item_id: string;
      turn_id: string;
      value_json: string;
      terminal_sequence: number;
    }>;
    for (const row of rows) {
      if (parseFinalAssistantProjection(row.value_json)) continue;
      const prepared = await this.prepareAssistantProjection(row.turn_id);
      if (!prepared || prepared.itemId !== row.item_id) {
        throw new Error(`Assistant projection ${row.item_id} could not be rebuilt.`);
      }
      await this.enqueueWrite(() => this.storage.transaction(() => {
        const sequence = safeInteger(row.terminal_sequence, 'turn terminal sequence');
        for (const artifact of prepared.artifacts) this.insertArtifact(artifact, sequence);
        this.storage.database.prepare(`
          UPDATE transcript_items SET value_json = ? WHERE item_id = ?
        `).run(prepared.valueJson, row.item_id);
      }));
    }
  }

  private async validateArtifactMetadata() {
    for (const row of this.artifactRows()) {
      await this.artifacts.validateMetadata({
        hash: row.hash,
        byteLength: row.byte_length,
        storagePath: row.storage_path,
      });
    }
  }

  private artifactRows() {
    return this.storage.database.prepare(`
      SELECT hash, byte_length, storage_path FROM artifacts ORDER BY hash
    `).all() as Array<{ hash: string; byte_length: number; storage_path: string }>;
  }

  private async findArtifactOrphans() {
    const referenced = new Set((this.storage.database.prepare(`
      SELECT storage_path FROM artifacts ORDER BY storage_path
    `).all() as Array<{ storage_path: string }>).map(({ storage_path }) => storage_path));
    return (await this.artifacts.listInstalledStoragePaths())
      .filter((storagePath) => !referenced.has(storagePath));
  }

  private finishTurnTransaction(
    handle: DurableTurnHandle,
    status: DurableTurnStatus,
    error: string | null,
    errorCode: DurableTurnErrorCode | null,
    durationMs: number | undefined,
    assistant: PreparedAssistantProjection | null,
    finalization: PreparedTurnFinalization,
  ) {
    return this.storage.transaction(() => {
      const row = this.storage.database.prepare(`
        SELECT state, terminal_sequence, created_at
        FROM turns
        WHERE project_id = ? AND conversation_id = ? AND strand_id = ?
          AND turn_id = ? AND root_scope_id = ?
      `).get(
        handle.projectId,
        handle.conversationId,
        handle.strandId,
        handle.turnId,
        handle.scopeId,
      ) as { state: string; terminal_sequence: number | null; created_at: number } | undefined;
      if (!row) throw new Error(`Durable turn ${handle.turnId} does not exist.`);
      if (row.terminal_sequence !== null) return null;
      const recordedAt = safeTimestamp(this.now());
      const durableDurationMs = durationMs === undefined
        ? Math.max(0, recordedAt - safeTimestamp(row.created_at))
        : safeDuration(durationMs);
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'turn.terminal',
        actor: 'harness',
        visibility: 'transcript',
        payload: { durationMs: durableDurationMs, error, errorCode, status },
        createdAt: recordedAt,
      });
      if (assistant) {
        for (const artifact of assistant.artifacts) this.insertArtifact(artifact, sequence);
        this.storage.database.prepare(`
          UPDATE transcript_items
          SET value_json = ?
          WHERE item_id = ? AND turn_id = ? AND kind = 'assistant'
        `).run(assistant.valueJson, assistant.itemId, handle.turnId);
      }
      this.insertArtifact(finalization.assistantMessageArtifact, sequence, 'content');
      if (finalization.assistantMessageArtifact && finalization.assistantMessageId) {
        const providerItem = this.storage.database.prepare(`
          SELECT provider_item_id FROM provider_items
          WHERE scope_id = ? AND item_type = 'assistant_message'
          ORDER BY created_sequence DESC LIMIT 1
        `).get(handle.scopeId) as { provider_item_id: string } | undefined;
        const ordinal = this.storage.database.prepare(`
          SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM messages WHERE scope_id = ?
        `).get(handle.scopeId) as { ordinal: number };
        this.storage.database.prepare(`
          INSERT INTO messages (
            message_id, project_id, conversation_id, strand_id, turn_id,
            scope_id, ordinal, role, visibility, state, content_artifact_hash,
            provider_item_id, created_sequence, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'assistant', 'transcript', ?, ?, ?, ?, ?)
        `).run(
          finalization.assistantMessageId,
          handle.projectId,
          handle.conversationId,
          handle.strandId,
          handle.turnId,
          handle.scopeId,
          safeNonnegativeInteger(ordinal.ordinal, 'assistant message ordinal'),
          status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted',
          finalization.assistantMessageArtifact.hash,
          providerItem?.provider_item_id ?? null,
          sequence,
          recordedAt,
        );
        if (assistant?.text) {
          this.indexJournalText({
            ref: `journal://turn/${encodeURIComponent(handle.turnId)}#assistant`,
            projectId: handle.projectId,
            conversationId: handle.conversationId,
            strandId: handle.strandId,
            turnId: handle.turnId,
            kind: status === 'completed' ? 'assistant-outcome' : 'assistant-response',
            sequence,
            text: assistant.text,
          });
        }
      }
      const thread = this.storage.database.prepare(`
        SELECT d.head_version_id
        FROM state_documents d
        WHERE d.conversation_id = ? AND d.strand_id = ?
          AND d.scope_kind = 'strand' AND d.key = 'thread.md'
      `).get(handle.conversationId, handle.strandId) as { head_version_id: string } | undefined;
      if (!thread?.head_version_id) throw new Error('The active strand has no thread.md version.');
      this.storage.database.prepare(`
        UPDATE inferences
        SET state = ?, terminal_sequence = ?
        WHERE scope_id = ? AND terminal_sequence IS NULL
      `).run(
        status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted',
        sequence,
        handle.scopeId,
      );
      this.storage.database.prepare(`
        UPDATE inferences
        SET state = 'interrupted', terminal_sequence = ?
        WHERE terminal_sequence IS NULL AND scope_id IN (
          SELECT scope_id FROM execution_scopes
          WHERE turn_id = ? AND kind = 'work_unit'
        )
      `).run(sequence, handle.turnId);
      this.storage.database.prepare(`
        UPDATE execution_scopes
        SET state = 'abandoned', terminal_sequence = ?, updated_at = ?
        WHERE turn_id = ? AND kind = 'work_unit' AND terminal_sequence IS NULL
      `).run(sequence, recordedAt, handle.turnId);
      this.storage.database.prepare(`
        UPDATE execution_scopes
        SET state = ?, terminal_sequence = ?, updated_at = ?
        WHERE scope_id = ? AND terminal_sequence IS NULL
      `).run(
        status === 'interrupted_by_restart' ? 'interrupted' : status,
        sequence,
        recordedAt,
        handle.scopeId,
      );
      this.storage.database.prepare(`
        UPDATE turns
        SET state = ?, terminal_sequence = ?, thread_version_after = ?,
            updated_at = ?
        WHERE turn_id = ? AND terminal_sequence IS NULL
      `).run(
        status,
        sequence,
        thread.head_version_id,
        recordedAt,
        handle.turnId,
      );
      this.storage.database.prepare(`
        UPDATE transcript_items
        SET status = CASE WHEN status = 'running' THEN ? ELSE status END,
            last_sequence = CASE WHEN status = 'running' THEN ? ELSE last_sequence END
        WHERE turn_id = ?
      `).run(status, sequence, handle.turnId);
      this.storage.database.prepare(`
        UPDATE conversations SET state = 'idle', updated_at = ?
        WHERE conversation_id = ?
      `).run(recordedAt, handle.conversationId);
      this.refreshConversationResources(handle.conversationId, sequence);
      return {
        basisSequence: sequence,
        createdAt: recordedAt,
        itemId: null,
      } satisfies DurableTranscriptMutation;
    });
  }

  private assertRunningHandle(handle: DurableTurnHandle) {
    const row = this.storage.database.prepare(`
      SELECT 1 AS present
      FROM turns t
      JOIN execution_scopes s ON s.turn_id = t.turn_id
      WHERE t.project_id = ? AND t.conversation_id = ? AND t.strand_id = ?
        AND t.turn_id = ? AND s.scope_id = ? AND t.terminal_sequence IS NULL
        AND s.terminal_sequence IS NULL
    `).get(
      handle.projectId,
      handle.conversationId,
      handle.strandId,
      handle.turnId,
      handle.scopeId,
    );
    if (!row) throw new Error(`Durable turn ${handle.turnId} is not running.`);
  }

  private scopeIdentity(scopeId: string) {
    const row = this.storage.database.prepare(`
      SELECT scope_id, parent_scope_id, kind, state
      FROM execution_scopes WHERE scope_id = ?
    `).get(scopeId) as {
      scope_id: string;
      parent_scope_id: string | null;
      kind: 'turn' | 'work_unit';
      state: string;
    } | undefined;
    if (!row) throw new Error(`Execution scope ${scopeId} does not exist.`);
    return row;
  }

  private findToolItem(turnId: string, callId: string) {
    return this.storage.database.prepare(`
      SELECT item_id, status, value_json
      FROM transcript_items
      WHERE turn_id = ? AND kind = 'tool'
        AND json_extract(value_json, '$.callId') = ?
    `).get(turnId, callId) as {
      item_id: string;
      status: string;
      value_json: string;
    } | undefined;
  }

  private refreshConversationResources(
    conversationId: string,
    basisSequence: number,
    visible?: ConversationSummaryMessage,
  ): ConversationSummary {
    const row = this.storage.database.prepare(`
      SELECT conversation_id, cwd, model_id, reasoning, state, created_at, updated_at
      FROM conversations WHERE conversation_id = ?
    `).get(conversationId) as ConversationProjectionRow | undefined;
    if (!row) throw new Error(`Conversation ${conversationId} does not exist.`);
    const resource = this.storage.database.prepare(`
      SELECT value_json FROM resources WHERE resource_key = ?
    `).get(conversationResourceKey(conversationId)) as { value_json: string } | undefined;
    const previous = resource
      ? JSON.parse(resource.value_json) as ConversationSummary
      : null;
    const base = renderConversationSummary({
      ...conversationProjectionInput(row),
      latestTurn: this.latestTurn(conversationId),
      messages: visible ? [visible] : [],
    });
    let title = previous?.title ?? base.title;
    let preview = previous?.preview ?? base.preview;
    if (visible?.role === 'user') {
      if (!previous?.latestTurnId) {
        title = truncateConversationText(visible.text, CONVERSATION_TITLE_CODE_POINTS) || INITIAL_TITLE;
        preview = truncateSummaryText(visible.text);
      } else if (!preview) {
        preview = truncateSummaryText(visible.text);
      }
    } else if (visible?.role === 'assistant') {
      const assistantPreview = truncateSummaryText(visible.text);
      if (assistantPreview) preview = assistantPreview;
    }
    const summary: ConversationSummary = { ...base, title, preview };
    this.upsertResource(
      conversationResourceKey(conversationId),
      basisSequence,
      summary,
      summary.updatedAt,
    );
    this.refreshConversationList();
    return summary;
  }

  private latestTurn(conversationId: string) {
    const row = this.storage.database.prepare(`
      SELECT turn_id, state
      FROM turns WHERE conversation_id = ?
      ORDER BY accepted_sequence DESC, turn_id DESC LIMIT 1
    `).get(conversationId) as { turn_id: string; state: string } | undefined;
    return row ? { id: row.turn_id, state: row.state } : null;
  }

  private conversationResourceBasis(conversationId: string) {
    const row = this.storage.database.prepare(`
      SELECT MAX(sequence) AS sequence
      FROM events
      WHERE conversation_id = ?
        AND type IN (
          'operation.succeeded',
          'assistant.checkpoint',
          'turn.terminal'
        )
    `).get(conversationId) as { sequence: number | null };
    if (row.sequence === null) {
      throw new Error(`Conversation ${conversationId} has no resource basis event.`);
    }
    return safeInteger(row.sequence, 'conversation resource basis sequence');
  }

  private refreshConversationList() {
    const rows = this.storage.database.prepare(`
      SELECT basis_sequence, value_json
      FROM resources WHERE resource_key LIKE 'conversation:%'
    `).all() as Array<{ basis_sequence: number; value_json: string }>;
    if (rows.length === 0) {
      this.storage.database.prepare(`
        DELETE FROM resources WHERE resource_key = 'conversation-list'
      `).run();
      return;
    }
    const entries = rows.map((row) => ({
      basisSequence: safeInteger(row.basis_sequence, 'conversation resource basis sequence'),
      summary: JSON.parse(row.value_json) as ConversationSummary,
    }));
    const value = renderConversationList(entries.map((entry) => entry.summary));
    const visibleIds = new Set(value.conversations.map((summary) => summary.id));
    const basisSequence = Math.max(
      ...entries
        .filter((entry) => visibleIds.has(entry.summary.id))
        .map((entry) => entry.basisSequence),
    );
    this.upsertResource(
      'conversation-list',
      basisSequence,
      value,
      value.conversations[0]?.updatedAt ?? 0,
    );
  }

  private upsertResource(
    key: DurableResourceProjection['key'],
    basisSequence: number,
    value: DurableResourceProjection['value'],
    updatedAt: number,
  ) {
    this.storage.database.prepare(`
      INSERT INTO resources (resource_key, basis_sequence, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(resource_key) DO UPDATE SET
        basis_sequence = excluded.basis_sequence,
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(key, basisSequence, canonicalJson(value), updatedAt);
  }

  private async prepareText(text: string, forceArtifact = false): Promise<PreparedReference> {
    const bytes = Buffer.from(text, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const inlineRef: DurableContentRef = { kind: 'inline', text, byteLength: bytes.byteLength, sha256 };
    if (
      !forceArtifact &&
      bytes.byteLength <= INLINE_CONTENT_LIMIT_BYTES &&
      Buffer.byteLength(canonicalJson(inlineRef), 'utf8') <= EVENT_PAYLOAD_LIMIT_BYTES - 8 * 1024
    ) {
      return {
        ref: inlineRef,
        artifact: null,
        sha256,
        text,
      };
    }
    const artifact = await this.artifacts.put(bytes, 'text/plain; charset=utf-8');
    return { ref: artifactRef(artifact), artifact, sha256, text };
  }

  private async prepareUserInput(params: AcceptTurnParams): Promise<PreparedUserInput> {
    const content = await this.prepareText(params.text);
    const artifacts: StagedArtifact[] = content.artifact ? [content.artifact] : [];
    const parts: AgentUserMessagePart[] | undefined = params.parts ? [] : undefined;
    for (const part of params.parts ?? []) {
      if (part.type === 'text') {
        parts!.push(part);
        continue;
      }
      if (part.type === 'mention') {
        parts!.push({
          kind: part.kind ?? 'file',
          name: part.name?.trim() || basename(part.path),
          path: part.path,
          type: 'mention',
        });
        continue;
      }
      const decoded = decodeAgentImageDataUrl(part.dataUrl);
      const artifact = await this.artifacts.put(decoded.bytes, decoded.mimeType);
      artifacts.push(artifact);
      parts!.push({
        artifactHash: artifact.hash,
        mimeType: decoded.mimeType,
        name: part.name?.trim() || 'Image',
        sizeBytes: decoded.bytes.byteLength,
        type: 'image',
      });
    }
    const messageArtifact = await this.artifacts.put(
      Buffer.from(canonicalJson({
        role: 'user',
        text: params.text,
        ...(parts ? { parts } : {}),
      }), 'utf8'),
      'application/vnd.remux.message+json',
    );
    artifacts.push(messageArtifact);
    return { artifacts: uniqueArtifacts(artifacts), content, messageArtifact, parts };
  }

  private async readLogicalImages(parts: readonly AgentUserMessagePart[]) {
    const images = [];
    for (const part of parts) {
      if (part.type !== 'image') continue;
      const row = this.storage.database.prepare(`
        SELECT byte_length, media_type, storage_path FROM artifacts WHERE hash = ?
      `).get(part.artifactHash) as {
        byte_length: number;
        media_type: string;
        storage_path: string;
      } | undefined;
      if (!row) throw new Error(`User image artifact ${part.artifactHash} is missing.`);
      if (row.media_type !== part.mimeType || row.byte_length !== part.sizeBytes) {
        throw new Error(`User image artifact ${part.artifactHash} metadata does not match its message.`);
      }
      const bytes = await this.artifacts.read({
        hash: part.artifactHash,
        byteLength: row.byte_length,
        storagePath: row.storage_path,
      });
      images.push({ data: bytes.toString('base64'), mimeType: part.mimeType, sha256: part.artifactHash });
    }
    return images;
  }

  private async rehydrateStoredUserParts(parts: AgentUserMessagePart[] | undefined) {
    if (!parts) return undefined;
    const hydrated: AgentComposerMessagePart[] = [];
    for (const part of parts) {
      if (part.type !== 'image') {
        hydrated.push(part);
        continue;
      }
      const row = this.storage.database.prepare(`
        SELECT byte_length, media_type, storage_path FROM artifacts WHERE hash = ?
      `).get(part.artifactHash) as {
        byte_length: number;
        media_type: string;
        storage_path: string;
      } | undefined;
      if (!row) throw new Error(`Queued image artifact ${part.artifactHash} is missing.`);
      const bytes = await this.artifacts.read({
        hash: part.artifactHash,
        byteLength: row.byte_length,
        storagePath: row.storage_path,
      });
      hydrated.push({
        dataUrl: `data:${part.mimeType};base64,${bytes.toString('base64')}`,
        mimeType: part.mimeType,
        name: part.name,
        type: 'image',
      });
    }
    return hydrated;
  }

  private async prepareJson(value: unknown, forceArtifact = false): Promise<PreparedReference> {
    const normalized = normalizeJson(value);
    const json = canonicalJson(normalized);
    const bytes = Buffer.from(json, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const inlineRef: DurableContentRef = { kind: 'inline', text: json, byteLength: bytes.byteLength, sha256 };
    if (
      !forceArtifact &&
      bytes.byteLength <= INLINE_CONTENT_LIMIT_BYTES &&
      Buffer.byteLength(canonicalJson(inlineRef), 'utf8') <= EVENT_PAYLOAD_LIMIT_BYTES - 8 * 1024
    ) {
      return {
        ref: inlineRef,
        artifact: null,
        sha256,
        text: json,
      };
    }
    const artifact = await this.artifacts.put(bytes, 'application/json');
    return { ref: artifactRef(artifact), artifact, sha256, text: json };
  }

  private async prepareProviderJson(value: unknown): Promise<PreparedReference> {
    const json = canonicalProviderJson(value);
    const bytes = Buffer.from(json, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifact = await this.artifacts.put(bytes, 'application/json');
    return { ref: artifactRef(artifact), artifact, sha256, text: json };
  }

  private insertArtifact(
    artifact: StagedArtifact | null,
    sequence: number,
    sensitivity: 'content' | 'inspectable' | 'private' = 'content',
  ) {
    if (!artifact) return;
    this.storage.database.prepare(`
      INSERT OR IGNORE INTO artifacts (
        hash, byte_length, media_type, created_sequence, storage_path, sensitivity
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      artifact.hash,
      artifact.byteLength,
      artifact.mediaType,
      sequence,
      artifact.storagePath,
      sensitivity,
    );
    if (sensitivity === 'private') {
      this.storage.database.prepare(`
        UPDATE artifacts SET sensitivity = 'private' WHERE hash = ?
      `).run(artifact.hash);
    }
    const row = this.storage.database.prepare(`
      SELECT byte_length, media_type, storage_path FROM artifacts WHERE hash = ?
    `).get(artifact.hash) as {
      byte_length: number;
      media_type: string;
      storage_path: string;
    };
    if (
      row.byte_length !== artifact.byteLength ||
      row.storage_path !== artifact.storagePath
    ) {
      throw new Error(`Artifact ${artifact.hash} conflicts with its durable metadata.`);
    }
    const linked = this.storage.database.prepare(`
      SELECT 1
      FROM events source
      WHERE source.sequence = ?
        AND (
          source.artifact_hash = ?
          OR EXISTS (
            SELECT 1 FROM json_tree(source.payload_json) linked
            WHERE linked.value = ?
               OR linked.value = 'journal://artifact/' || ?
          )
        )
      LIMIT 1
    `).get(sequence, artifact.hash, artifact.hash, artifact.hash);
    if (linked) return;
    const source = this.storage.database.prepare(`
      SELECT project_id, conversation_id, strand_id, turn_id, scope_id,
             event_id, created_at
      FROM events WHERE sequence = ?
    `).get(sequence) as {
      project_id: string;
      conversation_id: string;
      strand_id: string;
      turn_id: string | null;
      scope_id: string | null;
      event_id: string;
      created_at: number;
    } | undefined;
    if (!source) throw new Error(`Artifact ${artifact.hash} has no durable source event.`);
    this.insertEvent({
      eventId: this.nextId('event'),
      projectId: source.project_id,
      conversationId: source.conversation_id,
      strandId: source.strand_id,
      ...(source.turn_id ? { turnId: source.turn_id } : {}),
      ...(source.scope_id ? { scopeId: source.scope_id } : {}),
      type: 'artifact.linked',
      actor: 'harness',
      visibility: 'internal',
      payload: {
        artifactRef: `journal://artifact/${artifact.hash}`,
        sourceEventRef: `journal://event-id/${source.event_id}`,
      },
      artifactHash: artifact.hash,
      createdAt: source.created_at,
    });
  }

  private indexJournalText(input: {
    ref: string;
    projectId: string;
    conversationId?: string | null;
    strandId?: string | null;
    turnId?: string | null;
    kind: string;
    sequence: number;
    text: string;
  }) {
    this.storage.database.prepare(`
      DELETE FROM journal_search_index
      WHERE ref = ? AND kind = ? AND project_id = ? AND conversation_id = ?
    `).run(input.ref, input.kind, input.projectId, input.conversationId ?? '');
    this.storage.database.prepare(`
      INSERT INTO journal_search_index (
        ref, project_id, conversation_id, strand_id, turn_id, kind, sequence, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.ref,
      input.projectId,
      input.conversationId ?? '',
      input.strandId ?? '',
      input.turnId ?? '',
      input.kind,
      input.sequence,
      input.text,
    );
  }

  private async rebuildJournalSearchIndex() {
    type SearchEntry = Parameters<AgentJournalRepository['indexJournalText']>[0];
    const entries: SearchEntry[] = [];
    const messageRows = this.storage.database.prepare(`
      SELECT message_id, project_id, conversation_id, strand_id, turn_id,
             role, state, content_artifact_hash, created_sequence
      FROM messages
      WHERE visibility = 'transcript' AND role IN ('user', 'assistant')
      ORDER BY created_sequence
    `).all() as Array<{
      message_id: string; project_id: string; conversation_id: string; strand_id: string;
      turn_id: string; role: 'user' | 'assistant'; state: string;
      content_artifact_hash: string; created_sequence: number;
    }>;
    for (const row of messageRows) {
      const value = JSON.parse(await this.readArtifactTextByHash(row.content_artifact_hash)) as {
        text?: unknown;
      };
      if (typeof value.text !== 'string' || value.text.length === 0) continue;
      entries.push({
        ref: row.role === 'assistant'
          ? `journal://turn/${encodeURIComponent(row.turn_id)}#assistant`
          : `journal://message/${encodeURIComponent(row.message_id)}`,
        projectId: row.project_id,
        conversationId: row.conversation_id,
        strandId: row.strand_id,
        turnId: row.turn_id,
        kind: row.role === 'assistant'
          ? row.state === 'completed' ? 'assistant-outcome' : 'assistant-response'
          : 'user-message',
        sequence: safeInteger(row.created_sequence, 'journal message sequence'),
        text: value.text,
      });
    }

    const documentRows = this.storage.database.prepare(`
      SELECT v.version_id, d.project_id, d.conversation_id, d.strand_id,
             v.based_on_turn_id, v.content_artifact_hash, v.created_sequence
      FROM document_versions v
      JOIN state_documents d ON d.document_id = v.document_id
      ORDER BY v.created_sequence, v.version_id
    `).all() as Array<{
      version_id: string; project_id: string; conversation_id: string; strand_id: string;
      based_on_turn_id: string | null; content_artifact_hash: string; created_sequence: number;
    }>;
    for (const row of documentRows) {
      entries.push({
        ref: `journal://document-version/${encodeURIComponent(row.version_id)}`,
        projectId: row.project_id,
        conversationId: row.conversation_id,
        strandId: row.strand_id,
        turnId: row.based_on_turn_id,
        kind: 'thread-document',
        sequence: safeInteger(row.created_sequence, 'journal document sequence'),
        text: await this.readArtifactTextByHash(row.content_artifact_hash),
      });
    }

    const scopeRows = this.storage.database.prepare(`
      SELECT scope_id, project_id, conversation_id, strand_id, turn_id,
             objective_json, created_sequence, terminal_sequence, result_artifact_hash
      FROM execution_scopes WHERE kind = 'work_unit'
      ORDER BY created_sequence, scope_id
    `).all() as Array<{
      scope_id: string; project_id: string; conversation_id: string; strand_id: string;
      turn_id: string; objective_json: string; created_sequence: number;
      terminal_sequence: number | null; result_artifact_hash: string | null;
    }>;
    for (const row of scopeRows) {
      const objective = JSON.parse(row.objective_json) as { objective?: unknown };
      if (typeof objective.objective === 'string' && objective.objective.length > 0) {
        entries.push({
          ref: `journal://artifact/${row.result_artifact_hash}`,
          projectId: row.project_id,
          conversationId: row.conversation_id,
          strandId: row.strand_id,
          turnId: row.turn_id,
          kind: 'work-unit-objective',
          sequence: safeInteger(row.created_sequence, 'journal work-unit sequence'),
          text: objective.objective,
        });
      }
      if (row.result_artifact_hash && row.terminal_sequence !== null) {
        entries.push({
          ref: `journal://scope/${encodeURIComponent(row.scope_id)}`,
          projectId: row.project_id,
          conversationId: row.conversation_id,
          strandId: row.strand_id,
          turnId: row.turn_id,
          kind: 'work-unit-result',
          sequence: safeInteger(row.terminal_sequence, 'journal work-unit result sequence'),
          text: await this.readArtifactTextByHash(row.result_artifact_hash),
        });
      }
    }

    const toolEvents = (await this.readEvents({})).filter((event) => event.type === 'tool.called');
    for (const event of toolEvents) {
      if (!event.turnId || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
        continue;
      }
      const payload = event.payload as Record<string, CanonicalJsonValue>;
      const callId = requiredString(payload.callId, 'journal tool call id');
      const name = requiredString(payload.name, 'journal tool name');
      entries.push({
        ref: `journal://tool/${encodeURIComponent(callId)}`,
        projectId: event.projectId,
        conversationId: event.conversationId,
        strandId: event.strandId,
        turnId: event.turnId,
        kind: `operation:${name}`,
        sequence: event.sequence,
        text: `${name}\n${canonicalJson(await this.readJsonRef(payload.args))}`,
      });
    }

    this.storage.transaction(() => {
      this.storage.database.exec('DELETE FROM journal_search_index');
      for (const entry of entries) this.indexJournalText(entry);
    });
  }

  private async readTextRef(value: CanonicalJsonValue | undefined) {
    const ref = parseReference(value);
    if (ref.kind === 'inline') return ref.text;
    const bytes = await this.artifacts.read(ref);
    return bytes.toString('utf8');
  }

  private async readArtifactTextByHash(hash: string) {
    const row = this.storage.database.prepare(`
      SELECT byte_length, storage_path FROM artifacts WHERE hash = ?
    `).get(hash) as { byte_length: number; storage_path: string } | undefined;
    if (!row) throw new Error(`Artifact ${hash} is missing.`);
    const bytes = await this.artifacts.read({
      hash,
      byteLength: safeNonnegativeInteger(row.byte_length, 'artifact byte length'),
      storagePath: row.storage_path,
    });
    return bytes.toString('utf8');
  }

  private async attachActiveProviderMessages(
    messages: readonly LogicalContextMessage[],
    scopeIds: readonly string[],
    turnId: string,
  ): Promise<LogicalContextMessage[]> {
    if (scopeIds.length === 0) return [...messages];
    const rows = this.storage.database.prepare(`
      SELECT raw_artifact_hash
      FROM provider_items
      WHERE scope_id IN (${sqlPlaceholders(scopeIds.length)})
        AND turn_id = ? AND item_type = 'assistant_message'
      ORDER BY created_sequence
    `).all(...scopeIds, turnId) as Array<{ raw_artifact_hash: string }>;
    if (rows.length === 0) return [...messages];
    const providerMessages = await Promise.all(rows.map(async ({ raw_artifact_hash }) =>
      JSON.parse(await this.readArtifactTextByHash(raw_artifact_hash)) as AssistantMessage));
    let activeAssistantIndex = 0;
    return messages.map((message): LogicalContextMessage => {
      if (message.role !== 'assistant' || message.turnId !== turnId) return message;
      const providerMessage = providerMessages[activeAssistantIndex++];
      return providerMessage ? { ...message, providerMessage } : message;
    });
  }

  private async readProjectedTextRef(
    value: CanonicalJsonValue | undefined,
    maxBytes = MAX_VISIBLE_TEXT_BYTES,
  ) {
    const ref = parseReference(value);
    if (ref.kind === 'inline') {
      const text = truncateUtf8Text(ref.text, maxBytes);
      const returnedBytes = Buffer.byteLength(text, 'utf8');
      return {
        text,
        content: ref.byteLength > returnedBytes
          ? {
              sha256: ref.sha256,
              byteLength: ref.byteLength,
              returnedBytes,
              truncated: true as const,
              artifactHash: null,
              nextRange: null,
            } satisfies AgentTextContentReference
          : undefined,
      };
    }
    const bytes = await this.artifacts.readRange(ref, 0, Math.min(ref.byteLength, maxBytes));
    const text = bytes.toString('utf8').replace(/\uFFFD$/u, '');
    const returnedBytes = Buffer.byteLength(text, 'utf8');
    return {
      text,
      content: ref.byteLength > returnedBytes
        ? {
            sha256: ref.hash,
            byteLength: ref.byteLength,
            returnedBytes,
            truncated: true as const,
            artifactHash: ref.hash,
            nextRange: {
              kind: 'utf8' as const,
              offset: returnedBytes,
              byteLength: maxBytes,
            },
          } satisfies AgentTextContentReference
        : undefined,
    };
  }

  private async readJsonRef(value: CanonicalJsonValue | undefined) {
    return JSON.parse(await this.readTextRef(value)) as unknown;
  }

  private currentHead(handle: DurableTurnHandle) {
    const row = this.storage.database.prepare(`
      SELECT MAX(sequence) AS sequence
      FROM events
      WHERE project_id = ? AND conversation_id = ? AND strand_id = ?
    `).get(handle.projectId, handle.conversationId, handle.strandId) as { sequence: number | null };
    if (row.sequence === null) throw new Error('The durable strand has no journal basis.');
    return safeInteger(row.sequence, 'journal head');
  }

  private insertEvent(event: {
    eventId: string;
    projectId: string;
    conversationId: string;
    strandId: string;
    turnId?: string;
    scopeId?: string;
    operationId?: string;
    type: string;
    actor?: string;
    visibility?: string;
    payload: CanonicalJsonValue;
    artifactHash?: string | null;
    createdAt: number;
  }) {
    const payload = canonicalJson(event.payload);
    if (Buffer.byteLength(payload, 'utf8') > EVENT_PAYLOAD_LIMIT_BYTES) {
      throw new Error(`Agent event payload exceeds ${EVENT_PAYLOAD_LIMIT_BYTES} bytes.`);
    }
    const row = this.storage.database.prepare(`
      INSERT INTO events (
        event_id, project_id, conversation_id, strand_id, turn_id, scope_id,
        type, actor, visibility, causal_event_id, operation_id, payload_json,
        artifact_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      RETURNING sequence
    `).get(
      event.eventId,
      event.projectId,
      event.conversationId,
      event.strandId,
      event.turnId ?? null,
      event.scopeId ?? null,
      event.type,
      event.actor ?? 'harness',
      event.visibility ?? 'internal',
      event.operationId ?? null,
      payload,
      event.artifactHash ?? null,
      event.createdAt,
    ) as { sequence: number };
    return safeInteger(row.sequence, 'event sequence');
  }

  private nextId(kind: IdKind) {
    const id = this.idFactory(kind);
    if (!UUID_V4.test(id)) throw new TypeError(`Agent ${kind} ID must be a lowercase UUID v4.`);
    return id;
  }

  private enqueueWrite<T>(work: () => T | Promise<T>): Promise<T> {
    const next = this.writerTail.then(work, work);
    this.writerTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private assertOpen() {
    if (this.closePromise) throw new Error('Agent journal repository is closed.');
  }
}

export class OperationConflictError extends Error {
  readonly operationId: string;

  constructor(operationId: string) {
    super(`Operation ${operationId} was already used with different arguments.`);
    this.name = 'OperationConflictError';
    this.operationId = operationId;
  }
}

export class ClientMessageConflictError extends Error {
  readonly clientMessageId: string;

  constructor(clientMessageId: string) {
    super(`clientMessageId ${clientMessageId} was already used with different content.`);
    this.name = 'ClientMessageConflictError';
    this.clientMessageId = clientMessageId;
  }
}

export class DurableTranscriptSelectionError extends Error {
  readonly code = -32602;

  constructor(message: string) {
    super(message);
    this.name = 'DurableTranscriptSelectionError';
  }
}

type PreparedReference = {
  ref: DurableContentRef;
  artifact: StagedArtifact | null;
  sha256: string;
  text: string;
};

type PreparedUserInput = {
  artifacts: StagedArtifact[];
  content: PreparedReference;
  messageArtifact: StagedArtifact;
  parts: AgentUserMessagePart[] | undefined;
};

type QueuedOperationValue = {
  attachmentCount: number;
  clientMessageId: string;
  content: DurableContentRef;
  dispatchOperationId: string;
  mentionCount: number;
  parts?: AgentUserMessagePart[];
  preview: string;
  turnId?: string;
};

type PreparedAssistantProjection = {
  artifacts: StagedArtifact[];
  itemId: string;
  text: string;
  valueJson: string;
};

type PreparedTurnFinalization = {
  assistantMessageArtifact: StagedArtifact | null;
  assistantMessageId: string | null;
};

type ConversationProjectionRow = {
  conversation_id: string;
  cwd: string;
  model_id: string;
  reasoning: string;
  state: string;
  created_at: number;
  updated_at: number;
};

type TranscriptProjectionRow = {
  turn_id: string;
  first_sequence: number;
  last_sequence: number;
  kind: 'user' | 'assistant';
  value_json: string;
};

type TranscriptWindowItemRow = {
  item_id: string;
  turn_id: string;
  first_sequence: number;
  last_sequence: number;
  kind: string;
  value_json: string;
};

type EventRow = {
  sequence: number;
  event_id: string;
  project_id: string;
  conversation_id: string;
  strand_id: string;
  turn_id: string | null;
  scope_id: string | null;
  type: string;
  actor: string;
  visibility: string;
  causal_event_id: string | null;
  operation_id: string | null;
  payload_json: string | null;
  artifact_hash: string | null;
  created_at: number;
};

function decodeEventRow(row: EventRow): AgentJournalEvent {
  return {
    sequence: safeInteger(row.sequence, 'event sequence'),
    eventId: row.event_id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    strandId: row.strand_id,
    turnId: row.turn_id,
    scopeId: row.scope_id,
    type: row.type,
    actor: row.actor,
    visibility: row.visibility,
    causalEventId: row.causal_event_id,
    operationId: row.operation_id,
    payload: row.payload_json === null ? null : JSON.parse(row.payload_json) as CanonicalJsonValue,
    artifactHash: row.artifact_hash,
    createdAt: safeTimestamp(row.created_at),
  };
}

function parseFinalAssistantProjection(valueJson: string) {
  const value = JSON.parse(valueJson) as Record<string, CanonicalJsonValue>;
  if (
    value.version !== 2 ||
    !Object.hasOwn(value, 'text') ||
    !Array.isArray(value.reasoningRuns)
  ) return null;
  const text = value.text === null
    ? null
    : parseFinalAssistantContent(value.text, 'assistant text');
  const reasoningRuns = value.reasoningRuns.map((entry, index) =>
    parseFinalAssistantContent(entry, `assistant reasoning run ${index}`));
  return { text, reasoningRuns };
}

function parseFinalAssistantContent(value: CanonicalJsonValue, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid durable ${label} projection.`);
  }
  const record = value as Record<string, CanonicalJsonValue>;
  const firstSequence = safeNonnegativeInteger(record.firstSequence, `${label} first sequence`);
  const lastSequence = safeNonnegativeInteger(record.lastSequence, `${label} last sequence`);
  if (firstSequence < 1 || lastSequence < firstSequence) {
    throw new Error(`Invalid durable ${label} sequence range.`);
  }
  return {
    content: record.content,
    firstSequence,
    lastSequence,
  };
}

function requiredSequenceTimestamp(timestamps: Map<number, number>, sequence: number) {
  const timestamp = timestamps.get(sequence);
  if (timestamp === undefined) throw new Error(`Transcript sequence ${sequence} has no timestamp.`);
  return timestamp;
}

function sqlPlaceholders(count: number) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('SQL placeholder count is invalid.');
  return Array.from({ length: count }, () => '?').join(', ');
}

function stripTranscriptProjectionMetadata(
  action: DurableTranscriptProjectionAction,
): DurableTranscriptAction {
  switch (action.type) {
    case 'turn':
      return {
        type: action.type,
        turnId: action.turnId,
        clientMessageId: action.clientMessageId,
        text: action.text,
      };
    case 'assistant':
      return {
        type: action.type,
        turnId: action.turnId,
        textDelta: action.textDelta,
        reasoningDelta: action.reasoningDelta,
      };
    case 'tool-start':
      return {
        type: action.type,
        turnId: action.turnId,
        callId: action.callId,
        name: action.name,
        args: action.args,
      };
    case 'tool-end':
      return {
        type: action.type,
        turnId: action.turnId,
        callId: action.callId,
        result: action.result,
        isError: action.isError,
      };
    case 'terminal':
      return {
        type: action.type,
        turnId: action.turnId,
        status: action.status,
        error: action.error,
        ...(action.errorCode ? { errorCode: action.errorCode } : {}),
        ...(action.durationMs === undefined ? {} : { durationMs: action.durationMs }),
      };
  }
}

function decodeStoredOutcome(
  value: string,
  operationId: string,
  projectId: string,
  conversationId: string,
  threadDocumentId: string,
  threadVersionId: string,
): StoredCreateOutcome {
  const parsed = JSON.parse(value) as Partial<StoredCreateOutcome>;
  if (
    parsed.accepted !== true ||
    parsed.operationId !== operationId ||
    parsed.projectId !== projectId ||
    parsed.conversationId !== conversationId ||
    parsed.threadDocumentId !== threadDocumentId ||
    parsed.threadVersionId !== threadVersionId
  ) {
    throw new Error(`Operation ${operationId} has an invalid durable outcome.`);
  }
  return {
    accepted: true,
    operationId,
    projectId,
    conversationId,
    threadDocumentId,
    threadVersionId,
  };
}

function contextInspectorValue(input: {
  frameId: string;
  manifest: PromptManifest;
  manifestArtifact: StagedArtifact;
  bootstrapArtifact: StagedArtifact;
  dispatchArtifact: StagedArtifact;
  activeMessages: readonly LogicalContextMessage[];
  buildDurationMs: number;
}): ContextInspectorValue {
  const sourceLimit = 16;
  const omissionLimit = 64;
  const groupLimit = 64;
  const groups = new Map<string, ContextInspectorValue['groups'][number]>();
  for (const message of input.activeMessages) {
    const semantic = canonicalJson(logicalMessageSemanticValue(message));
    const existing = groups.get(message.turnId) ?? {
      turnId: message.turnId,
      source: `journal://turn/${encodeURIComponent(message.turnId)}`,
      messageCount: 0,
      estimatedTokens: 0,
      roles: { user: 0, assistant: 0, tool: 0 },
    };
    existing.messageCount += 1;
    existing.estimatedTokens += Math.max(1, Math.ceil(Buffer.byteLength(semantic, 'utf8') / 4));
    existing.roles[message.role] += 1;
    groups.set(message.turnId, existing);
  }
  const orderedGroups = [...groups.values()];
  return {
    version: 4,
    conversationId: input.manifest.conversationId,
    inferenceId: input.manifest.inferenceId,
    frameId: input.frameId,
    basisSequence: input.manifest.basisSequence,
    threadVersionId: input.manifest.threadVersionId,
    dialogueTurnIds: [...input.manifest.context.dialogueTurnIds],
    omittedDialogueTurns: input.manifest.context.omittedDialogueTurns,
    threadDocumentBytes: input.manifest.context.threadDocumentBytes,
    scopeKind: input.manifest.context.scopeKind,
    softContextLimit: input.manifest.context.softContextLimit,
    hardContextLimit: input.manifest.context.hardContextLimit,
    pressureNoticed: input.manifest.context.pressureNoticed,
    compilerVersion: input.manifest.compilerVersion,
    policyVersion: input.manifest.policyVersion,
    estimatedInputTokens: input.manifest.context.estimatedInputTokens,
    semanticHash: input.manifest.context.semanticHash,
    bootstrapHash: input.manifest.context.bootstrapHash,
    buildDurationMs: safeNonnegativeInteger(input.buildDurationMs, 'context frame build duration'),
    transportMode: input.manifest.transport.requestMode,
    messageCount: input.manifest.context.messageCount,
    turnCount: orderedGroups.length,
    logicalHash: input.manifest.context.logicalHash,
    renderedHash: input.manifest.context.renderedHash,
    fixedContractsHash: input.manifest.transport.fixedContractsHash,
    manifestArtifact: {
      hash: input.manifestArtifact.hash,
      byteLength: input.manifestArtifact.byteLength,
      mediaType: input.manifestArtifact.mediaType,
    },
    bootstrapArtifact: {
      hash: input.bootstrapArtifact.hash,
      byteLength: input.bootstrapArtifact.byteLength,
      mediaType: input.bootstrapArtifact.mediaType,
    },
    dispatchArtifact: {
      hash: input.dispatchArtifact.hash,
      byteLength: input.dispatchArtifact.byteLength,
      mediaType: input.dispatchArtifact.mediaType,
    },
    groups: orderedGroups.slice(-groupLimit),
    groupsTruncated: orderedGroups.length > groupLimit,
    layers: input.manifest.context.layers.map((layer) => ({
      kind: layer.kind,
      hash: layer.hash,
      estimatedTokens: layer.estimatedTokens,
      sources: layer.sources.slice(0, sourceLimit),
      sourceCount: layer.sources.length,
      sourcesTruncated: layer.sources.length > sourceLimit,
    })),
    omissions: input.manifest.context.omissions.slice(0, omissionLimit),
    omissionsTruncated: input.manifest.context.omissions.length > omissionLimit,
  };
}

function projectTitle(cwd: string) {
  const title = basename(cwd);
  return title.length > 0 ? title : cwd;
}

function conversationProjectionInput(row: ConversationProjectionRow) {
  if (!isReasoningLevel(row.reasoning)) {
    throw new Error(`Conversation ${row.conversation_id} has invalid durable reasoning.`);
  }
  return {
    id: row.conversation_id,
    cwd: row.cwd,
    modelId: row.model_id,
    reasoning: row.reasoning,
    conversationState: row.state,
    createdAt: safeTimestamp(row.created_at),
    updatedAt: safeTimestamp(row.updated_at),
  };
}

function truncateSummaryText(text: string) {
  return truncateConversationText(text, CONVERSATION_PREVIEW_CODE_POINTS);
}

function truncateConversationText(text: string, codePoints: number) {
  return [...normalizeConversationText(text)].slice(0, codePoints).join('');
}

function appendAssistantSummary(
  prior: { summaryPendingSpace: boolean; summaryText: string },
  delta: string,
) {
  if (!delta) return { text: prior.summaryText, pendingSpace: prior.summaryPendingSpace };
  const leadingSpace = prior.summaryText && (prior.summaryPendingSpace || /^\p{White_Space}/u.test(delta))
    ? ' '
    : '';
  return {
    text: truncateSummaryText(`${prior.summaryText}${leadingSpace}${delta}`),
    pendingSpace: /\p{White_Space}$/u.test(delta),
  };
}

function assistantSummaryText(value: Record<string, unknown>) {
  if (typeof value.summaryText === 'string') return value.summaryText;
  return typeof value.text === 'string' ? value.text : '';
}

function assistantAccumulator(value: Record<string, unknown>) {
  if (value.version === 2) {
    return {
      reasoningByteLength: safeNonnegativeInteger(
        value.reasoningByteLength ?? 0,
        'assistant reasoning byte length',
      ),
      summaryPendingSpace: value.summaryPendingSpace === true,
      summaryText: typeof value.summaryText === 'string' ? value.summaryText : '',
      textByteLength: safeNonnegativeInteger(
        value.textByteLength ?? 0,
        'assistant text byte length',
      ),
    };
  }
  const text = typeof value.text === 'string' ? value.text : '';
  const reasoning = typeof value.reasoning === 'string' ? value.reasoning : '';
  return {
    reasoningByteLength: Buffer.byteLength(reasoning, 'utf8'),
    summaryPendingSpace: false,
    summaryText: truncateSummaryText(text),
    textByteLength: Buffer.byteLength(text, 'utf8'),
  };
}

function preparedTextProjection(prepared: PreparedReference, maxBytes: number) {
  const text = truncateUtf8Text(prepared.text, maxBytes);
  const returnedBytes = Buffer.byteLength(text, 'utf8');
  if (prepared.ref.byteLength <= returnedBytes) return { text, content: undefined };
  const artifactHash = prepared.ref.kind === 'artifact' ? prepared.ref.hash : null;
  return {
    text,
    content: {
      sha256: prepared.sha256,
      byteLength: prepared.ref.byteLength,
      returnedBytes,
      truncated: true as const,
      artifactHash,
      nextRange: artifactHash
        ? { kind: 'utf8' as const, offset: returnedBytes, byteLength: MAX_VISIBLE_TEXT_BYTES }
        : null,
    } satisfies AgentTextContentReference,
  };
}

function truncateUtf8Text(value: string, maxBytes: number) {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '');
}

function uniqueArtifacts(artifacts: StagedArtifact[]) {
  const byHash = new Map<string, StagedArtifact>();
  for (const artifact of artifacts) byHash.set(artifact.hash, artifact);
  return [...byHash.values()];
}

function transcriptUserSummaryText(value: Record<string, unknown>) {
  if (typeof value.summaryText === 'string') return value.summaryText;
  if (
    value.content &&
    typeof value.content === 'object' &&
    !Array.isArray(value.content) &&
    (value.content as Record<string, unknown>).kind === 'inline'
  ) {
    const text = (value.content as Record<string, unknown>).text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

function validateCreateConversationParams(params: CreateConversationParams): CreateConversationParams {
  if (!UUID_V4.test(params.operationId)) throw new TypeError('operationId must be a lowercase UUID v4.');
  if (!isAbsolute(params.cwd) || Buffer.byteLength(params.cwd, 'utf8') > 16 * 1024) {
    throw new TypeError('cwd must be an absolute path no larger than 16 KiB.');
  }
  if (!params.modelId || Buffer.byteLength(params.modelId, 'utf8') > 256) {
    throw new TypeError('modelId must contain 1 to 256 UTF-8 bytes.');
  }
  if (!isReasoningLevel(params.reasoning)) throw new TypeError('reasoning is invalid.');
  if (params.inheritThreadFrom) {
    if (!UUID_V4.test(params.inheritThreadFrom.conversationId)) {
      throw new TypeError('inheritThreadFrom.conversationId must be a lowercase UUID v4.');
    }
    if (!UUID_V4.test(params.inheritThreadFrom.turnId)) {
      throw new TypeError('inheritThreadFrom.turnId must be a lowercase UUID v4.');
    }
    if (
      params.inheritThreadFrom.position !== 'before' &&
      params.inheritThreadFrom.position !== 'after'
    ) throw new TypeError('inheritThreadFrom.position is invalid.');
  }
  return { ...params };
}

function validateAcceptTurnParams(params: AcceptTurnParams): AcceptTurnParams {
  if (!UUID_V4.test(params.operationId)) throw new TypeError('operationId must be a lowercase UUID v4.');
  if (!UUID_V4.test(params.conversationId)) throw new TypeError('conversationId must be a lowercase UUID v4.');
  if (!UUID_V4.test(params.clientMessageId)) throw new TypeError('clientMessageId must be a lowercase UUID v4.');
  if (!params.text.trim()) throw new TypeError('Message text cannot be empty.');
  if (params.parts !== undefined && params.parts.length === 0) {
    throw new TypeError('Message parts cannot be empty.');
  }
  return { ...params };
}

function messageArgumentsHash(params: AcceptTurnParams) {
  const textHash = createHash('sha256').update(params.text, 'utf8').digest('hex');
  return canonicalJsonHash({
    kind: SEND_MESSAGE_KIND,
    params: {
      clientMessageId: params.clientMessageId,
      conversationId: params.conversationId,
      ...(params.parts ? { parts: agentComposerPartsHashValue(params.parts) } : {}),
      textHash,
    },
  });
}

function queuedMessageArgumentsHash(params: AcceptTurnParams) {
  return canonicalJsonHash({ kind: 'message.queue', messageHash: messageArgumentsHash(params) });
}

function parseQueuedOperationValue(json: string): QueuedOperationValue {
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Queued message operation value is invalid.');
  }
  const value = parsed as Record<string, CanonicalJsonValue>;
  const parts = value.parts === undefined ? undefined : parseStoredUserParts(value.parts);
  const turnId = value.turnId === undefined ? undefined : requiredString(value.turnId, 'queued turnId');
  return {
    attachmentCount: requiredNonnegativeInteger(value.attachmentCount, 'queued attachmentCount'),
    clientMessageId: requiredString(value.clientMessageId, 'queued clientMessageId'),
    content: parseReference(value.content),
    dispatchOperationId: requiredString(value.dispatchOperationId, 'queued dispatchOperationId'),
    mentionCount: requiredNonnegativeInteger(value.mentionCount, 'queued mentionCount'),
    ...(parts ? { parts } : {}),
    preview: typeof value.preview === 'string' ? value.preview : '',
    ...(turnId ? { turnId } : {}),
  };
}

function artifactRef(artifact: StagedArtifact): DurableContentRef {
  return {
    kind: 'artifact',
    hash: artifact.hash,
    byteLength: artifact.byteLength,
    mediaType: artifact.mediaType,
    storagePath: artifact.storagePath,
  };
}

function artifactHash(ref: DurableContentRef) {
  return ref.kind === 'artifact' ? ref.hash : null;
}

function parseStoredUserParts(value: CanonicalJsonValue | undefined): AgentUserMessagePart[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index): AgentUserMessagePart => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Stored user message part ${index} is invalid.`);
    }
    if (entry.type === 'text') {
      return { text: requiredString(entry.text, `user part ${index} text`), type: 'text' };
    }
    if (entry.type === 'mention') {
      const kind = entry.kind;
      if (kind !== 'directory' && kind !== 'file') {
        throw new Error(`Stored user mention ${index} kind is invalid.`);
      }
      return {
        kind,
        name: requiredString(entry.name, `user part ${index} name`),
        path: requiredString(entry.path, `user part ${index} path`),
        type: 'mention',
      };
    }
    if (entry.type === 'image') {
      const sizeBytes = requiredNonnegativeInteger(entry.sizeBytes, `user part ${index} sizeBytes`);
      return {
        artifactHash: requiredHash(entry.artifactHash, `user part ${index} artifactHash`),
        mimeType: requiredString(entry.mimeType, `user part ${index} mimeType`),
        name: requiredString(entry.name, `user part ${index} name`),
        sizeBytes,
        type: 'image',
      };
    }
    throw new Error(`Stored user message part ${index} type is invalid.`);
  });
}

function parseReference(value: CanonicalJsonValue | undefined): DurableContentRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Durable content reference is invalid.');
  }
  const ref = value as Record<string, CanonicalJsonValue>;
  const kind = requiredString(ref.kind, 'kind');
  const byteLength = requiredNonnegativeInteger(ref.byteLength, 'byteLength');
  if (kind === 'inline') {
    const text = requiredString(ref.text, 'text');
    const sha256 = requiredHash(ref.sha256, 'sha256');
    if (Buffer.byteLength(text, 'utf8') !== byteLength) throw new Error('Inline content byte length is invalid.');
    if (createHash('sha256').update(text).digest('hex') !== sha256) {
      throw new Error('Inline content hash is invalid.');
    }
    return { kind, text, byteLength, sha256 };
  }
  if (kind !== 'artifact') throw new Error('Durable content reference kind is invalid.');
  return {
    kind,
    hash: requiredHash(ref.hash, 'hash'),
    byteLength,
    mediaType: requiredString(ref.mediaType, 'mediaType'),
    storagePath: requiredString(ref.storagePath, 'storagePath'),
  };
}

function normalizeJson(value: unknown): CanonicalJsonValue {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  return JSON.parse(serialized) as CanonicalJsonValue;
}

function boundedSafeInteger(value: number, min: number, max: number, label: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function matchingExcerpt(value: string, terms: readonly string[], maxCodePoints: number) {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const folded = normalized.toLocaleLowerCase();
  const first = terms.reduce((best, term) => {
    const index = folded.indexOf(term);
    return index < 0 ? best : Math.min(best, index);
  }, Number.POSITIVE_INFINITY);
  const codePoints = [...normalized];
  const center = Number.isFinite(first) ? first : 0;
  const start = Math.max(0, center - Math.floor(maxCodePoints / 4));
  const text = codePoints.slice(start, start + maxCodePoints).join('');
  return `${start > 0 ? '…' : ''}${text}${start + maxCodePoints < codePoints.length ? '…' : ''}`;
}

function journalSearchTerms(value: string) {
  return [...new Set(
    (value.toLocaleLowerCase().match(/[\p{L}\p{N}_./:@+-]+/gu) ?? [])
      .filter((term) => /[\p{L}\p{N}_]/u.test(term)),
  )];
}

function boundedUtf8Slice(bytes: Buffer, requestedOffset: number, maxBytes: number) {
  let offset = requestedOffset;
  while (offset < bytes.byteLength && (bytes[offset]! & 0xc0) === 0x80) offset += 1;
  let end = Math.min(bytes.byteLength, offset + maxBytes);
  while (end > offset && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return {
    offset,
    byteLength: end - offset,
    text: bytes.subarray(offset, end).toString('utf8'),
  };
}

function renderInspectableProviderPayload(value: unknown) {
  return JSON.stringify(sanitizeProviderPayload(value), null, 2) ?? 'null';
}

function sanitizeProviderPayload(value: unknown, key = ''): unknown {
  const normalizedKey = key.toLowerCase().replaceAll('-', '_');
  if (normalizedKey === 'previous_response_id') return value == null ? null : '[present]';
  if (normalizedKey === 'encrypted_content') return value == null ? null : '[opaque content present]';
  if (
    normalizedKey === 'headers' ||
    normalizedKey === 'authorization' ||
    normalizedKey === 'cookie' ||
    normalizedKey === 'set_cookie' ||
    normalizedKey === 'api_key' ||
    normalizedKey === 'access_token' ||
    normalizedKey === 'refresh_token' ||
    normalizedKey === 'id_token' ||
    normalizedKey === 'prompt_cache_key' ||
    normalizedKey.endsWith('_secret')
  ) return value == null ? null : '[redacted]';
  if (Array.isArray(value)) return value.map((entry) => sanitizeProviderPayload(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      sanitizeProviderPayload(entry, entryKey),
    ]));
  }
  return value;
}

function requiredString(value: CanonicalJsonValue | undefined, label: string) {
  if (typeof value !== 'string') throw new Error(`Durable ${label} is invalid.`);
  return value;
}

function requiredHash(value: CanonicalJsonValue | undefined, label: string) {
  const hash = requiredString(value, label);
  if (!/^[0-9a-f]{64}$/u.test(hash)) throw new Error(`Durable ${label} is invalid.`);
  return hash;
}

function requiredNonnegativeInteger(value: CanonicalJsonValue | undefined, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Durable ${label} is invalid.`);
  }
  return value;
}

function requiredTurnStatus(value: CanonicalJsonValue | undefined): DurableTurnStatus {
  if (
    value !== 'completed' && value !== 'failed' && value !== 'interrupted' &&
    value !== 'interrupted_by_restart'
  ) {
    throw new Error('Durable turn status is invalid.');
  }
  return value;
}

function terminalError(payload: Record<string, CanonicalJsonValue>) {
  return payload.error === null || payload.error === undefined
    ? null
    : requiredString(payload.error, 'error');
}

function terminalErrorCode(
  payload: Record<string, CanonicalJsonValue>,
  error: string | null,
): DurableTurnErrorCode | null {
  if (payload.errorCode === null) return null;
  if (payload.errorCode === undefined) return error ? 'provider_error' : null;
  if (
    payload.errorCode !== 'provider_error' &&
    payload.errorCode !== 'runtime_error' &&
    payload.errorCode !== 'storage_error'
  ) {
    throw new Error('Durable terminal error code is invalid.');
  }
  return payload.errorCode;
}

function terminalDuration(
  payload: Record<string, CanonicalJsonValue>,
  startedAt: number | undefined,
  completedAt: number,
) {
  if (payload.durationMs === undefined) {
    return Math.max(0, completedAt - (startedAt ?? completedAt));
  }
  if (typeof payload.durationMs !== 'number') {
    throw new Error('Durable terminal duration is invalid.');
  }
  return safeDuration(payload.durationMs);
}

function requiredProjectionItemId(value: string | undefined, label: string) {
  if (!value) throw new Error(`Durable ${label} is missing.`);
  return value;
}

function isReasoningLevel(value: string): value is ReasoningLevel {
  return value === 'off' || value === 'minimal' || value === 'low' || value === 'medium' ||
    value === 'high' || value === 'xhigh' || value === 'max';
}

function safeTimestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Recorded timestamp must be nonnegative.');
  return value;
}

function safeDuration(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('Turn duration must be nonnegative.');
  return Math.round(value);
}

function safeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function safeNonnegativeInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid ${label}.`);
  return Number(value);
}
