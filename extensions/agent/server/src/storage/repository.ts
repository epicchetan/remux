import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

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
  createDurableContextSnapshot,
  logicalMessageSemanticValue,
  reduceLogicalReplay,
  type DurableContextSnapshot,
  type LogicalContextMessage,
  type LogicalReplayEvent,
} from '../logical-context.ts';
import type { ShadowContextSource } from '../context/compiler.ts';
import type {
  ContextScope,
  ContextUpdateInput,
  ContextWorkspaceView,
  JournalOpenInput,
  JournalOpenResult,
  JournalSearchInput,
  JournalSearchResult,
  WorkUnitInput,
  WorkUnitResult,
} from '../engine.ts';
import {
  PROMPT_MANIFEST_VERSION,
  promptManifestValue,
  type PromptManifest,
  type ShadowContextCandidate,
} from '../context/manifest.ts';
import { compileProjectContext } from '../project-state/context.ts';
import type {
  ContextBinding,
  ContextSpace,
  ProjectPrimary,
  ProjectRelation,
  ProjectState,
  ProjectOperation,
  ProjectTransaction,
} from '../project-state/model.ts';
import { contextBindingKey } from '../project-state/model.ts';
import { applyProjectTransaction } from '../project-state/kernel.ts';
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
const MAX_EXACT_WORKING_RESOURCE_BYTES = 64 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const execFileAsync = promisify(execFile);

type PreparedWorkingResource = {
  body: CanonicalJsonValue;
  descriptor: CanonicalJsonValue;
  artifact?: StagedArtifact;
};

type ContextStorageAction =
  | { op: 'set'; scope: ContextScope; key: string; value: unknown; evidence: string[] }
  | { op: 'remove'; scope: ContextScope; key: string }
  | { op: 'pin'; scope: ContextScope; ref: string; label?: string }
  | { op: 'unpin'; scope: ContextScope; ref: string };

type ObservedRuntimeSnapshot = {
  cwd: string;
  gitRoot: string | null;
  head: string | null;
  dirtyPaths: string[];
  statusHash: string;
  observedAt: number;
  activeOperations: Array<{ operationId: string; kind: string; state: string }>;
  recentCommands: Array<{ ref: string; command: string; excerpt: string; exitCode: number | null; isError: boolean }>;
  recentFailures: Array<{ ref: string; excerpt: string }>;
  recentWorkUnits: Array<{ scopeRef: string; resultRef: string; traceRef: string; status: string; objective: string }>;
  changedPaths: string[];
};

type IdKind =
  | 'project'
  | 'space'
  | 'conversation'
  | 'strand'
  | 'turn'
  | 'scope'
  | 'epoch'
  | 'event'
  | 'operation'
  | 'item'
  | 'inference'
  | 'compilation'
  | 'primary';

export type AgentJournalRepositoryOptions = AgentDataRootOptions & {
  now?: () => number;
  idFactory?: (kind: IdKind) => string;
};

export type CreateConversationParams = {
  operationId: string;
  cwd: string;
  modelId: string;
  reasoning: ReasoningLevel;
  contextMode?: 'full-history' | 'stateful';
  workUnits?: boolean;
};

export type CreateConversationResult = {
  accepted: true;
  operationId: string;
  projectId: string;
  rootSpaceId: string;
  conversationId: string;
  rootStrandId: string;
  contextSpaceId?: string;
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
  epochId: string;
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
  shadowSource: ShadowContextSource;
  nextFrameOrdinal?: number;
};

export type DurableInferenceContext = {
  basisSequence: number;
  logicalHash: string;
  renderedHash: string;
  orderedMessageHashes: readonly string[];
  messageCount: number;
  fixedContractsHash: string;
  shadow: ShadowContextCandidate;
  shadowBuildDurationMs: number;
  activeMessages: readonly LogicalContextMessage[];
  contextMode?: 'full-history' | 'stateful';
  frameOrdinal?: number | null;
  pressureNotice?: boolean;
};

export type DurableWorkUnitTransition = {
  handle: DurableTurnHandle;
  result: WorkUnitResult;
};

type StoredCreateOutcome = {
  accepted: true;
  operationId: string;
  projectId: string;
  rootSpaceId: string;
  conversationId: string;
  contextSpaceId: string;
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
  root_space_id: string;
  context_space_id: string;
};

type ProjectRow = {
  project_id: string;
  root_space_id: string;
  revision: number;
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
  private readonly observedRuntime = new Map<string, ObservedRuntimeSnapshot>();
  private readonly dirtyRuntime = new Set<string>();

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

  createConversation(params: CreateConversationParams) {
    this.assertOpen();
    const normalized = validateCreateConversationParams(params);
    const argumentsHash = canonicalJsonHash({
      kind: CREATE_CONVERSATION_KIND,
      params: {
        cwd: normalized.cwd,
        modelId: normalized.modelId,
        reasoning: normalized.reasoning,
        workUnits: normalized.workUnits ?? false,
      },
    });
    return this.enqueueWrite(() => this.createConversationTransaction(normalized, argumentsHash));
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
      const recordedAt = safeTimestamp(this.now());
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'assistant.checkpoint',
        actor: 'model',
        visibility: 'transcript',
        payload,
        artifactHash: textArtifact?.artifact?.hash ?? reasoningArtifact?.artifact?.hash ?? null,
        createdAt: recordedAt,
      });
      this.insertArtifact(textArtifact?.artifact ?? null, sequence);
      this.insertArtifact(reasoningArtifact?.artifact ?? null, sequence);
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
      const duplicate = this.findToolItem(handle.turnId, input.callId);
      if (duplicate) return null;
      const recordedAt = safeTimestamp(this.now());
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'tool.called',
        actor: 'model',
        visibility: 'transcript',
        payload: { args: args.ref, callId: input.callId, name: input.name },
        artifactHash: artifactHash(args.ref),
        createdAt: recordedAt,
      });
      this.insertArtifact(args.artifact, sequence);
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
    const item = this.findToolItem(handle.turnId, input.callId);
    if (item) {
      const value = JSON.parse(item.value_json) as Record<string, CanonicalJsonValue>;
      if (value.name === 'bash' || value.name === 'edit' || value.name === 'write') {
        this.dirtyRuntime.add(handle.conversationId);
      }
    }
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
    const compilationId = this.nextId('compilation');
    const dispatch = await this.prepareText(renderInspectableProviderPayload(input.payload), true);
    if (!dispatch.artifact) throw new Error('Provider dispatch payload must be stored durably.');
    const dispatchArtifact = dispatch.artifact;
    const manifestValue: PromptManifest = {
      version: PROMPT_MANIFEST_VERSION,
      compilerVersion: input.context.shadow.compilerVersion,
      policyVersion: input.context.shadow.policyVersion,
      piVersion: '0.84.0',
      provider: 'openai-codex',
      modelId: input.modelId,
      projectId: handle.projectId,
      conversationId: handle.conversationId,
      strandId: handle.strandId,
      turnId: handle.turnId,
      scopeId: handle.scopeId,
      epochId: handle.epochId,
      inferenceId,
      basisSequence: input.context.basisSequence,
      projectRevision: input.context.shadow.projectRevision,
      targetContextSpaceId: input.context.shadow.targetContextSpaceId,
      active: {
        mode: input.context.contextMode === 'stateful' ? 'stateful-frame' : 'full-history',
        frameOrdinal: input.context.frameOrdinal ?? null,
        pressureNotice: input.context.pressureNotice ?? false,
        logicalHash: input.context.logicalHash,
        renderedHash: input.context.renderedHash,
        orderedMessageHashes: input.context.orderedMessageHashes,
        messageCount: input.context.messageCount,
        estimatedInputTokens: input.estimatedInputTokens,
      },
      candidate: {
        mode: input.context.contextMode === 'stateful' ? 'authoritative' : 'diagnostic',
        semanticHash: input.context.shadow.semanticHash,
        bootstrapHash: input.context.shadow.bootstrapHash,
        estimatedInputTokens: input.context.shadow.estimatedInputTokens,
        decision: input.context.shadow.decision,
        blocks: input.context.shadow.blocks.map(({ kind, hash, estimatedTokens, sources }) => ({
          kind,
          hash,
          estimatedTokens,
          sources,
        })),
        omissions: input.context.shadow.omissions,
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
      this.prepareText(input.context.shadow.bootstrap, true),
    ]);
    if (!manifest.artifact || !bootstrap.artifact) {
      throw new Error('Inference context artifacts must be stored durably.');
    }
    if (bootstrap.sha256 !== input.context.shadow.bootstrapHash) {
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
        SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM inferences WHERE epoch_id = ?
      `).get(handle.epochId) as { ordinal: number };
      const ordinal = safeInteger(ordinalRow.ordinal, 'inference ordinal');
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
          compilationId,
          estimatedInputTokens: input.estimatedInputTokens,
          frameRef: `journal://frame/${encodeURIComponent(compilationId)}`,
          inferenceId,
          inputHash: input.context.renderedHash,
          manifestArtifactHash: manifestArtifact.hash,
          manifestVersion: PROMPT_MANIFEST_VERSION,
          contextLogicalHash: input.context.logicalHash,
          contextMessageCount: input.context.messageCount,
          contextRenderedHash: input.context.renderedHash,
          contextMode: input.context.contextMode ?? 'full-history',
          frameOrdinal: input.context.frameOrdinal ?? null,
          pressureNotice: input.context.pressureNotice ?? false,
          shadowBootstrapHash: bootstrapArtifact.hash,
          shadowDecision: input.context.shadow.decision.kind,
          shadowSemanticHash: input.context.shadow.semanticHash,
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
        INSERT INTO inferences (
          inference_id, project_id, conversation_id, strand_id, turn_id,
          scope_id, epoch_id, ordinal, basis_sequence, state, request_mode,
          manifest_artifact_hash, input_hash, estimated_input_tokens,
          reported_input_tokens, reported_output_tokens, started_sequence,
          terminal_sequence, manifest_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)
      `).run(
        inferenceId,
        handle.projectId,
        handle.conversationId,
        handle.strandId,
        handle.turnId,
        handle.scopeId,
        handle.epochId,
        ordinal,
        basisSequence,
        input.requestMode,
        manifestArtifact.hash,
        input.context.renderedHash,
        input.estimatedInputTokens,
        sequence,
        PROMPT_MANIFEST_VERSION,
      );
      this.storage.database.prepare(`
        INSERT INTO context_compilations (
          compilation_id, inference_id, project_id, conversation_id,
          strand_id, turn_id, scope_id, epoch_id, basis_sequence,
          project_revision, target_space_id, mode, compiler_version,
          policy_version, decision, manifest_artifact_hash,
          bootstrap_artifact_hash, semantic_hash,
          active_estimated_input_tokens, candidate_estimated_input_tokens,
          build_duration_ms, created_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        compilationId,
        inferenceId,
        handle.projectId,
        handle.conversationId,
        handle.strandId,
        handle.turnId,
        handle.scopeId,
        handle.epochId,
        basisSequence,
        input.context.shadow.projectRevision,
        input.context.shadow.targetContextSpaceId,
        input.context.contextMode === 'stateful' ? 'active' : 'shadow',
        input.context.shadow.compilerVersion,
        input.context.shadow.policyVersion,
        input.context.shadow.decision.kind,
        manifestArtifact.hash,
        bootstrapArtifact.hash,
        input.context.shadow.semanticHash,
        input.estimatedInputTokens,
        input.context.shadow.estimatedInputTokens,
        safeNonnegativeInteger(input.context.shadowBuildDurationMs, 'shadow build duration'),
        sequence,
      );
      const inspector = contextInspectorValue({
        manifest: manifestValue,
        manifestArtifact,
        bootstrapArtifact,
        dispatchArtifact,
        activeMessages: input.context.activeMessages,
        buildDurationMs: input.context.shadowBuildDurationMs,
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
      if (inspector.inferenceId !== inference.inference_id || !inspector.actual) {
        throw new Error('Inference context inspector does not match the active provider call.');
      }
      inspector.actual.transportMode = input.actualRequestMode;
      this.upsertResource(resourceKey, sequence, inspector, recordedAt);
      return true;
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
        SELECT inference_id
        FROM inferences
        WHERE scope_id = ? AND state = 'running'
        ORDER BY ordinal DESC LIMIT 1
      `).get(handle.scopeId) as { inference_id: string } | undefined;
      if (!inference) return false;
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: `inference.${input.state}`,
        actor: 'harness',
        visibility: 'internal',
        payload: {
          inferenceId: inference.inference_id,
          reportedInputTokens: input.reportedInputTokens ?? null,
          reportedOutputTokens: input.reportedOutputTokens ?? null,
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
        input.reportedInputTokens ?? null,
        input.reportedOutputTokens ?? null,
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
      return this.finishTurnTransaction(
        handle,
        input.status,
        error,
        input.errorCode ?? (error ? 'runtime_error' : null),
        input.durationMs,
        assistant,
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
      FROM artifacts WHERE hash = ?
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

  async compileContext(conversationId: string): Promise<DurableContextBoundarySnapshot> {
    this.assertOpen();
    await this.writerTail;
    const activeScope = this.activeScopeIdentity(conversationId);
    const observedRuntime = await this.observeRuntimeState(conversationId, activeScope.cwd);
    const allEvents = await this.readEvents({ conversationId });
    const workUnitScopes = new Set((this.storage.database.prepare(`
      SELECT scope_id FROM execution_scopes
      WHERE conversation_id = ? AND kind = 'work_unit'
    `).all(conversationId) as Array<{ scope_id: string }>).map(({ scope_id }) => scope_id));
    const restartSequence = activeScope.kind === 'work_unit'
      ? allEvents.findLast((event) =>
          event.scopeId === activeScope.scopeId && event.type === 'message.internal' &&
          event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) &&
          (event.payload as Record<string, CanonicalJsonValue>).kind === 'work_unit_restart')?.sequence
      : undefined;
    const events = allEvents.filter((event) => {
      if (activeScope.kind === 'work_unit') {
        return event.type === 'message.user' && event.turnId === activeScope.turnId ||
          event.scopeId === activeScope.scopeId &&
            (restartSequence === undefined || event.sequence >= restartSequence);
      }
      return !event.scopeId || !workUnitScopes.has(event.scopeId);
    });
    if (events.length === 0) throw new Error(`Conversation ${conversationId} does not exist.`);
    const [replay, shadowReplay] = await Promise.all([
      this.logicalReplayEvents(allEvents),
      this.logicalReplayEvents(events),
    ]);
    const snapshot = createDurableContextSnapshot(
      allEvents.at(-1)?.sequence ?? 0,
      reduceLogicalReplay(replay),
    );
    const shadowSnapshot = createDurableContextSnapshot(
      allEvents.at(-1)?.sequence ?? 0,
      reduceLogicalReplay(shadowReplay),
    );
    const frameRow = this.storage.database.prepare(`
      SELECT MAX(CAST(json_extract(payload_json, '$.frameOrdinal') AS INTEGER)) AS frame_ordinal
      FROM events
      WHERE conversation_id = ?
        AND type = 'inference.started'
        AND json_type(payload_json, '$.frameOrdinal') = 'integer'
    `).get(conversationId) as { frame_ordinal: number | null };
    const nextFrameOrdinal = frameRow.frame_ordinal === null
      ? 0
      : safeNonnegativeInteger(frameRow.frame_ordinal, 'context frame ordinal') + 1;
    return {
      ...snapshot,
      shadowSource: this.readShadowContextSource(conversationId, shadowSnapshot, observedRuntime),
      nextFrameOrdinal,
    };
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
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    type Candidate = JournalSearchResult['hits'][number] & { rank: number; text: string };
    const candidates: Candidate[] = [];
    const primaryRows = this.storage.database.prepare(`
      SELECT primary_id, key, kind, descriptor_json, body_json, updated_revision,
             lifecycle, updated_sequence
      FROM project_primaries
      WHERE project_id = ?
      ORDER BY updated_revision DESC, primary_id
    `).all(identity.projectId) as Array<{
      primary_id: string;
      key: string;
      kind: string;
      descriptor_json: string;
      body_json: string;
      updated_revision: number;
      lifecycle: string;
      updated_sequence: number;
    }>;
    for (const row of primaryRows) {
      const searchable = `${row.key}\n${row.kind}\n${row.descriptor_json}\n${row.body_json}`;
      candidates.push({
        ref: `journal://primary/${encodeURIComponent(row.primary_id)}`,
        kind: `context:${row.kind}`,
        excerpt: '',
        revision: safeNonnegativeInteger(row.updated_revision, 'primary search revision'),
        sequence: safeInteger(row.updated_sequence, 'primary updated sequence'),
        historical: row.lifecycle !== 'active',
        rank: row.lifecycle === 'active' ? 0 : 4,
        text: searchable,
      });
    }
    const userRows = this.storage.database.prepare(`
      SELECT sequence, event_id, project_id, conversation_id, strand_id,
             turn_id, scope_id, type, actor, visibility, causal_event_id,
             operation_id, payload_json, artifact_hash, created_at
      FROM events
      WHERE project_id = ? AND type = 'message.user'
        AND (? = 'project' OR conversation_id = ?)
      ORDER BY sequence DESC
    `).all(identity.projectId, scope, conversationId) as EventRow[];
    for (const row of userRows) {
      const event = decodeEventRow(row);
      const payload = await this.expandEventPayload(event);
      candidates.push({
        ref: `journal://event/${event.sequence}`,
        kind: 'user-message',
        excerpt: '',
        conversationId: event.conversationId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        sequence: event.sequence,
        historical: event.conversationId !== conversationId,
        rank: 1,
        text: canonicalJson(payload),
      });
    }
    const assistantRows = this.storage.database.prepare(`
      SELECT ti.item_id, ti.turn_id, ti.first_sequence, ti.last_sequence,
             ti.status, t.conversation_id
      FROM transcript_items ti
      JOIN turns t ON t.turn_id = ti.turn_id
      WHERE t.project_id = ? AND ti.kind = 'assistant'
        AND (? = 'project' OR t.conversation_id = ?)
      ORDER BY ti.last_sequence DESC, ti.item_id
    `).all(identity.projectId, scope, conversationId) as Array<{
      item_id: string; turn_id: string; first_sequence: number; last_sequence: number;
      status: string; conversation_id: string;
    }>;
    for (const row of assistantRows) {
      const text = await this.assistantVisibleText(row.turn_id);
      if (!text) continue;
      candidates.push({
        ref: `journal://message/${encodeURIComponent(row.item_id)}`,
        kind: row.status === 'completed' ? 'assistant-outcome' : 'assistant-proposal',
        excerpt: '',
        conversationId: row.conversation_id,
        turnId: row.turn_id,
        sequence: safeInteger(row.last_sequence, 'assistant search sequence'),
        historical: row.conversation_id !== conversationId,
        rank: 2,
        text,
      });
    }
    const completedRows = this.storage.database.prepare(`
      SELECT turn_id, conversation_id, state, terminal_sequence
      FROM turns WHERE project_id = ? AND terminal_sequence IS NOT NULL
        AND (? = 'project' OR conversation_id = ?)
      ORDER BY terminal_sequence DESC
    `).all(identity.projectId, scope, conversationId) as Array<{
      turn_id: string; conversation_id: string; state: string; terminal_sequence: number;
    }>;
    for (const row of completedRows) {
      candidates.push({
        ref: `journal://turn/${encodeURIComponent(row.turn_id)}`,
        kind: 'turn-outcome',
        excerpt: '',
        conversationId: row.conversation_id,
        turnId: row.turn_id,
        sequence: safeInteger(row.terminal_sequence, 'turn terminal sequence'),
        historical: row.conversation_id !== conversationId,
        rank: 3,
        text: `turn ${row.turn_id} ${row.state} ${await this.assistantVisibleText(row.turn_id)}`,
      });
    }
    const workRows = this.storage.database.prepare(`
      SELECT scope_id, conversation_id, turn_id, objective_json, state,
             terminal_sequence, result_artifact_hash
      FROM execution_scopes
      WHERE project_id = ? AND kind = 'work_unit' AND result_artifact_hash IS NOT NULL
        AND (? = 'project' OR conversation_id = ?)
      ORDER BY terminal_sequence DESC, scope_id
    `).all(identity.projectId, scope, conversationId) as Array<{
      scope_id: string; conversation_id: string; turn_id: string; objective_json: string;
      state: string; terminal_sequence: number; result_artifact_hash: string;
    }>;
    for (const row of workRows) {
      const resultRef = `journal://artifact/${row.result_artifact_hash}`;
      candidates.push({
        ref: resultRef,
        kind: 'work-unit-result',
        excerpt: '',
        conversationId: row.conversation_id,
        turnId: row.turn_id,
        sequence: safeInteger(row.terminal_sequence, 'work unit terminal sequence'),
        historical: row.conversation_id !== conversationId,
        rank: 3,
        text: `${row.objective_json}\n${await this.openArtifactText(identity.projectId, row.result_artifact_hash)}`,
      });
    }
    if (input.include === 'operations') {
      const operationRows = this.storage.database.prepare(`
        SELECT sequence, event_id, project_id, conversation_id, strand_id,
               turn_id, scope_id, type, actor, visibility, causal_event_id,
               operation_id, payload_json, artifact_hash, created_at
        FROM events
        WHERE project_id = ? AND type = 'tool.called'
          AND json_extract(payload_json, '$.name') <> 'journal_search'
          AND (? = 'project' OR conversation_id = ?)
        ORDER BY sequence DESC
      `).all(identity.projectId, scope, conversationId) as EventRow[];
      for (const row of operationRows) {
        const event = decodeEventRow(row);
        const payload = await this.expandEventPayload(event) as Record<string, CanonicalJsonValue>;
        const callId = requiredString(payload.callId, 'search operation callId');
        candidates.push({
          ref: `journal://tool/${encodeURIComponent(callId)}`,
          kind: `operation:${requiredString(payload.name, 'search operation name')}`,
          excerpt: '',
          conversationId: event.conversationId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          sequence: event.sequence,
          historical: event.conversationId !== conversationId,
          rank: 5,
          text: canonicalJson(payload),
        });
      }
    }
    const matches = candidates
      .filter((candidate) => {
        const folded = candidate.text.toLocaleLowerCase();
        return terms.every((term) => folded.includes(term));
      })
      .sort((left, right) => left.rank - right.rank ||
        (right.sequence ?? 0) - (left.sequence ?? 0) || left.ref.localeCompare(right.ref));
    const deduped = [...new Map(matches.map((candidate) => [candidate.ref, candidate])).values()];
    const hits = deduped.slice(0, limit).map(({ rank: _rank, text, ...hit }) => ({
      ...hit,
      excerpt: matchingExcerpt(text, terms, 480),
    }));
    return {
      query,
      scope,
      hits,
      truncated: deduped.length > hits.length,
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

    const primaryMatch = /^journal:\/\/primary\/([^/?#]+)$/u.exec(ref) ??
      /^agent:\/\/project\/([^/?#]+)\/primary\/([^/?#]+)(?:\?[^#]*)?$/u.exec(ref);
    if (primaryMatch) {
      const isAgent = ref.startsWith('agent://');
      if (isAgent && decodeURIComponent(primaryMatch[1]!) !== identity.projectId) {
        throw new Error(`Primary reference ${ref} belongs to another project.`);
      }
      const primaryId = decodeURIComponent(primaryMatch[isAgent ? 2 : 1]!);
      const row = this.storage.database.prepare(`
        SELECT primary_id, home_space_id, key, kind, descriptor_json, body_json,
               authority, provenance_json, lifecycle, version, created_revision,
               updated_revision
        FROM project_primaries WHERE project_id = ? AND primary_id = ?
      `).get(identity.projectId, primaryId) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Journal primary ${primaryId} does not exist in this project.`);
      return canonicalJson({
        authority: requiredPrimaryAuthority(row.authority),
        body: JSON.parse(requiredString(row.body_json as CanonicalJsonValue, 'primary body')) as CanonicalJsonValue,
        createdRevision: safeNonnegativeInteger(row.created_revision, 'primary created revision'),
        descriptor: JSON.parse(requiredString(row.descriptor_json as CanonicalJsonValue, 'primary descriptor')) as CanonicalJsonValue,
        homeSpaceId: requiredString(row.home_space_id as CanonicalJsonValue, 'primary home space'),
        id: requiredString(row.primary_id as CanonicalJsonValue, 'primary id'),
        key: requiredString(row.key as CanonicalJsonValue, 'primary key'),
        kind: requiredString(row.kind as CanonicalJsonValue, 'primary kind'),
        lifecycle: requiredPrimaryLifecycle(row.lifecycle),
        provenance: requiredStringArray(row.provenance_json, 'primary provenance'),
        updatedRevision: safeNonnegativeInteger(row.updated_revision, 'primary updated revision'),
        version: safePositiveInteger(row.version, 'primary version'),
      });
    }

    const artifactMatch = /^journal:\/\/artifact\/([0-9a-f]{64})$/u.exec(ref);
    if (artifactMatch) return this.openArtifactText(identity.projectId, artifactMatch[1]!);

    const messageMatch = /^journal:\/\/message\/([^/?#]+)$/u.exec(ref);
    if (messageMatch) {
      const itemId = decodeURIComponent(messageMatch[1]!);
      const row = this.storage.database.prepare(`
        SELECT ti.item_id, ti.turn_id, ti.kind, ti.status, ti.value_json,
               ti.first_sequence, ti.last_sequence
        FROM transcript_items ti
        JOIN turns t ON t.turn_id = ti.turn_id
        WHERE t.project_id = ? AND ti.item_id = ?
      `).get(identity.projectId, itemId) as {
        item_id: string; turn_id: string; kind: string; status: string;
        value_json: string; first_sequence: number; last_sequence: number;
      } | undefined;
      if (!row) throw new Error(`Journal message ${itemId} does not exist in this project.`);
      const events = await this.expandedEventsFor('turn_id = ? AND sequence BETWEEN ? AND ?', [
        row.turn_id, row.first_sequence, row.last_sequence,
      ]);
      return canonicalJson({
        id: row.item_id,
        turnId: row.turn_id,
        kind: row.kind,
        status: row.status,
        projection: JSON.parse(row.value_json) as CanonicalJsonValue,
        events,
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
          SELECT item_id FROM transcript_items WHERE turn_id = ? AND kind = 'assistant'
        `).get(turnId) as { item_id: string } | undefined;
        if (!item) throw new Error(`Turn ${turnId} has no assistant message.`);
        return this.resolveOpenableContent(conversationId, `journal://message/${encodeURIComponent(item.item_id)}`);
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

    const omissionMatch = /^journal:\/\/omission\/([0-9a-f]{64})$/u.exec(ref);
    if (omissionMatch) {
      const rows = this.storage.database.prepare(`
        SELECT manifest_artifact_hash FROM context_compilations
        WHERE project_id = ? ORDER BY created_sequence DESC
      `).all(identity.projectId) as Array<{ manifest_artifact_hash: string }>;
      for (const row of rows) {
        const manifest = JSON.parse(await this.openArtifactText(
          identity.projectId,
          row.manifest_artifact_hash,
        )) as { candidate?: { omissions?: Array<Record<string, unknown>> } };
        const omission = manifest.candidate?.omissions?.find((candidate) => candidate.ref === ref);
        if (omission) return canonicalJson(normalizeJson(omission));
      }
      throw new Error(`Context omission ${omissionMatch[1]} does not exist in this project.`);
    }

    const frameMatch = /^journal:\/\/frame\/([^/?#]+)$/u.exec(ref);
    if (frameMatch) {
      const compilationId = decodeURIComponent(frameMatch[1]!);
      const row = this.storage.database.prepare(`
        SELECT compilation_id, basis_sequence, project_revision, target_space_id,
               decision, manifest_artifact_hash, bootstrap_artifact_hash,
               semantic_hash, active_estimated_input_tokens,
               candidate_estimated_input_tokens
        FROM context_compilations WHERE project_id = ? AND compilation_id = ?
      `).get(identity.projectId, compilationId) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Context frame ${compilationId} does not exist in this project.`);
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
      const state = this.readProjectState(identity.projectId, identity.rootSpaceId);
      return canonicalJson({ projectId: state.projectId, revision: state.revision, rootSpaceId: state.rootSpaceId });
    }

    const agentEpoch = /^agent:\/\/epoch\/([^/?#]+)$/u.exec(ref);
    if (agentEpoch) {
      const epochId = decodeURIComponent(agentEpoch[1]!);
      const row = this.storage.database.prepare(`
        SELECT epoch_id, scope_id, ordinal, state, policy_version,
               opened_sequence, closed_sequence, close_reason, bootstrap_artifact_hash
        FROM epochs WHERE project_id = ? AND epoch_id = ?
      `).get(identity.projectId, epochId) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Epoch ${epochId} does not exist in this project.`);
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
      JOIN events e ON e.sequence = a.created_sequence
      WHERE a.hash = ? AND e.project_id = ?
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

  async updateContext(
    handle: DurableTurnHandle,
    input: ContextUpdateInput,
  ): Promise<ContextWorkspaceView> {
    this.assertOpen();
    await this.writerTail;
    this.assertRunningHandle(handle);
    const actions = contextStorageActions(input);
    const preparedIdentity = this.contextIdentity(handle.conversationId);
    for (const action of actions) {
      if (action.op !== 'set') continue;
      for (const ref of action.evidence) await this.resolveOpenableContent(handle.conversationId, ref);
    }
    const workingResources = await this.prepareWorkingResources(
      handle.conversationId,
      preparedIdentity.cwd,
      actions,
    );
    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const identity = this.contextIdentity(handle.conversationId);
      const active = this.activeScopeIdentity(handle.conversationId);
      const before = this.readProjectState(identity.projectId, identity.rootSpaceId);
      const eventId = this.nextId('event');
      const operations = this.contextOperations(
        before,
        active.targetSpaceId,
        actions,
        `journal://event-id/${eventId}`,
        workingResources,
        active.kind,
      );
      if (operations.length === 0) {
        return this.contextWorkspaceView(before, active.targetSpaceId, [
          'No durable context change was needed.',
        ]);
      }
      const transaction: ProjectTransaction = {
        operationId: `context:${eventId}`,
        projectId: before.projectId,
        basisRevision: before.revision,
        operations,
      };
      const after = applyProjectTransaction(before, transaction);
      const recordedAt = safeTimestamp(this.now());
      const sequence = this.insertEvent({
        ...handle,
        eventId,
        type: 'context.managed',
        actor: 'model',
        visibility: 'internal',
        payload: {
          update: normalizeJson(input),
          actions: normalizeJson(actions),
          basisRevision: before.revision,
          revision: after.revision,
        },
        createdAt: recordedAt,
      });
      for (const prepared of workingResources.values()) {
        if (prepared.artifact) this.insertArtifact(prepared.artifact, sequence);
      }
      this.persistProjectStateDelta(before, after, sequence, recordedAt);
      return this.contextWorkspaceView(after, active.targetSpaceId);
    }));
  }

  async workUnit(
    handle: DurableTurnHandle,
    input: WorkUnitInput,
  ): Promise<DurableWorkUnitTransition> {
    this.assertOpen();
    await this.writerTail;
    this.assertRunningHandle(handle);
    return input.action === 'enter'
      ? this.enterWorkUnit(handle, input)
      : this.returnWorkUnit(handle, input);
  }

  async completeWorkUnitImplicit(
    handle: DurableTurnHandle,
    input: { text: string; reasoning: string; state?: 'completed' | 'failed' | 'interrupted' },
  ): Promise<DurableWorkUnitTransition & { parentIntegrationPrompt: string }> {
    const active = this.activeScopeIdentity(handle.conversationId);
    if (active.kind !== 'work_unit' || active.scopeId !== handle.scopeId) {
      throw new Error('No active work unit can be completed implicitly.');
    }
    const [text, reasoning] = await Promise.all([
      this.prepareText(input.text),
      this.prepareText(input.reasoning),
    ]);
    await this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'assistant.checkpoint',
        actor: 'model',
        visibility: 'internal',
        payload: { provisionalWorkUnitResult: true, text: text.ref, reasoning: reasoning.ref },
        artifactHash: text.artifact?.hash ?? reasoning.artifact?.hash ?? null,
        createdAt: safeTimestamp(this.now()),
      });
      this.insertArtifact(text.artifact, sequence);
      this.insertArtifact(reasoning.artifact, sequence);
    }));
    await this.finishInference(handle, { state: input.state ?? 'completed' });
    const transition = await this.returnWorkUnit(handle, {
      action: 'return',
      status: input.state === 'completed' || input.state === undefined ? 'completed' : 'failed',
      findings: input.text.trim()
        ? [{ text: input.text.trim(), evidence: [] }]
        : [],
      unresolved: ['The child emitted terminal text without an explicit work_unit return; the parent must validate and integrate the provisional result.'],
    }, 'implicit');
    const parentIntegrationPrompt = [
      'A child work unit returned implicitly.',
      `Inspect its bounded result at ${transition.result.resultRef}.`,
      'Integrate or validate it in the parent context, then answer the original user request.',
      'Do not expose this internal coordination message.',
    ].join(' ');
    const content = await this.prepareText(parentIntegrationPrompt);
    await this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(transition.handle);
      const sequence = this.insertEvent({
        ...transition.handle,
        eventId: this.nextId('event'),
        type: 'message.internal',
        actor: 'harness',
        visibility: 'internal',
        payload: { content: content.ref, kind: 'work_unit_parent_integration' },
        artifactHash: artifactHash(content.ref),
        createdAt: safeTimestamp(this.now()),
      });
      this.insertArtifact(content.artifact, sequence);
    }));
    return { ...transition, parentIntegrationPrompt };
  }

  async resumeActiveWorkUnit(conversationId: string): Promise<{
    handle: DurableTurnHandle;
    prompt: string;
  } | null> {
    this.assertOpen();
    await this.writerTail;
    const present = this.storage.database.prepare(`
      SELECT 1 AS present
      FROM execution_scopes s
      JOIN turns t ON t.turn_id = s.turn_id
      WHERE s.conversation_id = ? AND s.kind = 'work_unit'
        AND s.state = 'running' AND t.state = 'running'
      LIMIT 1
    `).get(conversationId);
    if (!present) return null;
    const active = this.activeScopeIdentity(conversationId);
    if (active.kind !== 'work_unit') return null;
    const objective = active.objective && typeof active.objective === 'object' && !Array.isArray(active.objective)
      ? active.objective as Record<string, CanonicalJsonValue>
      : {};
    const capsuleRef = typeof objective.capsuleRef === 'string' ? objective.capsuleRef : null;
    if (!capsuleRef) throw new Error(`Active work unit ${active.scopeId} has no capsule reference.`);
    const prompt = [
      'Resume the active work unit after a runtime restart.',
      `Reopen its capsule at ${capsuleRef}.`,
      'Re-observe mutable filesystem state before relying on prior scratch, then continue or return a bounded result.',
    ].join(' ');
    const content = await this.prepareText(prompt);
    const handle: DurableTurnHandle = {
      projectId: active.projectId,
      conversationId,
      strandId: active.strandId,
      turnId: active.turnId,
      scopeId: active.scopeId,
      epochId: active.epochId,
    };
    await this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'message.internal',
        actor: 'harness',
        visibility: 'internal',
        payload: { capsuleRef, content: content.ref, kind: 'work_unit_restart' },
        artifactHash: artifactHash(content.ref),
        createdAt: safeTimestamp(this.now()),
      });
      this.insertArtifact(content.artifact, sequence);
    }));
    this.dirtyRuntime.add(conversationId);
    return { handle, prompt };
  }

  private async enterWorkUnit(
    handle: DurableTurnHandle,
    input: Extract<WorkUnitInput, { action: 'enter' }>,
  ): Promise<DurableWorkUnitTransition> {
    const active = this.activeScopeIdentity(handle.conversationId);
    if (active.kind !== 'turn' || active.scopeId !== handle.scopeId) {
      throw new Error('Nested or concurrent work units are not supported.');
    }
    const objective = input.objective.trim();
    if (!objective) throw new TypeError('A work-unit objective is required.');
    const refs = [...new Set(input.refs ?? [])];
    if (refs.length > 16) throw new TypeError('A work unit may receive at most 16 explicit refs.');
    for (const ref of refs) await this.resolveOpenableContent(handle.conversationId, ref);
    this.dirtyRuntime.add(handle.conversationId);
    const baseWorkspace = await this.observeRuntimeState(handle.conversationId, active.cwd);
    const context = await this.compileContext(handle.conversationId);
    const childScopeId = this.nextId('scope');
    const childEpochId = this.nextId('epoch');
    const childSpaceId = this.nextId('space');
    const capsuleValue = canonicalInput({
      version: 1,
      objective,
      basisSequence: context.basisSequence,
      parentScopeRef: `journal://scope/${encodeURIComponent(active.scopeId)}`,
      turnAnchor: context.shadowSource.turnAnchor,
      applicablePrimaries: context.shadowSource.authority.map((entry) => ({
        key: entry.key,
        kind: entry.kind,
        ref: `journal://primary/${encodeURIComponent(entry.primaryId)}`,
        version: entry.version,
      })),
      refs,
      expectedEvidence: input.expectedEvidence ?? [],
      baseWorkspace,
      authority: {
        inheritsCurrentUserAuthority: true,
        commitOrPushRequiresExplicitUserAuthority: true,
      },
    }, 'work-unit capsule');
    const capsule = await this.prepareJson(capsuleValue, true);
    if (!capsule.artifact) throw new Error('Work-unit capsule must be stored as an artifact.');
    const capsuleRef = `journal://artifact/${capsule.artifact.hash}`;
    const childHandle: DurableTurnHandle = {
      projectId: handle.projectId,
      conversationId: handle.conversationId,
      strandId: handle.strandId,
      turnId: handle.turnId,
      scopeId: childScopeId,
      epochId: childEpochId,
    };
    await this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const stillActive = this.activeScopeIdentity(handle.conversationId);
      if (stillActive.kind !== 'turn' || stillActive.scopeId !== handle.scopeId) {
        throw new Error('Another work unit became active before this one could enter.');
      }
      const recordedAt = safeTimestamp(this.now());
      const scopeSequence = this.insertEvent({
        ...childHandle,
        eventId: this.nextId('event'),
        type: 'work_unit.entered',
        actor: 'model',
        visibility: 'internal',
        payload: {
          capsuleRef,
          expectedEvidence: input.expectedEvidence ?? [],
          objective,
          parentScopeId: handle.scopeId,
          refs,
          scopeId: childScopeId,
        },
        artifactHash: capsule.artifact!.hash,
        createdAt: recordedAt,
      });
      this.insertArtifact(capsule.artifact!, scopeSequence);
      const epochSequence = this.insertEvent({
        ...childHandle,
        eventId: this.nextId('event'),
        type: 'epoch.opened',
        actor: 'harness',
        visibility: 'internal',
        payload: {
          epochId: childEpochId,
          mode: 'work_unit_capsule',
          ordinal: 0,
          scopeId: childScopeId,
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
        childScopeId,
        handle.projectId,
        handle.conversationId,
        handle.strandId,
        handle.turnId,
        handle.scopeId,
        canonicalJson({
          objective,
          refs,
          expectedEvidence: input.expectedEvidence ?? [],
          capsuleRef,
          baseWorkspace,
        }),
        scopeSequence,
        recordedAt,
        recordedAt,
      );
      this.storage.database.prepare(`
        INSERT INTO epochs (
          epoch_id, project_id, conversation_id, strand_id, turn_id, scope_id,
          ordinal, state, policy_version, opened_sequence, closed_sequence,
          close_reason, bootstrap_artifact_hash, basis_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 'open', ?, ?, NULL, NULL, ?, ?)
      `).run(
        childEpochId,
        handle.projectId,
        handle.conversationId,
        handle.strandId,
        handle.turnId,
        childScopeId,
        'agent-context-policy-v2',
        epochSequence,
        capsule.artifact!.hash,
        scopeSequence,
      );
      const project = this.storage.database.prepare(`
        SELECT revision FROM projects WHERE project_id = ?
      `).get(handle.projectId) as { revision: number };
      const nextRevision = safeNonnegativeInteger(project.revision, 'project revision') + 1;
      this.storage.database.prepare(`
        INSERT INTO context_spaces (
          space_id, project_id, parent_space_id, key, descriptor_json,
          created_revision, created_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        childSpaceId,
        handle.projectId,
        stillActive.targetSpaceId,
        `work-unit:${childScopeId}`,
        canonicalJson({ capsuleRef, kind: 'work_unit', objective, scopeId: childScopeId }),
        nextRevision,
        scopeSequence,
      );
      this.storage.database.prepare(`
        UPDATE projects SET revision = ?, updated_sequence = ?, updated_at = ?
        WHERE project_id = ? AND revision = ?
      `).run(nextRevision, scopeSequence, recordedAt, handle.projectId, project.revision);
    }));
    this.dirtyRuntime.add(handle.conversationId);
    return {
      handle: childHandle,
      result: {
        action: 'entered',
        scopeId: childScopeId,
        parentScopeId: handle.scopeId,
        epochId: childEpochId,
        capsuleRef,
        traceRef: `journal://scope/${encodeURIComponent(childScopeId)}/trace`,
        status: 'running',
      },
    };
  }

  private async returnWorkUnit(
    handle: DurableTurnHandle,
    input: Extract<WorkUnitInput, { action: 'return' }>,
    returnMode: 'explicit' | 'implicit' = 'explicit',
  ): Promise<DurableWorkUnitTransition> {
    const active = this.activeScopeIdentity(handle.conversationId);
    if (active.kind !== 'work_unit' || active.scopeId !== handle.scopeId || !active.parentScopeId) {
      throw new Error('No work unit is active to return.');
    }
    const citedRefs = [...new Set([
      ...input.findings.flatMap(({ evidence }) => evidence),
      ...(input.changeRefs ?? []),
      ...(input.validationRefs ?? []),
    ])];
    for (const ref of citedRefs) await this.resolveOpenableContent(handle.conversationId, ref);
    this.dirtyRuntime.add(handle.conversationId);
    const finalWorkspace = await this.observeRuntimeState(handle.conversationId, active.cwd);
    const objective = active.objective && typeof active.objective === 'object' && !Array.isArray(active.objective)
      ? active.objective as Record<string, CanonicalJsonValue>
      : {};
    const traceRef = `journal://scope/${encodeURIComponent(active.scopeId)}/trace`;
    const resultValue = canonicalInput({
      version: 1,
      objective: objective.objective ?? active.objective,
      basis: {
        capsuleRef: objective.capsuleRef ?? null,
        scopeRef: `journal://scope/${encodeURIComponent(active.scopeId)}`,
      },
      baseWorkspace: objective.baseWorkspace ?? null,
      finalWorkspace,
      status: input.status,
      findings: input.findings,
      changeRefs: input.changeRefs ?? [],
      validationRefs: input.validationRefs ?? [],
      unresolved: input.unresolved ?? [],
      proposedPromotions: input.proposedPromotions ?? [],
      traceRef,
    }, 'work-unit result');
    const resultArtifact = await this.prepareJson(resultValue, true);
    if (!resultArtifact.artifact) throw new Error('Work-unit result must be stored as an artifact.');
    const resultRef = `journal://artifact/${resultArtifact.artifact.hash}`;
    const parentRow = this.storage.database.prepare(`
      SELECT e.epoch_id
      FROM execution_scopes s
      JOIN epochs e ON e.scope_id = s.scope_id AND e.state = 'open'
      WHERE s.scope_id = ? AND s.kind = 'turn' AND s.state = 'running'
      ORDER BY e.ordinal DESC LIMIT 1
    `).get(active.parentScopeId) as { epoch_id: string } | undefined;
    if (!parentRow) throw new Error('The parent turn scope is no longer available.');
    const parentHandle: DurableTurnHandle = {
      projectId: handle.projectId,
      conversationId: handle.conversationId,
      strandId: handle.strandId,
      turnId: handle.turnId,
      scopeId: active.parentScopeId,
      epochId: parentRow.epoch_id,
    };
    await this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const recordedAt = safeTimestamp(this.now());
      const terminalSequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'work_unit.returned',
        actor: 'model',
        visibility: 'internal',
        payload: { resultRef, returnMode, status: input.status, traceRef },
        artifactHash: resultArtifact.artifact!.hash,
        createdAt: recordedAt,
      });
      this.insertArtifact(resultArtifact.artifact!, terminalSequence);
      this.storage.database.prepare(`
        UPDATE epochs SET state = 'closed', closed_sequence = ?, close_reason = ?
        WHERE epoch_id = ? AND state = 'open'
      `).run(terminalSequence, `work_unit_${input.status}`, handle.epochId);
      this.storage.database.prepare(`
        UPDATE execution_scopes
        SET state = ?, terminal_sequence = ?, result_artifact_hash = ?, updated_at = ?
        WHERE scope_id = ? AND state = 'running'
      `).run(input.status, terminalSequence, resultArtifact.artifact!.hash, recordedAt, handle.scopeId);
      this.storage.database.prepare(`
        UPDATE execution_scopes
        SET objective_json = ?, updated_at = ?
        WHERE scope_id = ? AND kind = 'turn' AND state = 'running'
      `).run(canonicalJson({
        intent: 'Integrate the completed child result and answer the current user request. Do not repeat completed child work unless new evidence requires it.',
        completedChild: {
          resultRef,
          returnMode,
          scopeRef: `journal://scope/${encodeURIComponent(handle.scopeId)}`,
          status: input.status,
        },
      }), recordedAt, active.parentScopeId);
      this.insertEvent({
        ...parentHandle,
        eventId: this.nextId('event'),
        type: 'work_unit.result_available',
        actor: 'harness',
        visibility: 'internal',
        payload: {
          resultRef,
          returnMode,
          scopeId: handle.scopeId,
          status: input.status,
          traceRef,
        },
        artifactHash: resultArtifact.artifact!.hash,
        createdAt: recordedAt,
      });
    }));
    this.dirtyRuntime.add(handle.conversationId);
    return {
      handle: parentHandle,
      result: {
        action: 'returned',
        scopeId: handle.scopeId,
        parentScopeId: parentHandle.scopeId,
        resultRef,
        traceRef,
        status: input.status,
      },
    };
  }

  private contextIdentity(conversationId: string) {
    const row = this.storage.database.prepare(`
      SELECT c.project_id, p.root_space_id, c.head_strand_id,
             scs.space_id AS target_space_id, c.cwd
      FROM conversations c
      JOIN projects p ON p.project_id = c.project_id
      JOIN strand_context_spaces scs
        ON scs.conversation_id = c.conversation_id AND scs.strand_id = c.head_strand_id
      WHERE c.conversation_id = ?
    `).get(conversationId) as {
      project_id: string;
      root_space_id: string;
      head_strand_id: string;
      target_space_id: string;
      cwd: string;
    } | undefined;
    if (!row) throw new Error(`Conversation ${conversationId} has no context identity.`);
    return {
      projectId: row.project_id,
      rootSpaceId: row.root_space_id,
      strandId: row.head_strand_id,
      targetSpaceId: row.target_space_id,
      cwd: row.cwd,
    };
  }

  private activeScopeIdentity(conversationId: string) {
    const row = this.storage.database.prepare(`
      SELECT c.project_id, c.cwd, c.reasoning, t.turn_id, t.strand_id,
             t.root_scope_id, s.scope_id, s.parent_scope_id, s.kind,
             s.objective_json, e.epoch_id, p.revision, p.root_space_id,
             COALESCE(wcs.space_id, scs.space_id) AS target_space_id
      FROM conversations c
      JOIN projects p ON p.project_id = c.project_id
      JOIN turns t ON t.conversation_id = c.conversation_id
      JOIN execution_scopes s ON s.turn_id = t.turn_id
      JOIN epochs e ON e.scope_id = s.scope_id
      JOIN strand_context_spaces scs
        ON scs.conversation_id = c.conversation_id AND scs.strand_id = t.strand_id
      LEFT JOIN context_spaces wcs
        ON wcs.project_id = c.project_id AND wcs.key = ('work-unit:' || s.scope_id)
      WHERE c.conversation_id = ?
      ORDER BY (t.state = 'running') DESC, t.accepted_sequence DESC,
               (s.state = 'running') DESC,
               (s.kind = 'work_unit' AND s.state = 'running') DESC,
               (s.kind = 'turn') DESC, s.created_sequence DESC,
               (e.state = 'open') DESC, e.ordinal DESC
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
      epoch_id: string;
      revision: number;
      root_space_id: string;
      target_space_id: string;
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
      epochId: row.epoch_id,
      revision: safeNonnegativeInteger(row.revision, 'project revision'),
      rootSpaceId: row.root_space_id,
      targetSpaceId: row.target_space_id,
    };
  }

  private async observeRuntimeState(
    conversationId: string,
    cwd: string,
  ): Promise<ObservedRuntimeSnapshot> {
    const cached = this.observedRuntime.get(conversationId);
    if (cached && !this.dirtyRuntime.has(conversationId)) return cached;
    let gitRoot: string | null = null;
    let head: string | null = null;
    let status = '';
    try {
      const rootResult = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        timeout: 3_000,
        maxBuffer: 1024 * 1024,
      });
      gitRoot = rootResult.stdout.trim() || null;
      if (gitRoot) {
        const [headResult, statusResult] = await Promise.all([
          execFileAsync('git', ['-C', gitRoot, 'rev-parse', 'HEAD'], {
            encoding: 'utf8', timeout: 3_000, maxBuffer: 1024 * 1024,
          }),
          execFileAsync('git', ['-C', gitRoot, 'status', '--porcelain=v1', '-z'], {
            encoding: 'utf8', timeout: 3_000, maxBuffer: 1024 * 1024,
          }),
        ]);
        head = headResult.stdout.trim() || null;
        status = statusResult.stdout;
      }
    } catch {
      gitRoot = null;
      head = null;
      status = '';
    }
    const dirtyPaths = parsePorcelainPaths(status);
    const operationRows = this.storage.database.prepare(`
      SELECT operation_id, kind, state FROM operations
      WHERE conversation_id = ? AND state NOT IN ('succeeded', 'failed', 'canceled')
      ORDER BY accepted_sequence DESC, operation_id LIMIT 16
    `).all(conversationId) as Array<{ operation_id: string; kind: string; state: string }>;
    const commandRows = this.storage.database.prepare(`
      SELECT called.sequence AS called_sequence, called.payload_json AS called_payload,
             completed.payload_json AS completed_payload
      FROM events called
      LEFT JOIN events completed
        ON completed.conversation_id = called.conversation_id
       AND completed.type = 'tool.completed'
       AND json_extract(completed.payload_json, '$.callId') = json_extract(called.payload_json, '$.callId')
      WHERE called.conversation_id = ? AND called.type = 'tool.called'
        AND json_extract(called.payload_json, '$.name') = 'bash'
      ORDER BY called.sequence DESC LIMIT 6
    `).all(conversationId) as Array<{
      called_sequence: number;
      called_payload: string;
      completed_payload: string | null;
    }>;
    const recentCommands: ObservedRuntimeSnapshot['recentCommands'] = [];
    const recentFailures: ObservedRuntimeSnapshot['recentFailures'] = [];
    for (const row of commandRows) {
      const called = JSON.parse(row.called_payload) as Record<string, CanonicalJsonValue>;
      const args = await this.readJsonRef(called.args);
      const callId = requiredString(called.callId, 'runtime command callId');
      const completed = row.completed_payload
        ? JSON.parse(row.completed_payload) as Record<string, CanonicalJsonValue>
        : null;
      const result = completed ? await this.readJsonRef(completed.result) : null;
      const encodedResult = result === null ? '' : canonicalJson(normalizeJson(result));
      const command = commandText(args);
      const exitCode = resultExitCode(result);
      const isError = completed?.isError === true;
      const ref = `journal://tool/${encodeURIComponent(callId)}`;
      const excerpt = truncateUtf8Text(encodedResult, 640);
      recentCommands.push({ ref, command, excerpt, exitCode, isError });
      if (isError) recentFailures.push({ ref, excerpt });
    }
    const snapshot: ObservedRuntimeSnapshot = {
      cwd,
      gitRoot,
      head,
      dirtyPaths,
      statusHash: createHash('sha256').update(status).digest('hex'),
      observedAt: safeTimestamp(this.now()),
      activeOperations: operationRows.map((row) => ({
        operationId: row.operation_id,
        kind: row.kind,
        state: row.state,
      })),
      recentCommands,
      recentFailures,
      recentWorkUnits: (this.storage.database.prepare(`
        SELECT scope_id, objective_json, state, result_artifact_hash
        FROM execution_scopes
        WHERE conversation_id = ? AND kind = 'work_unit' AND result_artifact_hash IS NOT NULL
        ORDER BY terminal_sequence DESC LIMIT 4
      `).all(conversationId) as Array<{
        scope_id: string; objective_json: string; state: string; result_artifact_hash: string;
      }>).map((row) => {
        const value = JSON.parse(row.objective_json) as CanonicalJsonValue;
        const objective = value && typeof value === 'object' && !Array.isArray(value) &&
          typeof value.objective === 'string'
          ? value.objective
          : canonicalJson(value);
        return {
          scopeRef: `journal://scope/${encodeURIComponent(row.scope_id)}`,
          resultRef: `journal://artifact/${row.result_artifact_hash}`,
          traceRef: `journal://scope/${encodeURIComponent(row.scope_id)}/trace`,
          status: row.state,
          objective: truncateUtf8Text(objective, 512),
        };
      }),
      changedPaths: dirtyPaths,
    };
    this.observedRuntime.set(conversationId, snapshot);
    this.dirtyRuntime.delete(conversationId);
    return snapshot;
  }

  private async searchableEventText(event: AgentJournalEvent) {
    const expanded = await this.expandEventPayload(event);
    return `${event.type}\n${canonicalJson(expanded)}`;
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

  private readProjectState(projectId: string, rootSpaceId: string): ProjectState {
    const revisionRow = this.storage.database.prepare(`
      SELECT revision FROM projects WHERE project_id = ? AND root_space_id = ?
    `).get(projectId, rootSpaceId) as { revision: number } | undefined;
    if (!revisionRow) throw new Error(`Project ${projectId} does not exist.`);
    const spaces = new Map<string, ContextSpace>();
    for (const row of this.storage.database.prepare(`
      SELECT space_id, project_id, parent_space_id, key, descriptor_json,
             created_revision
      FROM context_spaces WHERE project_id = ? ORDER BY space_id
    `).all(projectId) as Array<{
      space_id: string;
      project_id: string;
      parent_space_id: string | null;
      key: string;
      descriptor_json: string;
      created_revision: number;
    }>) {
      spaces.set(row.space_id, {
        id: row.space_id,
        projectId: row.project_id,
        parentSpaceId: row.parent_space_id,
        key: row.key,
        descriptor: JSON.parse(row.descriptor_json) as CanonicalJsonValue,
        createdRevision: safeNonnegativeInteger(row.created_revision, 'context space revision'),
      });
    }
    const primaries = new Map<string, ProjectPrimary>();
    for (const row of this.storage.database.prepare(`
      SELECT primary_id, project_id, home_space_id, key, kind,
             descriptor_json, body_json, authority, provenance_json, lifecycle,
             superseded_by, version, created_revision, updated_revision
      FROM project_primaries WHERE project_id = ? ORDER BY primary_id
    `).all(projectId) as Array<Record<string, unknown>>) {
      const primaryId = requiredString(row.primary_id as CanonicalJsonValue, 'primary_id');
      primaries.set(primaryId, {
        id: primaryId,
        projectId: requiredString(row.project_id as CanonicalJsonValue, 'project_id'),
        homeSpaceId: requiredString(row.home_space_id as CanonicalJsonValue, 'home_space_id'),
        key: requiredString(row.key as CanonicalJsonValue, 'primary key'),
        kind: requiredString(row.kind as CanonicalJsonValue, 'primary kind'),
        descriptor: JSON.parse(requiredString(row.descriptor_json as CanonicalJsonValue, 'descriptor_json')) as CanonicalJsonValue,
        body: JSON.parse(requiredString(row.body_json as CanonicalJsonValue, 'body_json')) as CanonicalJsonValue,
        authority: requiredPrimaryAuthority(row.authority),
        provenance: requiredStringArray(row.provenance_json, 'primary provenance'),
        lifecycle: requiredPrimaryLifecycle(row.lifecycle),
        supersededBy: row.superseded_by === null
          ? null
          : requiredString(row.superseded_by as CanonicalJsonValue, 'superseded_by'),
        version: safePositiveInteger(row.version, 'primary version'),
        createdRevision: safeNonnegativeInteger(row.created_revision, 'primary created revision'),
        updatedRevision: safeNonnegativeInteger(row.updated_revision, 'primary updated revision'),
      });
    }
    const bindings = new Map<string, ContextBinding>();
    for (const row of this.storage.database.prepare(`
      SELECT space_id, primary_id, mode, provenance_json, version,
             created_revision, updated_revision
      FROM context_bindings WHERE project_id = ? ORDER BY space_id, primary_id
    `).all(projectId) as Array<Record<string, unknown>>) {
      const spaceId = requiredString(row.space_id as CanonicalJsonValue, 'binding space_id');
      const primaryId = requiredString(row.primary_id as CanonicalJsonValue, 'binding primary_id');
      bindings.set(contextBindingKey(spaceId, primaryId), {
        spaceId,
        primaryId,
        mode: requiredBindingMode(row.mode),
        provenance: requiredStringArray(row.provenance_json, 'binding provenance'),
        version: safePositiveInteger(row.version, 'binding version'),
        createdRevision: safeNonnegativeInteger(row.created_revision, 'binding created revision'),
        updatedRevision: safeNonnegativeInteger(row.updated_revision, 'binding updated revision'),
      });
    }
    const relations = new Map<string, ProjectRelation>();
    for (const row of this.storage.database.prepare(`
      SELECT relation_id, project_id, from_type, from_id, predicate, to_type,
             to_id, attributes_json, provenance_json, version, created_revision
      FROM project_relations WHERE project_id = ? ORDER BY relation_id
    `).all(projectId) as Array<Record<string, unknown>>) {
      const relationId = requiredString(row.relation_id as CanonicalJsonValue, 'relation_id');
      relations.set(relationId, {
        id: relationId,
        projectId: requiredString(row.project_id as CanonicalJsonValue, 'relation project_id'),
        from: {
          type: requiredEntityType(row.from_type),
          id: requiredString(row.from_id as CanonicalJsonValue, 'relation from_id'),
        },
        predicate: requiredString(row.predicate as CanonicalJsonValue, 'relation predicate'),
        to: {
          type: requiredEntityType(row.to_type),
          id: requiredString(row.to_id as CanonicalJsonValue, 'relation to_id'),
        },
        attributes: JSON.parse(requiredString(row.attributes_json as CanonicalJsonValue, 'relation attributes')) as CanonicalJsonValue,
        provenance: requiredStringArray(row.provenance_json, 'relation provenance'),
        version: safePositiveInteger(row.version, 'relation version'),
        createdRevision: safeNonnegativeInteger(row.created_revision, 'relation created revision'),
      });
    }
    return {
      projectId,
      revision: safeNonnegativeInteger(revisionRow.revision, 'project revision'),
      rootSpaceId,
      spaces,
      primaries,
      bindings,
      relations,
    };
  }

  private contextOperations(
    state: ProjectState,
    targetSpaceId: string,
    actions: readonly ContextStorageAction[],
    provenance: string,
    workingResources: ReadonlyMap<string, PreparedWorkingResource> = new Map(),
    scopeKind: 'turn' | 'work_unit' = 'turn',
  ): ProjectOperation[] {
    const operations: ProjectOperation[] = [];
    const touched = new Set<string>();
    const homeSpace = (scope: ContextScope) => scope === 'project' ? state.rootSpaceId : targetSpaceId;
    const localBinding = (spaceId: string, primaryId: string) =>
      state.bindings.get(contextBindingKey(spaceId, primaryId));
    const primaryAt = (spaceId: string, key: string) => [...state.primaries.values()].find(
      (primary) => primary.homeSpaceId === spaceId && primary.key === key && primary.lifecycle === 'active',
    );
    const bind = (
      spaceId: string,
      primary: ProjectPrimary | { id: string },
      mode: 'inline' | 'index' | 'available',
      provenanceRefs: readonly string[] = [provenance],
    ) => {
      const current = localBinding(spaceId, primary.id);
      const mergedProvenance = [...new Set([...(current?.provenance ?? []), ...provenanceRefs])];
      if (
        current?.mode === mode &&
        canonicalJson(current.provenance as unknown as CanonicalJsonValue) ===
          canonicalJson(mergedProvenance as unknown as CanonicalJsonValue)
      ) return;
      operations.push({
        type: 'bind',
        spaceId,
        primaryId: primary.id,
        mode,
        provenance: mergedProvenance,
        ...(current ? { ifVersion: current.version } : {}),
      });
    };

    for (const action of actions) {
      if (action.op === 'set') {
        if (scopeKind === 'work_unit' && action.scope === 'project') {
          throw new Error('A work unit cannot write project-scoped context directly.');
        }
        const key = contextKey(action.key);
        const home = homeSpace(action.scope);
        const touch = `semantic:${home}:${key}`;
        if (touched.has(touch)) throw new Error(`context_update touches ${action.scope}:${key} more than once.`);
        touched.add(touch);
        const current = primaryAt(home, key);
        const descriptor = canonicalInput({ title: key }, `context state descriptor ${key}`);
        const body = canonicalInput(action.value, `context state ${key}`);
        const kind = current?.kind ?? 'state';
        const hasNewEvidence = action.evidence.some((ref) => !current?.provenance.includes(ref));
        if (
          current && !hasNewEvidence &&
          canonicalJson(current.body) === canonicalJson(body) &&
          canonicalJson(current.descriptor) === canonicalJson(descriptor) &&
          localBinding(home, current.id)?.mode === 'inline'
        ) continue;
        const provenanceRefs = [...new Set([
          ...(current?.provenance ?? []),
          provenance,
          ...action.evidence,
        ])];
        if (current) {
          if (current.authority !== 'model') {
            throw new Error(`Model context cannot replace ${current.authority}-authority key ${key}.`);
          }
          operations.push({
            type: 'update_primary',
            primaryId: current.id,
            ifVersion: current.version,
            changes: { body, descriptor, kind, provenance: provenanceRefs },
          });
          bind(home, current, 'inline', provenanceRefs);
        } else {
          const primaryId = this.nextId('primary');
          operations.push({
            type: 'create_primary',
            primary: {
              id: primaryId,
              homeSpaceId: home,
              key,
              kind,
              descriptor,
              body,
              authority: 'model',
              provenance: provenanceRefs,
            },
          });
          bind(home, { id: primaryId }, 'inline', provenanceRefs);
        }
        continue;
      }
      if (action.op === 'pin') {
        if (scopeKind === 'work_unit' && action.scope === 'project') {
          throw new Error('A work unit cannot pin project-scoped context directly.');
        }
        const ref = requiredContextResource(action.ref);
        const home = homeSpace(action.scope);
        const key = `working:${createHash('sha256').update(ref).digest('hex').slice(0, 24)}`;
        const touch = `working:${home}:${ref}`;
        if (touched.has(touch)) throw new Error(`context_update touches ${action.scope} pin ${ref} more than once.`);
        touched.add(touch);
        const prepared = workingResources.get(ref);
        const descriptor = prepared?.descriptor ?? canonicalInput({
          label: action.label ?? ref,
          resource: ref,
          retention: 'sticky',
          view: 'exact',
        }, 'working resource descriptor');
        const body = prepared?.body ?? canonicalInput(
          { label: action.label ?? ref, resource: ref, retention: 'sticky', view: 'exact' },
          'working resource',
        );
        const current = primaryAt(home, key);
        if (
          current &&
          canonicalJson(current.body) === canonicalJson(body) &&
          canonicalJson(current.descriptor) === canonicalJson(descriptor) &&
          localBinding(home, current.id)?.mode === 'inline'
        ) continue;
        if (current) {
          operations.push({
            type: 'update_primary',
            primaryId: current.id,
            ifVersion: current.version,
            changes: { descriptor, body, provenance: [provenance] },
          });
          bind(home, current, 'inline');
        } else {
          const primaryId = this.nextId('primary');
          operations.push({
            type: 'create_primary',
            primary: {
              id: primaryId,
              homeSpaceId: home,
              key,
              kind: 'working-resource',
              descriptor,
              body,
              authority: 'model',
              provenance: [provenance],
            },
          });
          bind(home, { id: primaryId }, 'inline');
        }
        continue;
      }
      if (action.op === 'unpin') {
        if (scopeKind === 'work_unit' && action.scope === 'project') {
          throw new Error('A work unit cannot unpin project-scoped context directly.');
        }
        const ref = requiredContextResource(action.ref);
        const home = homeSpace(action.scope);
        const current = findWorkingPrimary(state, home, ref);
        const touch = `working:${home}:${ref}`;
        if (touched.has(touch)) throw new Error(`context_update touches ${action.scope} pin ${ref} more than once.`);
        touched.add(touch);
        if (!current || localBinding(home, current.id)?.mode === 'available') continue;
        bind(home, current, 'available');
        continue;
      }
      if (action.op === 'remove') {
        if (scopeKind === 'work_unit' && action.scope === 'project') {
          throw new Error('A work unit cannot remove project-scoped context directly.');
        }
        const key = contextKey(action.key);
        const space = homeSpace(action.scope);
        const touch = `semantic:${space}:${key}`;
        if (touched.has(touch)) throw new Error(`context_update touches ${action.scope}:${key} more than once.`);
        touched.add(touch);
        const current = primaryAt(space, key);
        if (!current) continue;
        const binding = localBinding(space, current.id);
        if (binding && binding.mode !== 'masked') {
          operations.push({ type: 'unbind', spaceId: space, primaryId: current.id, ifVersion: binding.version });
        }
        continue;
      }
    }
    return operations;
  }

  private async prepareWorkingResources(
    conversationId: string,
    cwd: string,
    actions: readonly ContextStorageAction[],
  ): Promise<Map<string, PreparedWorkingResource>> {
    const prepared = new Map<string, PreparedWorkingResource>();
    for (const action of actions) {
      if (action.op !== 'pin') continue;
      const resource = requiredContextResource(action.ref);
      const retention = 'sticky' as const;
      const view = 'exact' as const;
      const immutableRef = resource.includes('://');
      const resolvedPath = immutableRef
        ? null
        : isAbsolute(resource) ? resource : resolve(cwd, resource);
      const common = {
        label: action.label ?? resource,
        resource,
        retention,
        view,
        ...(resolvedPath ? { resolvedPath } : {}),
      };
      const bytes = resolvedPath
        ? await readFile(resolvedPath)
        : Buffer.from(await this.resolveOpenableContent(conversationId, resource), 'utf8');
      if (bytes.byteLength > MAX_EXACT_WORKING_RESOURCE_BYTES) {
        throw new Error(
          `Pinned resource ${resource} is ${bytes.byteLength} bytes; ` +
          `the exact-content limit is ${MAX_EXACT_WORKING_RESOURCE_BYTES}. ` +
          'Pin a smaller governing resource or store a bounded state value with an evidence reference.',
        );
      }
      if (bytes.includes(0)) {
        throw new Error(`Exact working resource ${resource} is not UTF-8 text.`);
      }
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) {
        throw new Error(`Exact working resource ${resource} is not valid UTF-8 text.`);
      }
      const byteLength = bytes.byteLength;
      const contentHash = createHash('sha256').update(bytes).digest('hex');
      const artifact = resolvedPath
        ? await this.artifacts.put(bytes, 'text/plain; charset=utf-8')
        : undefined;
      const snapshotRef = artifact ? `journal://artifact/${artifact.hash}` : resource;
      const descriptor = { ...common, byteLength, contentHash, snapshotRef };
      prepared.set(resource, {
        descriptor: canonicalInput(descriptor, 'working resource descriptor'),
        body: canonicalInput({ ...descriptor, text }, 'working resource'),
        ...(artifact ? { artifact } : {}),
      });
    }
    return prepared;
  }

  private persistProjectStateDelta(
    before: ProjectState,
    after: ProjectState,
    sequence: number,
    recordedAt: number,
  ) {
    for (const primary of after.primaries.values()) {
      const prior = before.primaries.get(primary.id);
      if (prior && canonicalJson(primary as unknown as CanonicalJsonValue) === canonicalJson(prior as unknown as CanonicalJsonValue)) continue;
      if (!prior) {
        this.storage.database.prepare(`
          INSERT INTO project_primaries (
            primary_id, project_id, home_space_id, key, kind, descriptor_json,
            body_json, authority, provenance_json, lifecycle, superseded_by,
            version, created_revision, updated_revision, created_sequence,
            updated_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          primary.id, primary.projectId, primary.homeSpaceId, primary.key, primary.kind,
          canonicalJson(primary.descriptor), canonicalJson(primary.body), primary.authority,
          canonicalJson(primary.provenance as unknown as CanonicalJsonValue), primary.lifecycle,
          primary.supersededBy, primary.version, primary.createdRevision, primary.updatedRevision,
          sequence, sequence,
        );
      } else {
        this.storage.database.prepare(`
          UPDATE project_primaries
          SET kind = ?, descriptor_json = ?, body_json = ?, provenance_json = ?,
              lifecycle = ?, superseded_by = ?, version = ?, updated_revision = ?,
              updated_sequence = ?
          WHERE project_id = ? AND primary_id = ?
        `).run(
          primary.kind, canonicalJson(primary.descriptor), canonicalJson(primary.body),
          canonicalJson(primary.provenance as unknown as CanonicalJsonValue), primary.lifecycle,
          primary.supersededBy, primary.version, primary.updatedRevision, sequence,
          primary.projectId, primary.id,
        );
      }
    }
    for (const [key, prior] of before.bindings) {
      if (after.bindings.has(key)) continue;
      this.storage.database.prepare(`
        DELETE FROM context_bindings WHERE project_id = ? AND space_id = ? AND primary_id = ?
      `).run(before.projectId, prior.spaceId, prior.primaryId);
    }
    for (const [key, binding] of after.bindings) {
      const prior = before.bindings.get(key);
      if (prior && canonicalJson(binding as unknown as CanonicalJsonValue) === canonicalJson(prior as unknown as CanonicalJsonValue)) continue;
      this.storage.database.prepare(`
        INSERT INTO context_bindings (
          space_id, primary_id, project_id, mode, provenance_json, version,
          created_revision, updated_revision, created_sequence, updated_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(space_id, primary_id) DO UPDATE SET
          mode = excluded.mode,
          provenance_json = excluded.provenance_json,
          version = excluded.version,
          updated_revision = excluded.updated_revision,
          updated_sequence = excluded.updated_sequence
      `).run(
        binding.spaceId, binding.primaryId, after.projectId, binding.mode,
        canonicalJson(binding.provenance as unknown as CanonicalJsonValue), binding.version,
        binding.createdRevision, binding.updatedRevision,
        prior ? this.bindingCreatedSequence(binding.spaceId, binding.primaryId) : sequence,
        sequence,
      );
    }
    this.storage.database.prepare(`
      UPDATE projects SET revision = ?, updated_sequence = ?, updated_at = ?
      WHERE project_id = ? AND revision = ?
    `).run(after.revision, sequence, recordedAt, after.projectId, before.revision);
  }

  private bindingCreatedSequence(spaceId: string, primaryId: string) {
    const row = this.storage.database.prepare(`
      SELECT created_sequence FROM context_bindings WHERE space_id = ? AND primary_id = ?
    `).get(spaceId, primaryId) as { created_sequence: number } | undefined;
    return row?.created_sequence ?? 0;
  }

  private contextWorkspaceView(
    state: ProjectState,
    targetSpaceId: string,
    additionalWarnings: readonly string[] = [],
  ): ContextWorkspaceView {
    const compiled = compileProjectContext(state, targetSpaceId);
    const contextState: ContextWorkspaceView['state'] = [];
    const pinned: ContextWorkspaceView['pinned'] = [];
    for (const entry of compiled.effective) {
      const primary = state.primaries.get(entry.primaryId);
      if (!primary) continue;
      if (primary.kind === 'working-resource') {
        const descriptor = canonicalObject(primary.descriptor);
        const ref = typeof descriptor.resource === 'string' ? descriptor.resource : primary.key;
        const label = typeof descriptor.label === 'string' ? descriptor.label : ref;
        pinned.push({
          ref,
          label,
          scope: primary.homeSpaceId === state.rootSpaceId ? 'project' : 'thread',
          state: entry.mode === 'available' ? 'unpinned' : 'pinned',
          version: primary.version,
        });
      } else {
        contextState.push({
          key: primary.key,
          scope: primary.homeSpaceId === state.rootSpaceId ? 'project' : 'thread',
          version: primary.version,
        });
      }
    }
    contextState.sort((left, right) => left.key.localeCompare(right.key));
    pinned.sort((left, right) => left.ref.localeCompare(right.ref));
    const warnings = [...additionalWarnings];
    if (pinned.some(({ state }) => state === 'pinned')) {
      warnings.push('Pinned contents remain authoritative snapshots; re-read live files before final validation.');
    }
    return {
      revision: state.revision,
      state: contextState,
      pinned,
      estimatedBytes: Buffer.byteLength(canonicalJson({ state: contextState, pinned }), 'utf8'),
      warnings,
    };
  }

  private readShadowContextSource(
    conversationId: string,
    snapshot: DurableContextSnapshot,
    observedRuntime: ObservedRuntimeSnapshot,
  ): ShadowContextSource {
    const active = this.activeScopeIdentity(conversationId);
    const identity = {
      project_id: active.projectId,
      cwd: active.cwd,
      reasoning: active.reasoning,
      turn_id: active.turnId,
      strand_id: active.strandId,
      root_scope_id: active.scopeId,
      epoch_id: active.epochId,
      revision: active.revision,
      root_space_id: active.rootSpaceId,
      target_space_id: active.targetSpaceId,
    };

    const spaces = new Map<string, ContextSpace>();
    for (const row of this.storage.database.prepare(`
      SELECT space_id, project_id, parent_space_id, key, descriptor_json,
             created_revision
      FROM context_spaces WHERE project_id = ? ORDER BY space_id
    `).all(identity.project_id) as Array<{
      space_id: string;
      project_id: string;
      parent_space_id: string | null;
      key: string;
      descriptor_json: string;
      created_revision: number;
    }>) {
      spaces.set(row.space_id, {
        id: row.space_id,
        projectId: row.project_id,
        parentSpaceId: row.parent_space_id,
        key: row.key,
        descriptor: JSON.parse(row.descriptor_json) as CanonicalJsonValue,
        createdRevision: safeNonnegativeInteger(row.created_revision, 'context space revision'),
      });
    }
    const primaries = new Map<string, ProjectPrimary>();
    for (const row of this.storage.database.prepare(`
      SELECT primary_id, project_id, home_space_id, key, kind,
             descriptor_json, body_json, authority, provenance_json, lifecycle,
             superseded_by, version, created_revision, updated_revision
      FROM project_primaries WHERE project_id = ? ORDER BY primary_id
    `).all(identity.project_id) as Array<Record<string, unknown>>) {
      const primaryId = requiredString(row.primary_id as CanonicalJsonValue, 'primary_id');
      primaries.set(primaryId, {
        id: primaryId,
        projectId: requiredString(row.project_id as CanonicalJsonValue, 'project_id'),
        homeSpaceId: requiredString(row.home_space_id as CanonicalJsonValue, 'home_space_id'),
        key: requiredString(row.key as CanonicalJsonValue, 'primary key'),
        kind: requiredString(row.kind as CanonicalJsonValue, 'primary kind'),
        descriptor: JSON.parse(requiredString(row.descriptor_json as CanonicalJsonValue, 'descriptor_json')) as CanonicalJsonValue,
        body: JSON.parse(requiredString(row.body_json as CanonicalJsonValue, 'body_json')) as CanonicalJsonValue,
        authority: requiredPrimaryAuthority(row.authority),
        provenance: requiredStringArray(row.provenance_json, 'primary provenance'),
        lifecycle: requiredPrimaryLifecycle(row.lifecycle),
        supersededBy: row.superseded_by === null
          ? null
          : requiredString(row.superseded_by as CanonicalJsonValue, 'superseded_by'),
        version: safePositiveInteger(row.version, 'primary version'),
        createdRevision: safeNonnegativeInteger(row.created_revision, 'primary created revision'),
        updatedRevision: safeNonnegativeInteger(row.updated_revision, 'primary updated revision'),
      });
    }
    const bindings = new Map<string, ContextBinding>();
    for (const row of this.storage.database.prepare(`
      SELECT space_id, primary_id, mode, provenance_json, version,
             created_revision, updated_revision
      FROM context_bindings WHERE project_id = ? ORDER BY space_id, primary_id
    `).all(identity.project_id) as Array<Record<string, unknown>>) {
      const spaceId = requiredString(row.space_id as CanonicalJsonValue, 'binding space_id');
      const primaryId = requiredString(row.primary_id as CanonicalJsonValue, 'binding primary_id');
      bindings.set(canonicalJson([spaceId, primaryId]), {
        spaceId,
        primaryId,
        mode: requiredBindingMode(row.mode),
        provenance: requiredStringArray(row.provenance_json, 'binding provenance'),
        version: safePositiveInteger(row.version, 'binding version'),
        createdRevision: safeNonnegativeInteger(row.created_revision, 'binding created revision'),
        updatedRevision: safeNonnegativeInteger(row.updated_revision, 'binding updated revision'),
      });
    }
    const relations = new Map<string, ProjectRelation>();
    for (const row of this.storage.database.prepare(`
      SELECT relation_id, project_id, from_type, from_id, predicate, to_type,
             to_id, attributes_json, provenance_json, version, created_revision
      FROM project_relations WHERE project_id = ? ORDER BY relation_id
    `).all(identity.project_id) as Array<Record<string, unknown>>) {
      const relationId = requiredString(row.relation_id as CanonicalJsonValue, 'relation_id');
      relations.set(relationId, {
        id: relationId,
        projectId: requiredString(row.project_id as CanonicalJsonValue, 'relation project_id'),
        from: {
          type: requiredEntityType(row.from_type),
          id: requiredString(row.from_id as CanonicalJsonValue, 'relation from_id'),
        },
        predicate: requiredString(row.predicate as CanonicalJsonValue, 'relation predicate'),
        to: {
          type: requiredEntityType(row.to_type),
          id: requiredString(row.to_id as CanonicalJsonValue, 'relation to_id'),
        },
        attributes: JSON.parse(requiredString(row.attributes_json as CanonicalJsonValue, 'attributes_json')) as CanonicalJsonValue,
        provenance: requiredStringArray(row.provenance_json, 'relation provenance'),
        version: safePositiveInteger(row.version, 'relation version'),
        createdRevision: safeNonnegativeInteger(row.created_revision, 'relation created revision'),
      });
    }
    const state: ProjectState = {
      projectId: identity.project_id,
      revision: safeNonnegativeInteger(identity.revision, 'project revision'),
      rootSpaceId: identity.root_space_id,
      spaces,
      primaries,
      bindings,
      relations,
    };
    const compiled = compileProjectContext(state, identity.target_space_id);
    const currentUserRow = this.storage.database.prepare(`
      SELECT sequence FROM events
      WHERE conversation_id = ? AND turn_id = ? AND type = 'message.user'
      ORDER BY sequence DESC LIMIT 1
    `).get(conversationId, identity.turn_id) as { sequence: number } | undefined;
    const currentUser = snapshot.messages.find(
      (message): message is Extract<LogicalContextMessage, { role: 'user' }> =>
        message.role === 'user' && message.turnId === identity.turn_id,
    );
    if (!currentUser || !currentUserRow) {
      throw new Error(`Active turn ${identity.turn_id} has no deterministic user anchor.`);
    }
    const preceding = this.storage.database.prepare(`
      SELECT previous.turn_id
      FROM turns current
      JOIN turns previous
        ON previous.conversation_id = current.conversation_id
       AND previous.accepted_sequence < current.accepted_sequence
      WHERE current.turn_id = ?
      ORDER BY previous.accepted_sequence DESC LIMIT 1
    `).get(identity.turn_id) as { turn_id: string } | undefined;
    const precedingAssistantRefs = new Set<string>();
    if (preceding) {
      precedingAssistantRefs.add(`journal://turn/${encodeURIComponent(preceding.turn_id)}#assistant`);
      const precedingAssistantItems = this.storage.database.prepare(`
        SELECT item_id FROM transcript_items
        WHERE turn_id = ? AND kind = 'assistant'
        ORDER BY last_sequence DESC, item_id
      `).all(preceding.turn_id) as Array<{ item_id: string }>;
      for (const item of precedingAssistantItems) {
        precedingAssistantRefs.add(`journal://message/${encodeURIComponent(item.item_id)}`);
      }
    }
    const acceptedPrimary = compiled.effective
      .map((entry) => primaries.get(entry.primaryId))
      .filter((primary): primary is ProjectPrimary => Boolean(primary))
      .filter((primary) => primary.provenance.some((ref) => precedingAssistantRefs.has(ref)))
      .sort((left, right) => right.updatedRevision - left.updatedRevision || left.id.localeCompare(right.id))[0];
    const acceptedProposalRef = acceptedPrimary?.provenance.find((ref) =>
      precedingAssistantRefs.has(ref)) ?? null;
    const objective = active.objective && typeof active.objective === 'object' && !Array.isArray(active.objective)
      ? active.objective as Record<string, CanonicalJsonValue>
      : {};
    return {
      basisSequence: snapshot.basisSequence,
      projectId: identity.project_id,
      projectRevision: state.revision,
      conversationId,
      strandId: identity.strand_id,
      turnId: identity.turn_id,
      scopeId: identity.root_scope_id,
      epochId: identity.epoch_id,
      targetContextSpaceId: identity.target_space_id,
      workspaceRoot: identity.cwd,
      reasoning: identity.reasoning,
      messages: snapshot.messages,
      turnAnchor: {
        currentUser: {
          ref: `journal://event/${safeInteger(currentUserRow.sequence, 'current user sequence')}`,
          body: currentUser.text,
        },
        precedingAssistantRef: preceding
          ? `journal://turn/${encodeURIComponent(preceding.turn_id)}#assistant`
          : null,
        acceptedProposalRef,
        steeringRefs: [],
      },
      observedRuntime: observedRuntime as unknown as CanonicalJsonValue,
      executionScope: {
        kind: active.kind,
        parentScopeId: active.parentScopeId,
        objective: active.objective,
        capsuleRef: typeof objective.capsuleRef === 'string' ? objective.capsuleRef : null,
      },
      authority: compiled.effective.map((entry) => {
        const primary = primaries.get(entry.primaryId);
        if (!primary) throw new Error(`Compiled primary ${entry.primaryId} is missing.`);
        return {
          primaryId: primary.id,
          key: primary.key,
          kind: primary.kind,
          authority: primary.authority,
          mode: entry.mode,
          descriptor: primary.descriptor,
          body: primary.body,
          sourceSpaceIds: entry.sourceSpaceIds,
          version: primary.version,
        };
      }),
    };
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

  async readContextMode(conversationId: string): Promise<'full-history' | 'stateful'> {
    this.assertOpen();
    await this.writerTail;
    const row = this.storage.database.prepare(`
      SELECT json_extract(payload_json, '$.contextMode') AS context_mode
      FROM events
      WHERE conversation_id = ? AND type = 'conversation.created'
      ORDER BY sequence LIMIT 1
    `).get(conversationId) as { context_mode: unknown } | undefined;
    if (!row) throw new Error(`Conversation ${conversationId} does not exist.`);
    return row.context_mode === 'full-history' ? 'full-history' : 'stateful';
  }

  async readWorkUnitMode(conversationId: string): Promise<boolean> {
    this.assertOpen();
    await this.writerTail;
    const row = this.storage.database.prepare(`
      SELECT json_extract(payload_json, '$.workUnits') AS work_units
      FROM events
      WHERE conversation_id = ? AND type = 'conversation.created'
      ORDER BY sequence LIMIT 1
    `).get(conversationId) as { work_units: unknown } | undefined;
    if (!row) throw new Error(`Conversation ${conversationId} does not exist.`);
    return row.work_units === 1 || row.work_units === true;
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
        SELECT project_id, head_strand_id, state
        FROM conversations WHERE conversation_id = ?
      `).get(params.conversationId) as {
        project_id: string;
        head_strand_id: string;
        state: string;
      } | undefined;
      if (!conversation) throw new Error(`Conversation ${params.conversationId} does not exist.`);
      if (conversation.state === 'running') throw new Error('A durable turn is already running.');

      const handle: DurableTurnHandle = {
        projectId: conversation.project_id,
        conversationId: params.conversationId,
        strandId: conversation.head_strand_id,
        turnId: this.nextId('turn'),
        scopeId: this.nextId('scope'),
        epochId: this.nextId('epoch'),
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
      const epochSequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        operationId,
        type: 'epoch.opened',
        actor: 'harness',
        visibility: 'internal',
        payload: {
          epochId: handle.epochId,
          mode: 'full_replay',
          ordinal: 0,
          scopeId: handle.scopeId,
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
        payload: { epochId: handle.epochId, scopeId: handle.scopeId, turnId: handle.turnId },
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
          root_scope_id, mode, state, accepted_sequence, terminal_sequence,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'running', ?, NULL, ?, ?)
      `).run(
        handle.turnId,
        handle.projectId,
        handle.conversationId,
        handle.strandId,
        params.clientMessageId,
        handle.scopeId,
        acceptedTurnSequence,
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
      this.storage.database.prepare(`
        INSERT INTO epochs (
          epoch_id, project_id, conversation_id, strand_id, turn_id, scope_id,
          ordinal, state, policy_version, opened_sequence, closed_sequence,
          close_reason, bootstrap_artifact_hash, basis_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 'open', 'agent-full-replay-v1', ?, NULL, NULL, NULL, ?)
      `).run(
        handle.epochId,
        handle.projectId,
        handle.conversationId,
        handle.strandId,
        handle.turnId,
        handle.scopeId,
        epochSequence,
        scopeSequence,
      );
      const userItemId = this.nextId('item');
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
             t.root_scope_id, t.client_message_id, e.epoch_id, o.kind,
             o.arguments_hash, o.terminal_sequence, ti.first_sequence,
             ti.item_id, message.created_at AS transcript_created_at
      FROM operations o
      JOIN turns t ON t.turn_id = o.turn_id
      JOIN epochs e ON e.scope_id = t.root_scope_id AND e.ordinal = 0
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
      epoch_id: string;
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
      epoch_id: string;
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
      epochId: row.epoch_id,
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
  ): CreateConversationResult {
    const replay = this.readCreateReplay(params.operationId, argumentsHash);
    if (replay) return replay;

    return this.storage.transaction(() => {
      const insideReplay = this.readCreateReplay(params.operationId, argumentsHash);
      if (insideReplay) return insideReplay;

      const existingProject = this.storage.database.prepare(`
        SELECT project_id, root_space_id, revision
        FROM projects
        WHERE root_path = ?
      `).get(params.cwd) as ProjectRow | undefined;
      const projectId = existingProject?.project_id ?? this.nextId('project');
      const rootSpaceId = existingProject?.root_space_id ?? this.nextId('space');
      const conversationId = this.nextId('conversation');
      const rootStrandId = this.nextId('strand');
      const contextSpaceId = this.nextId('space');
      const recordedAt = safeTimestamp(this.now());
      const outcome: StoredCreateOutcome = {
        accepted: true,
        operationId: params.operationId,
        projectId,
        rootSpaceId,
        conversationId,
        contextSpaceId,
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
            revision: 0,
            rootPath: params.cwd,
            rootSpaceId,
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
          contextSpaceId,
          contextMode: params.contextMode ?? 'stateful',
          workUnits: params.workUnits ?? false,
          cwd: params.cwd,
          forkedFromSequence: null,
          headStrandId: rootStrandId,
          modelId: params.modelId,
          parentStrandId: null,
          projectId,
          reasoning: params.reasoning,
          rootSpaceId,
          state: 'idle',
          strandState: 'active',
          title: INITIAL_TITLE,
        },
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
            project_id, root_path, title, root_space_id, revision, state,
            created_sequence, updated_sequence, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 0, 'active', ?, ?, ?, ?)
        `).run(
          projectId,
          params.cwd,
          title,
          rootSpaceId,
          projectSequence,
          projectSequence,
          recordedAt,
          recordedAt,
        );
        this.storage.database.prepare(`
          INSERT INTO context_spaces (
            space_id, project_id, parent_space_id, key, descriptor_json,
            created_revision, created_sequence
          ) VALUES (?, ?, NULL, 'root', ?, 0, ?)
        `).run(
          rootSpaceId,
          projectId,
          canonicalJson({ rootPath: params.cwd, title }),
          projectSequence,
        );
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
        INSERT INTO context_spaces (
          space_id, project_id, parent_space_id, key, descriptor_json,
          created_revision, created_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        contextSpaceId,
        projectId,
        rootSpaceId,
        `strand:${rootStrandId}`,
        canonicalJson({ conversationId, kind: 'strand', strandId: rootStrandId }),
        existingProject?.revision ?? 0,
        conversationSequence,
      );
      this.storage.database.prepare(`
        INSERT INTO strand_context_spaces (
          strand_id, conversation_id, project_id, space_id, created_sequence
        ) VALUES (?, ?, ?, ?, ?)
      `).run(rootStrandId, conversationId, projectId, contextSpaceId, conversationSequence);
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

  private readCreateReplay(operationId: string, argumentsHash: string): CreateConversationResult | null {
    const row = this.storage.database.prepare(`
      SELECT o.kind, o.arguments_hash, o.state, o.terminal_sequence,
             o.value_json, o.project_id, o.conversation_id, o.strand_id,
             p.root_space_id, scs.space_id AS context_space_id
      FROM operations o
      JOIN projects p ON p.project_id = o.project_id
      JOIN strand_context_spaces scs
        ON scs.conversation_id = o.conversation_id AND scs.strand_id = o.strand_id
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
      row.root_space_id,
      row.conversation_id,
      row.context_space_id,
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
      SELECT t.project_id, t.conversation_id, t.strand_id, t.turn_id,
             t.root_scope_id, e.epoch_id
      FROM turns t
      JOIN epochs e ON e.scope_id = t.root_scope_id AND e.ordinal = 0
      WHERE t.terminal_sequence IS NULL
      ORDER BY t.accepted_sequence
    `).all() as Array<{
      project_id: string;
      conversation_id: string;
      strand_id: string;
      turn_id: string;
      root_scope_id: string;
      epoch_id: string;
    }>;
    for (const row of rows) {
      const child = this.storage.database.prepare(`
        SELECT s.scope_id, e.epoch_id
        FROM execution_scopes s
        JOIN epochs e ON e.scope_id = s.scope_id AND e.state = 'open'
        WHERE s.turn_id = ? AND s.kind = 'work_unit' AND s.state = 'running'
        ORDER BY s.created_sequence DESC, e.ordinal DESC LIMIT 1
      `).get(row.turn_id) as { scope_id: string; epoch_id: string } | undefined;
      if (child) {
        await this.finishInference({
          projectId: row.project_id,
          conversationId: row.conversation_id,
          strandId: row.strand_id,
          turnId: row.turn_id,
          scopeId: child.scope_id,
          epochId: child.epoch_id,
        }, { state: 'interrupted' });
        continue;
      }
      await this.enqueueWrite(async () => {
        const assistant = await this.prepareAssistantProjection(row.turn_id);
        return this.finishTurnTransaction({
          projectId: row.project_id,
          conversationId: row.conversation_id,
          strandId: row.strand_id,
          turnId: row.turn_id,
          scopeId: row.root_scope_id,
          epochId: row.epoch_id,
        }, 'interrupted_by_restart', null, null, undefined, assistant);
      });
    }
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
      WHERE turn_id = ? AND type IN ('assistant.checkpoint', 'tool.called')
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
        UPDATE epochs
        SET state = 'closed', closed_sequence = ?, close_reason = ?
        WHERE epoch_id = ? AND closed_sequence IS NULL
      `).run(sequence, status, handle.epochId);
      this.storage.database.prepare(`
        UPDATE execution_scopes
        SET state = ?, terminal_sequence = ?, updated_at = ?
        WHERE scope_id = ? AND terminal_sequence IS NULL
      `).run(status, sequence, recordedAt, handle.scopeId);
      this.storage.database.prepare(`
        UPDATE turns
        SET state = ?, terminal_sequence = ?, updated_at = ?
        WHERE turn_id = ? AND terminal_sequence IS NULL
      `).run(status, sequence, recordedAt, handle.turnId);
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
      JOIN epochs e ON e.scope_id = s.scope_id AND e.epoch_id = ?
      WHERE t.project_id = ? AND t.conversation_id = ? AND t.strand_id = ?
        AND t.turn_id = ? AND s.scope_id = ? AND t.terminal_sequence IS NULL
        AND s.terminal_sequence IS NULL AND e.closed_sequence IS NULL
    `).get(
      handle.epochId,
      handle.projectId,
      handle.conversationId,
      handle.strandId,
      handle.turnId,
      handle.scopeId,
    );
    if (!row) throw new Error(`Durable turn ${handle.turnId} is not running.`);
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
    if (!params.parts) return { artifacts, content, parts: undefined };
    const parts: AgentUserMessagePart[] = [];
    for (const part of params.parts) {
      if (part.type === 'text') {
        parts.push(part);
        continue;
      }
      if (part.type === 'mention') {
        parts.push({
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
      parts.push({
        artifactHash: artifact.hash,
        mimeType: decoded.mimeType,
        name: part.name?.trim() || 'Image',
        sizeBytes: decoded.bytes.byteLength,
        type: 'image',
      });
    }
    return { artifacts: uniqueArtifacts(artifacts), content, parts };
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

  private insertArtifact(artifact: StagedArtifact | null, sequence: number) {
    if (!artifact) return;
    this.storage.database.prepare(`
      INSERT OR IGNORE INTO artifacts (
        hash, byte_length, media_type, created_sequence, storage_path, redaction_state
      ) VALUES (?, ?, ?, ?, ?, 'raw')
    `).run(
      artifact.hash,
      artifact.byteLength,
      artifact.mediaType,
      sequence,
      artifact.storagePath,
    );
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
  }

  private async readTextRef(value: CanonicalJsonValue | undefined) {
    const ref = parseReference(value);
    if (ref.kind === 'inline') return ref.text;
    const bytes = await this.artifacts.read(ref);
    return bytes.toString('utf8');
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
  valueJson: string;
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
  rootSpaceId: string,
  conversationId: string,
  contextSpaceId: string,
): StoredCreateOutcome {
  const parsed = JSON.parse(value) as Partial<StoredCreateOutcome>;
  if (
    parsed.accepted !== true ||
    parsed.operationId !== operationId ||
    parsed.projectId !== projectId ||
    parsed.rootSpaceId !== rootSpaceId ||
    parsed.conversationId !== conversationId
  ) {
    throw new Error(`Operation ${operationId} has an invalid durable outcome.`);
  }
  return { accepted: true, operationId, projectId, rootSpaceId, conversationId, contextSpaceId };
}

function contextInspectorValue(input: {
  manifest: PromptManifest;
  manifestArtifact: StagedArtifact;
  bootstrapArtifact: StagedArtifact;
  dispatchArtifact: StagedArtifact;
  activeMessages: readonly LogicalContextMessage[];
  buildDurationMs: number;
}): ContextInspectorValue {
  const sourceLimit = 16;
  const omissionLimit = 64;
  return {
    version: 2,
    conversationId: input.manifest.conversationId,
    inferenceId: input.manifest.inferenceId,
    epochId: input.manifest.epochId,
    basisSequence: input.manifest.basisSequence,
    projectRevision: input.manifest.projectRevision,
    targetContextSpaceId: input.manifest.targetContextSpaceId,
    compilerVersion: input.manifest.compilerVersion,
    policyVersion: input.manifest.policyVersion,
    decision: input.manifest.candidate.decision,
    activeEstimatedInputTokens: input.manifest.active.estimatedInputTokens,
    candidateEstimatedInputTokens: input.manifest.candidate.estimatedInputTokens,
    semanticHash: input.manifest.candidate.semanticHash,
    bootstrapHash: input.manifest.candidate.bootstrapHash,
    buildDurationMs: safeNonnegativeInteger(input.buildDurationMs, 'shadow build duration'),
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
    actual: activeContextInspectorValue(input.manifest, input.activeMessages, input.dispatchArtifact),
    blocks: input.manifest.candidate.blocks.map((block) => ({
      kind: block.kind,
      hash: block.hash,
      estimatedTokens: block.estimatedTokens,
      sources: block.sources.slice(0, sourceLimit),
      sourceCount: block.sources.length,
      sourcesTruncated: block.sources.length > sourceLimit,
    })),
    omissions: input.manifest.candidate.omissions.slice(0, omissionLimit),
    omissionsTruncated: input.manifest.candidate.omissions.length > omissionLimit,
  };
}

function activeContextInspectorValue(
  manifest: PromptManifest,
  messages: readonly LogicalContextMessage[],
  dispatchArtifact: StagedArtifact,
): NonNullable<ContextInspectorValue['actual']> {
  const groupLimit = 64;
  const groups = new Map<string, NonNullable<ContextInspectorValue['actual']>['groups'][number]>();
  for (const message of messages) {
    const semantic = canonicalJson(logicalMessageSemanticValue(message));
    const existing = groups.get(message.turnId) ?? {
      turnId: message.turnId,
      source: `agent://conversation/${encodeURIComponent(manifest.conversationId)}/turn/${encodeURIComponent(message.turnId)}`,
      messageCount: 0,
      estimatedTokens: 0,
      roles: { user: 0, assistant: 0, tool: 0 },
    };
    existing.messageCount += 1;
    existing.estimatedTokens += Math.max(1, Math.ceil(Buffer.byteLength(semantic, 'utf8') / 4));
    existing.roles[message.role] += 1;
    groups.set(message.turnId, existing);
  }
  const ordered = [...groups.values()];
  return {
    mode: manifest.active.mode,
    frameOrdinal: manifest.active.frameOrdinal,
    transportMode: manifest.transport.requestMode,
    messageCount: manifest.active.messageCount,
    turnCount: ordered.length,
    logicalHash: manifest.active.logicalHash,
    renderedHash: manifest.active.renderedHash,
    fixedContractsHash: manifest.transport.fixedContractsHash,
    dispatchArtifact: {
      hash: dispatchArtifact.hash,
      byteLength: dispatchArtifact.byteLength,
      mediaType: dispatchArtifact.mediaType,
    },
    groups: ordered.slice(-groupLimit),
    groupsTruncated: ordered.length > groupLimit,
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

function canonicalInput(value: unknown, label: string): CanonicalJsonValue {
  try {
    const normalized = normalizeJson(value);
    return JSON.parse(canonicalJson(normalized)) as CanonicalJsonValue;
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalObject(value: CanonicalJsonValue): Record<string, CanonicalJsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, CanonicalJsonValue>
    : {};
}

function contextStorageActions(input: ContextUpdateInput): ContextStorageAction[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('context_update input must be an object.');
  }
  const array = <T>(value: T[] | undefined, label: string) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new TypeError(`context_update ${label} must be an array.`);
    return value;
  };
  const scope = (value: ContextScope | undefined): ContextScope => {
    if (value === undefined) return 'thread';
    if (value !== 'thread' && value !== 'project') {
      throw new TypeError('Context scope must be thread or project.');
    }
    return value;
  };
  const actions: ContextStorageAction[] = [];
  for (const entry of array(input.set, 'set')) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Each context_update set entry must be an object.');
    }
    const evidence = [...new Set(array(entry.evidence, 'set evidence').map(requiredContextResource))];
    if (evidence.length > 16) throw new TypeError('A context state value may cite at most 16 evidence refs.');
    actions.push({
      op: 'set',
      scope: scope(entry.scope),
      key: contextKey(entry.key),
      value: entry.value,
      evidence,
    });
  }
  for (const entry of array(input.remove, 'remove')) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Each context_update remove entry must be an object.');
    }
    actions.push({ op: 'remove', scope: scope(entry.scope), key: contextKey(entry.key) });
  }
  for (const entry of array(input.pin, 'pin')) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Each context_update pin entry must be an object.');
    }
    const label = entry.label?.trim();
    if (label !== undefined && (label.length === 0 || label.length > 160)) {
      throw new TypeError('Pinned resource labels must contain 1-160 characters.');
    }
    actions.push({
      op: 'pin',
      scope: scope(entry.scope),
      ref: requiredContextResource(entry.ref),
      ...(label ? { label } : {}),
    });
  }
  for (const entry of array(input.unpin, 'unpin')) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Each context_update unpin entry must be an object.');
    }
    actions.push({ op: 'unpin', scope: scope(entry.scope), ref: requiredContextResource(entry.ref) });
  }
  if (actions.length === 0 || actions.length > 16) {
    throw new TypeError('context_update must contain between 1 and 16 total changes.');
  }
  return actions;
}

function contextKey(value: string) {
  const key = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(key)) {
    throw new TypeError('Context keys must use 1-96 lowercase letters, digits, dots, underscores, or hyphens.');
  }
  return key;
}

function requiredContextResource(value: string) {
  const resource = value.trim();
  if (!resource || resource.includes('\0') || Buffer.byteLength(resource, 'utf8') > 4_096) {
    throw new TypeError('Working resource must be a non-empty bounded path or reference.');
  }
  return resource;
}

function findWorkingPrimary(state: ProjectState, homeSpaceId: string, resource: string) {
  return [...state.primaries.values()].find((primary) => {
    if (primary.homeSpaceId !== homeSpaceId || primary.kind !== 'working-resource' || primary.lifecycle !== 'active') {
      return false;
    }
    return canonicalObject(primary.descriptor).resource === resource;
  });
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

function parsePorcelainPaths(status: string) {
  const paths = status.split('\0').filter(Boolean).flatMap((entry) => {
    const path = entry.length > 3 ? entry.slice(3) : '';
    const arrow = path.lastIndexOf(' -> ');
    return path ? [arrow >= 0 ? path.slice(arrow + 4) : path] : [];
  });
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function commandText(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return canonicalJson(normalizeJson(value));
  const record = value as Record<string, unknown>;
  const candidate = record.command ?? record.cmd;
  return typeof candidate === 'string'
    ? truncateUtf8Text(candidate, 512)
    : truncateUtf8Text(canonicalJson(normalizeJson(value)), 512);
}

function resultExitCode(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['exitCode', 'exit_code', 'code']) {
    const candidate = record[key];
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return candidate;
  }
  const details = record.details;
  return details && typeof details === 'object' && !Array.isArray(details)
    ? resultExitCode(details)
    : null;
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

function safePositiveInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`Invalid ${label}.`);
  return Number(value);
}

function requiredPrimaryAuthority(value: unknown): ProjectPrimary['authority'] {
  if (value !== 'user' && value !== 'observed' && value !== 'model') {
    throw new Error('Durable primary authority is invalid.');
  }
  return value;
}

function requiredPrimaryLifecycle(value: unknown): ProjectPrimary['lifecycle'] {
  if (value !== 'active' && value !== 'superseded' && value !== 'tombstoned') {
    throw new Error('Durable primary lifecycle is invalid.');
  }
  return value;
}

function requiredBindingMode(value: unknown): ContextBinding['mode'] {
  if (value !== 'inline' && value !== 'index' && value !== 'available' && value !== 'masked') {
    throw new Error('Durable context binding mode is invalid.');
  }
  return value;
}

function requiredEntityType(value: unknown): ProjectRelation['from']['type'] {
  if (value !== 'primary' && value !== 'space') throw new Error('Durable relation entity type is invalid.');
  return value;
}

function requiredStringArray(value: unknown, label: string) {
  if (typeof value !== 'string') throw new Error(`Durable ${label} is invalid.`);
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Durable ${label} is invalid.`);
  }
  return parsed;
}
