import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';

import {
  conversationResourceKey,
  type AgentResourceKey,
  type ConversationListValue,
  type ConversationSummary,
  type ReasoningLevel,
} from '../../../shared/protocol.ts';
import {
  DEFAULT_TRANSCRIPT_TAIL_TURNS,
  MAX_TRANSCRIPT_WINDOW_TURNS,
  MAX_VISIBLE_TEXT_BYTES,
  type AgentTextContentReference,
  type AgentTranscriptResourcesReadParams,
} from '../../../shared/transcript.ts';
import {
  createDurableContextSnapshot,
  reduceLogicalReplay,
  type DurableContextSnapshot,
  type LogicalReplayEvent,
} from '../logical-context.ts';
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

const CREATE_CONVERSATION_KIND = 'conversation.create';
const SEND_MESSAGE_KIND = 'message.send';
const INITIAL_TITLE = 'New conversation';
const EVENT_PAYLOAD_LIMIT_BYTES = 32 * 1024;
const INLINE_CONTENT_LIMIT_BYTES = 16 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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
  | 'inference';

export type AgentJournalRepositoryOptions = AgentDataRootOptions & {
  now?: () => number;
  idFactory?: (kind: IdKind) => string;
};

export type CreateConversationParams = {
  operationId: string;
  cwd: string;
  modelId: string;
  reasoning: ReasoningLevel;
};

export type CreateConversationResult = {
  accepted: true;
  operationId: string;
  projectId: string;
  rootSpaceId: string;
  conversationId: string;
  rootStrandId: string;
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
  key: 'conversation-list' | `conversation:${string}`;
  basisSequence: number;
  value: ConversationListValue | ConversationSummary;
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

type StoredCreateOutcome = {
  accepted: true;
  operationId: string;
  projectId: string;
  rootSpaceId: string;
  conversationId: string;
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
};

type ProjectRow = {
  project_id: string;
  root_space_id: string;
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
      },
    });
    return this.enqueueWrite(() => this.createConversationTransaction(normalized, argumentsHash));
  }

  async acceptTurn(params: AcceptTurnParams): Promise<AcceptTurnResult> {
    this.assertOpen();
    const normalized = validateAcceptTurnParams(params);
    const content = await this.prepareText(normalized.text);
    const argumentsHash = messageArgumentsHash(normalized, content.sha256);
    return this.enqueueWrite(() => this.acceptTurnTransaction(normalized, content, argumentsHash));
  }

  async reconcileTurn(params: AcceptTurnParams): Promise<AcceptTurnResult | null> {
    this.assertOpen();
    const normalized = validateAcceptTurnParams(params);
    const textHash = createHash('sha256').update(normalized.text, 'utf8').digest('hex');
    const argumentsHash = messageArgumentsHash(normalized, textHash);
    await this.writerTail;
    return this.readTurnReplay(normalized, argumentsHash);
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
    return this.enqueueWrite(() => this.storage.transaction(() => {
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
  }

  async startInference(
    handle: DurableTurnHandle,
    input: {
      payload: unknown;
      requestMode: 'full' | 'continuation';
      estimatedInputTokens: number;
      context?: {
        basisSequence: number;
        logicalHash: string;
        renderedHash: string;
        messageCount: number;
      };
    },
  ) {
    this.assertOpen();
    const manifest = await this.prepareJson(input.payload, true);
    if (!manifest.artifact) throw new Error('Inference manifests must be stored as artifacts.');
    const artifact = manifest.artifact;
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
      const inferenceId = this.nextId('inference');
      const recordedAt = safeTimestamp(this.now());
      const basisSequence = this.currentHead(handle);
      if (input.context && input.context.basisSequence !== basisSequence) {
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
          inferenceId,
          inputHash: artifact.hash,
          manifestArtifactHash: artifact.hash,
          contextLogicalHash: input.context?.logicalHash ?? null,
          contextMessageCount: input.context?.messageCount ?? null,
          contextRenderedHash: input.context?.renderedHash ?? null,
          ordinal,
          requestMode: input.requestMode,
        },
        artifactHash: artifact.hash,
        createdAt: recordedAt,
      });
      this.insertArtifact(artifact, sequence);
      this.storage.database.prepare(`
        INSERT INTO inferences (
          inference_id, project_id, conversation_id, strand_id, turn_id,
          scope_id, epoch_id, ordinal, basis_sequence, state, request_mode,
          manifest_artifact_hash, input_hash, estimated_input_tokens,
          reported_input_tokens, reported_output_tokens, started_sequence,
          terminal_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, NULL, NULL, ?, NULL)
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
        artifact.hash,
        artifact.hash,
        input.estimatedInputTokens,
        sequence,
      );
      return { inferenceId, ordinal, sequence };
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
    const userItemsBySequence = new Map<number, string>();
    const assistantItemsByTurn = new Map<string, string>();
    const toolItemsByCall = new Map<string, string>();
    for (const item of itemRows) {
      if (item.kind === 'user') {
        userItemsBySequence.set(item.first_sequence, item.item_id);
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
        actions.push({
          type: 'turn',
          sequence: event.sequence,
          createdAt: event.createdAt,
          itemId: requiredProjectionItemId(
            userItemsBySequence.get(event.sequence),
            'user transcript item',
          ),
          turnId: event.turnId,
          clientMessageId: requiredString(payload.clientMessageId, 'clientMessageId'),
          text: await this.readTextRef(payload.content),
        });
      } else if (event.type === 'assistant.checkpoint') {
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

  async compileContext(conversationId: string): Promise<DurableContextSnapshot> {
    this.assertOpen();
    await this.writerTail;
    const events = await this.readEvents({ conversationId });
    if (events.length === 0) throw new Error(`Conversation ${conversationId} does not exist.`);
    const replay: LogicalReplayEvent[] = [];
    for (const event of events) {
      if (!event.turnId || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
        continue;
      }
      const payload = event.payload as Record<string, CanonicalJsonValue>;
      if (event.type === 'message.user') {
        replay.push({
          type: 'user',
          sequence: event.sequence,
          turnId: event.turnId,
          timestamp: event.createdAt,
          text: await this.readTextRef(payload.content),
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
    return createDurableContextSnapshot(
      events.at(-1)?.sequence ?? 0,
      reduceLogicalReplay(replay),
    );
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
      if (key !== 'conversation-list' && !key.startsWith('conversation:')) return null;
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

  private acceptTurnTransaction(
    params: AcceptTurnParams,
    content: PreparedReference,
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
      const messageSequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        operationId,
        type: 'message.user',
        actor: 'user',
        visibility: 'transcript',
        payload: { clientMessageId: params.clientMessageId, content: content.ref },
        artifactHash: artifactHash(content.ref),
        createdAt: recordedAt,
      });
      this.insertArtifact(content.artifact, messageSequence);
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
          content: content.ref,
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

      const userProjection = preparedTextProjection(content, MAX_VISIBLE_TEXT_BYTES);

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
        SELECT project_id, root_space_id
        FROM projects
        WHERE root_path = ?
      `).get(params.cwd) as ProjectRow | undefined;
      const projectId = existingProject?.project_id ?? this.nextId('project');
      const rootSpaceId = existingProject?.root_space_id ?? this.nextId('space');
      const conversationId = this.nextId('conversation');
      const rootStrandId = this.nextId('strand');
      const recordedAt = safeTimestamp(this.now());
      const outcome: StoredCreateOutcome = {
        accepted: true,
        operationId: params.operationId,
        projectId,
        rootSpaceId,
        conversationId,
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
      this.insertEvent({
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
             p.root_space_id
      FROM operations o
      JOIN projects p ON p.project_id = o.project_id
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
      JOIN execution_scopes s ON s.scope_id = t.root_scope_id
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
  return { accepted: true, operationId, projectId, rootSpaceId, conversationId };
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
  return { ...params };
}

function messageArgumentsHash(params: AcceptTurnParams, textHash: string) {
  return canonicalJsonHash({
    kind: SEND_MESSAGE_KIND,
    params: {
      clientMessageId: params.clientMessageId,
      conversationId: params.conversationId,
      textHash,
    },
  });
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
